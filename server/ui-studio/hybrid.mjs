import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { unzipSync, zipSync, strToU8 } from "fflate";
import { runVision } from "./vision-runtime.mjs";
import { writeLayers } from "./layers.mjs";
import { addReferenceGuides, referenceLayerPrompt, finishReferenceLayers } from "./reference-layers.mjs";

const raw = async image => sharp(image, { limitInputPixels: 16777216 }).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const png = (data, w, h) => sharp(Buffer.from(data), { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
async function readMask(filename, w, h) {
  const { data, info } = await sharp(filename, { limitInputPixels: 16777216 }).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== w || info.height !== h) throw new Error("掩膜尺寸必须与组件完全一致，不能缩放");
  return data;
}
async function writeMask(filename, data, w, h) {
  await sharp(Buffer.from(data), { raw: { width: w, height: h, channels: 1 } }).png().toFile(filename);
}

// The browser supplies bounded brush strokes, never arbitrary local paths.
export function paintMask(input, width, height, strokes = []) {
  if (!Array.isArray(strokes) || strokes.length > 500) throw new Error("画笔笔划过多，请分批保存");
  const result = Buffer.from(input);
  let total = 0;
  for (const stroke of strokes) {
    if (!["keep", "erase"].includes(stroke.mode) || !Number.isInteger(stroke.radius) || stroke.radius < 1 || stroke.radius > 100 ||
      !Array.isArray(stroke.points) || !stroke.points.length || (total += stroke.points.length) > 10000 || stroke.points.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isInteger) || p[0] < 0 || p[1] < 0 || p[0] >= width || p[1] >= height)) throw new Error("画笔参数或坐标无效");
    const stamp = (x, y) => {
      for (let yy = Math.max(0, y-stroke.radius); yy <= Math.min(height-1, y+stroke.radius); yy++)
        for (let xx = Math.max(0, x-stroke.radius); xx <= Math.min(width-1, x+stroke.radius); xx++)
          if ((xx-x)**2 + (yy-y)**2 <= stroke.radius**2) result[yy*width+xx] = stroke.mode === "keep" ? 255 : 0;
    };
    let previous = stroke.points[0]; stamp(...previous);
    for (const point of stroke.points.slice(1)) {
      const steps = Math.max(Math.abs(point[0]-previous[0]), Math.abs(point[1]-previous[1]), 1);
      for (let t = 1; t <= steps; t++) stamp(Math.round(previous[0]+(point[0]-previous[0])*t/steps), Math.round(previous[1]+(point[1]-previous[1])*t/steps));
      previous = point;
    }
  }
  return result;
}

function crop(data, width, region) {
  const output = Buffer.alloc(region.w * region.h * 4);
  for (let y = 0; y < region.h; y++) data.copy(output, y*region.w*4, ((region.y+y)*width+region.x)*4, ((region.y+y)*width+region.x+region.w)*4);
  return output;
}

export function expandRepairMask(mask, width, height, padding = 0) {
  if (!Number.isInteger(padding) || padding < 0 || padding > 8) throw new Error("修补扩边须为 0–8 像素");
  const horizontal = Buffer.from(mask), output = Buffer.from(mask);
  if (!padding) return output;
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
    let value=0;
    for(let xx=Math.max(0,x-padding);xx<=Math.min(width-1,x+padding);xx++) value=Math.max(value,mask[y*width+xx]);
    horizontal[y*width+x]=value;
  }
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
    let value=0;
    for(let yy=Math.max(0,y-padding);yy<=Math.min(height-1,y+padding);yy++) value=Math.max(value,horizontal[yy*width+x]);
    output[y*width+x]=value;
  }
  return output;
}

// Repair is composited here, not entrusted to a model prompt. Known pixels are
// byte-identical, and generated pixels outside the approved mask are discarded.
export function compositeRepair(original, generated, mask) {
  if (original.length !== generated.length || original.length !== mask.length*4) throw new Error("修补结果必须保持原始尺寸");
  const result = Buffer.from(original);
  for (let p = 0; p < mask.length; p++) if (mask[p]) {
    const weight = mask[p]/255;
    for (let c = 0; c < 3; c++) result[p*4+c] = Math.round(original[p*4+c]*(1-weight)+generated[p*4+c]*weight);
    // Source silhouette/alpha remains authoritative, even when the model returns RGB.
  }
  return result;
}

// Only generated repair pixels may be mapped. The immutable source and masks
// never resize. An explicit rectangle records the Agent's visual alignment.
export async function mapRepairImage(image, entry, generatedRect) {
  const decoded = await raw(image);
  if (!generatedRect) {
    if (decoded.info.width !== entry.w || decoded.info.height !== entry.h) throw new Error(`“${entry.name}”修补尺寸不一致，请返回 ${entry.w} × ${entry.h}，或明确提供 generatedRect 对齐范围`);
    return decoded;
  }
  const { x, y, w, h } = generatedRect;
  if (![x,y,w,h].every(Number.isInteger) || x < 0 || y < 0 || w < 1 || h < 1 || x+w > decoded.info.width || y+h > decoded.info.height) throw new Error("修补映射范围无效或超出生成图片");
  const mapped = await sharp(image).extract({left:x,top:y,width:w,height:h}).resize(entry.w,entry.h,{fit:"fill"}).png().toBuffer();
  return { ...await raw(mapped), mapping: { generatedWidth: decoded.info.width, generatedHeight: decoded.info.height, generatedRect: {x,y,w,h}, targetWidth: entry.w, targetHeight: entry.h } };
}

export async function prepareHybridDraft(directory, job, segmented, previous, edits = []) {
  const regions = job.approvedRegions;
  if (!Array.isArray(edits) || edits.length > regions.length || new Set(edits.map(e => e.regionId)).size !== edits.length || edits.some(e => !regions.some(r => r.id === e.regionId))) throw new Error("掩膜校正组件无效");
  const source = await raw(path.join(directory, job.sourceFile));
  const version = randomUUID(), folder = `masks-${version}`, output = path.join(directory, folder);
  await fs.mkdir(output, { recursive: true });
  const masks = new Map(), exclusions = new Map();
  const layers = [];
  for (const region of regions) {
    const entry = previous?.layers.find(l => l.regionId === region.id) || segmented.masks.find(m => m.regionId === region.id);
    if (!entry) throw new Error("缺少分割结果");
    const file = previous ? entry.maskFile : `segments/${entry.maskFile}`;
    const strokes = edits.find(e => e.regionId === region.id)?.strokes;
    const mask = paintMask(await readMask(path.join(directory, file), region.w, region.h), region.w, region.h, strokes);
    const excluded = paintMask(entry.exclusionFile ? await readMask(path.join(directory, entry.exclusionFile), region.w, region.h) : Buffer.alloc(region.w*region.h), region.w, region.h,
      strokes?.map(s=>({...s,mode:s.mode === "erase" ? "keep" : "erase"})));
    masks.set(region.id, mask);
    exclusions.set(region.id, excluded);
    await writeMask(path.join(output, `${region.id}-mask.png`), mask, region.w, region.h);
    await writeMask(path.join(output, `${region.id}-excluded.png`), excluded, region.w, region.h);
  }
  const isDescendant = (child, parentId) => {
    let current = child;
    while (current.parentId) { if (current.parentId === parentId) return true; current = regions.find(r => r.id === current.parentId); }
    return false;
  };
  for (const region of regions) {
    const own = masks.get(region.id), support = Buffer.from(own);
    let repair = Buffer.alloc(own.length);
    const warnings = [...(segmented?.masks.find(m => m.regionId === region.id)?.warnings || previous?.layers.find(l => l.regionId === region.id)?.warnings || [])];
    // Parent masks may exclude an occluding child. Restore only that declared
    // descendant's support inside this parent's bounds, never the entire bbox.
    for (const child of regions.filter(r => isDescendant(r, region.id))) {
      const mask = masks.get(child.id);
      for (let y = Math.max(region.y, child.y); y < Math.min(region.y+region.h, child.y+child.h); y++)
        for (let x = Math.max(region.x, child.x); x < Math.min(region.x+region.w, child.x+child.w); x++) {
          const value = mask[(y-child.y)*child.w+x-child.x];
          if (!value) continue;
          const p = (y-region.y)*region.w+x-region.x;
          support[p] = Math.max(support[p], value); repair[p] = Math.max(repair[p], value);
        }
    }
    repair = expandRepairMask(repair, region.w, region.h, region.repairPadding || 0);
    // A user's erased parent outline is authoritative, including under children.
    // Descendant support must not silently bring that silhouette back.
    const excluded = exclusions.get(region.id);
    for(let p=0;p<support.length;p++) if(excluded[p]) { support[p]=0; repair[p]=0; }
    const pixels = crop(source.data, source.info.width, region);
    let visible = 0, fractional = 0, repaired = 0;
    for (let p = 0; p < support.length; p++) {
      pixels[p*4+3] = Math.round(pixels[p*4+3]*support[p]/255);
      if (pixels[p*4+3]) visible++;
      if (pixels[p*4+3] > 0 && pixels[p*4+3] < 255) fractional++;
      if (repair[p] && pixels[p*4+3]) repaired++; else repair[p] = 0;
    }
    if (!visible) warnings.push("图层没有可见像素，确认前必须修正");
    if (fractional > visible*.1) warnings.push("半透明边缘较多，请在深浅背景上检查残边");
    if (repaired && region.repairMode === "none") warnings.push("父层存在遮挡但未选择修补；确认时会阻止保留重复前景");
    if (repaired > support.length*.85) warnings.push("大部分区域需要重建，请重点检查修补内容");
    const imageFile = `${folder}/${region.id}-source.png`, repairMaskFile = `${folder}/${region.id}-repair.png`;
    await fs.writeFile(path.join(directory, imageFile), await png(pixels, region.w, region.h));
    await writeMask(path.join(directory, repairMaskFile), repair, region.w, region.h);
    const diagnostic = Buffer.from(pixels);
    for (let p = 0; p < repair.length; p++) if (repair[p]) diagnostic.fill(0, p*4, p*4+3);
    const repairInputFile = `${folder}/${region.id}-input.png`;
    await fs.writeFile(path.join(directory, repairInputFile), await png(diagnostic, region.w, region.h));
    layers.push({ ...region, regionId: region.id, maskFile: `${folder}/${region.id}-mask.png`, exclusionFile: `${folder}/${region.id}-excluded.png`, imageFile, repairMaskFile, repairInputFile,
      visiblePixels: visible, repairPixels: repaired, warnings: [...new Set(warnings)],
      score: segmented?.masks.find(m => m.regionId === region.id)?.score ?? previous?.layers.find(l => l.regionId === region.id)?.score ?? null });
  }
  const draft = { version, folder, layers, model: segmented?.model || previous?.model, device: segmented?.device || previous?.device };
  return job.maskPurpose === "reference" ? addReferenceGuides(directory, job, draft) : draft;
}

async function finishLegacyHybrid(service, job, repairs = [], signal) {
  const directory = service.directory(job.id), draft = job.hybridDraft;
  const imageLayers = draft.layers.filter(l => l.repairPixels && l.repairMode === "image");
  if (!Array.isArray(repairs) || repairs.length !== imageLayers.length || new Set(repairs.map(r => r.regionId)).size !== repairs.length || repairs.some(r => !imageLayers.some(l => l.regionId === r.regionId))) throw new Error("请为每个待修补图层返回一次结果");
  const prepared = [], layers = [];
  for (const entry of draft.layers) {
    if (signal?.aborted) throw new Error("任务已取消");
    if (!entry.visiblePixels) throw new Error(`“${entry.name}”没有可见像素，请校正掩膜`);
    if (entry.repairPixels && entry.repairMode === "none") throw new Error(`“${entry.name}”存在遮挡，请选择纯色或 AI 局部修补`);
    const original = await raw(path.join(directory, entry.imageFile));
    const mask = await readMask(path.join(directory, entry.repairMaskFile), entry.w, entry.h);
    let data = original.data, repairMapping;
    if (entry.repairPixels) {
      let generated;
      if (entry.repairMode === "surface") {
        const file = path.join(directory, draft.folder, `${entry.regionId}-surface.png`);
        await runVision("repair", { source: path.join(directory, entry.imageFile), mask: path.join(directory, entry.repairMaskFile), output: file }, signal);
        generated = await raw(file);
      } else {
        const repair = repairs.find(r => r.regionId === entry.regionId);
        generated = await mapRepairImage(await service.upload(repair.dataUrl), entry, repair.generatedRect);
        repairMapping = generated.mapping;
      }
      if (generated.info.width !== entry.w || generated.info.height !== entry.h) throw new Error(`“${entry.name}”修补尺寸不一致，请返回 ${entry.w} × ${entry.h}，不会自动拉伸`);
      if (entry.repairMode === "image") for (let p = 0; p < mask.length; p++) if (mask[p] && generated.data[p*4+3] < 250) throw new Error(`“${entry.name}”修补区域缺少完整像素`);
      data = compositeRepair(data, generated.data, mask);
    }
    prepared.push(await png(data, entry.w, entry.h));
    const { maskFile, exclusionFile, imageFile, repairMaskFile, repairInputFile, visiblePixels, repairPixels, warnings, score, ...metadata } = entry;
    layers.push({ ...metadata, ...(repairMapping ? {repairMapping} : {}), semanticSource: metadata.semanticSource === "manual" ? "manual" : "ai", id: `slice-${layers.length+1}`, extraction: "source-mask", repairPixels, warnings, maskFile, repairMaskFile });
  }
  return writeLayers(directory, job, layers, prepared, randomUUID(), path.join(service.root, "component-images"), { prepared: true });
}

export async function finishHybrid(service, job, repairs = [], signal) {
  const directory = service.directory(job.id), draft = job.hybridDraft;
  const result = await (job.maskPurpose === "reference" ? finishReferenceLayers : finishLegacyHybrid)(service,job,repairs,signal);
  // A visual difference map is evidence for review, not an accuracy percentage.
  const source = await raw(path.join(directory, job.sourceFile)), composite = await raw(path.join(directory, result.atlasFile));
  const diff = Buffer.alloc(source.data.length), total = source.info.width*source.info.height;
  let changed = 0, maxDelta = 0;
  for (let p = 0; p < total; p++) {
    const a = source.data[p*4+3]/255, b = composite.data[p*4+3]/255;
    let delta = Math.abs(source.data[p*4+3]-composite.data[p*4+3]);
    for (let c = 0; c < 3; c++) delta = Math.max(delta, Math.abs(source.data[p*4+c]*a-composite.data[p*4+c]*b));
    if (delta > 8) changed++;
    maxDelta = Math.max(maxDelta, delta);
    diff[p*4] = Math.min(255, Math.round(delta*4)); diff[p*4+1] = Math.round(delta); diff[p*4+3] = 255;
  }
  const differenceFile = `${result.revision}/difference.png`;
  await fs.writeFile(path.join(directory, differenceFile), await png(diff, source.info.width, source.info.height));
  const quality = { changedPixels: changed, totalPixels: total, changedFraction: changed/total, maxDelta: Math.round(maxDelta), threshold: 8,
    note: "原图与回拼图的预乘 RGBA 差异，包含预期重建和叠加变化；不是分割准确率。", differenceFile,
    maskPurpose: job.maskPurpose || "cutout", requiresVisualReview:true,
    reviewCriteria:["元素与文字内容正确", "比例和位置符合原构图", "轮廓完整、细线和镂空保留", "深浅背景下边缘自然", "底层无前景残留", "素材分辨率与清晰度"],
    warnings: result.slices.flatMap(l => l.warnings.map(w => `${l.name}：${w}`)) };
  await fs.writeFile(path.join(directory, result.revision, "quality.json"), JSON.stringify(quality, null, 2));
  const packed = unzipSync(await fs.readFile(path.join(directory, result.exportFile)));
  packed["quality.json"] = strToU8(JSON.stringify({ ...quality, differenceFile: "difference.png" }, null, 2));
  packed["difference.png"] = new Uint8Array(await fs.readFile(path.join(directory, differenceFile)));
  await fs.writeFile(path.join(directory, result.exportFile), zipSync(packed, { level: 0 }));
  return { ...result, quality };
}

export function hybridRepairPrompt(job, directory) {
  if (job.maskPurpose === "reference") return referenceLayerPrompt(job,directory);
  const requests = job.hybridDraft.layers.filter(l => l.repairPixels && l.repairMode === "image").map(l => ({
    regionId: l.regionId, name: l.name, width: l.w, height: l.h,
    imagePath: path.join(directory, l.repairInputFile), maskPath: path.join(directory, l.repairMaskFile), notes: l.notes,
  }));
  return { repairRequests: requests, generationPrompt: [
    "Repair only the WHITE region of each supplied grayscale mask, using the matching image as reference. Black mask pixels are protected. Image black holes are missing material, not content to preserve. Continue the immediately surrounding material of the SAME element. Do not reintroduce removed text, icons, buttons or decorations. Preserve placement and proportions, and exact dimensions when supported. One PNG per requested regionId; no contact sheets. Use the image generation/editing tool for textured repair, never redraw entire independent layers. The server will discard every generated pixel outside the approved repair mask and preserve original alpha.",
    JSON.stringify(requests),
    'Return {repairs:[{regionId,imagePath,generatedRect?}]} with absolute PNG paths. Prefer exact dimensions. If the image tool changes resolution or adds margins, inspect its output and explicitly provide generatedRect:{x,y,w,h} in GENERATED image pixels for the rectangle corresponding to the FULL requested layer. Only that generated rectangle is resampled into the repair mask; source geometry and protected pixels never change. Never guess alignment or include exterior checkerboards in material. If alignment is uncertain, report failure. The user must inspect individual repaired layers and approve the preview before publication. Once status is review_repairs your work is complete; do not approve on the user\'s behalf.',
  ].join("\n\n") };
}
