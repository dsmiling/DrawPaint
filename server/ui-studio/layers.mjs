import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { zipSync, strToU8 } from "fflate";
import { normalizeOptions, removeBackground } from "./segmentation.mjs";
import { componentMetadata, componentTypes } from "../../shared/ui-schema.mjs";
import { writeComponentImage } from "./component-images.mjs";
import { splitInstructions, connectedStructureInstructions } from "../../shared/split-options.mjs";
import { preservesSource, sourcePixelInstructions } from "./source-pixels.mjs";
import { sheetInstructions } from "./sheets.mjs";
import { validateHdImage } from "./hd-quality.mjs";

export const layerTypes = componentTypes;

export function validateLayers(layers, width, height) {
  if (!Array.isArray(layers) || layers.length < 2 || layers.length > 64) throw new Error("AI 分层须返回 2–64 个独立图层");
  let area = 0;
  return layers.map((layer, i) => {
    const { x, y, w, h } = layer;
    if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w < 1 || h < 1 || x + w > width || y + h > height) throw new Error(`图层 ${i + 1} 超出父组件范围`);
    area += w * h;
    if (area > 16777216) throw new Error("图层总面积不能超过 1600 万像素，请分批细化");
    if (!layerTypes.includes(layer.layerType)) throw new Error(`图层 ${i + 1} 缺少有效分类`);
    if (!Number.isInteger(layer.zIndex) || Math.abs(layer.zIndex) > 10000) throw new Error(`图层 ${i + 1} 缺少有效堆叠顺序`);
    if (layer.background !== undefined && !/^#[\da-f]{6}$/i.test(layer.background)) throw new Error(`图层 ${i + 1} 的抠图底色无效`);
    if (layer.allowOpaque && layer.layerType !== "background") throw new Error("只有完整矩形底图可以声明不透明");
    if (layer.reuse && (typeof layer.reuse !== "object" || !/^[a-f0-9-]{36}$/.test(layer.reuse.jobId || "") || !/^[a-f0-9-]{36}$/.test(layer.reuse.revision || "") || !/^slice-\d+$/.test(layer.reuse.sliceId || ""))) throw new Error(`图层 ${i + 1} 的复用引用无效`);
    if (layer.reuse && (layer.dataUrl || layer.imagePath || layer.background)) throw new Error("复用图层不能同时提供新图片或抠图底色");
    return { ...componentMetadata({ ...layer, semanticSource: "ai" }), id: `slice-${i + 1}`, name: String(layer.name || `layer_${i + 1}`).slice(0, 80),
      layerType: layer.layerType, x, y, w, h, zIndex: layer.zIndex,
      ...(layer.reuse ? { reuse: { jobId: layer.reuse.jobId, revision: layer.reuse.revision, sliceId: layer.reuse.sliceId } } : {}),
      ...(layer.background ? { background: layer.background } : {}), ...(layer.allowOpaque ? { allowOpaque: true } : {}),
      text: layer.layerType === "text" ? String(layer.text || "").slice(0, 2000) : undefined };
  });
}

export function buildLayerPrompt(job) {
  if(preservesSource(job)) return [sourcePixelInstructions,
    `Decompose the original UI into 2–64 independent semantic layers. Source canvas ${job.width} × ${job.height}, origin top-left. User request: ${job.prompt}`,
    job.approvedRegions ? `Follow exactly these approved regions, including regionId, name, layerType, x/y/w/h and zIndex: ${JSON.stringify(job.approvedRegions)}` : "Identify meaningful original elements; keep complete words together; do not invent components or return duplicate composite crops.",
    "Inspect reusableComponents for exact original artwork matches before making new layers. Return reuse:{jobId,revision,sliceId} only for such matches. Otherwise use sourcePixels. Preserve transparent margins and original positions.",
    splitInstructions(job.splitOptions),
    'Return {layers:[{name,layerType,x,y,w,h,zIndex,regionId?,text?,sourcePixels:{alphaPath,repairMaskPath?,repairImagePath?}}]}. layerType: component|button|texture|background|icon|text|border|decoration. Matching reused layers replace sourcePixels with reuse. Submit via complete-layers.',
  ].join("\n\n");
  if(job.splitOptions?.generationMode === "sheet") return [sheetInstructions,
    `Decompose this original UI into 2–64 independent semantic layers. Layout canvas ${job.width} × ${job.height}; user request: ${job.prompt}`,
    job.approvedRegions ? `Follow these approved regions exactly, preserving id as regionId, name, layerType, x/y/w/h and zIndex: ${JSON.stringify(job.approvedRegions)}` : "Identify meaningful components. Keep layout positions and full original frame proportions.",
    splitInstructions(job.splitOptions),
    'Return {sheets:[{imagePath,background?}],layers:[{name,layerType,x,y,w,h,zIndex,regionId?,text?,sheetIndex,sheetRect:{x,y,w,h}}]}. Reused rows replace sheetIndex/sheetRect with reuse. Submit via complete-layers.',
  ].join("\n\n");
  return [
    "Analyze the supplied UI component and decompose it into independent semantic raster layers, like a PSD layer stack.",
    `Parent canvas: ${job.width} × ${job.height} pixels. All rectangles use this parent coordinate system, origin at top left.`,
    `User request: ${job.prompt}`,
    ...(job.approvedRegions ? [
      `Approved decomposition plan: ${JSON.stringify(job.approvedRegions)}`,
      "Generate exactly one independent image per approved region, preserving its id as regionId in the returned layer manifest, and its name, layerType, x/y/w/h and zIndex. Follow group and notes. The background must be clean with all separately planned foreground content removed and the covered pixels reconstructed. Do not return a composite screenshot as the background. Do not silently add, merge, omit or reposition approved regions.",
    ] : []),
    "Before generating any images, inspect reusableComponents supplied with this request. Open plausible imagePath candidates and compare against the source. Reuse an existing layer when artwork, colors, text and state match; similar names or silhouettes alone are insufficient. Generate only missing layers. Preserve distinct text, colors and button states. Do not reuse a whole parent component as one of its own separated layers.",
    'For a matching existing component, return reuse:{jobId,revision,sliceId} from its catalog entry instead of imagePath/background. Keep name, layerType, x,y,w,h,zIndex and text metadata for the new placement. The server loads the existing PNG; no image_gen call is needed for that layer. Avoid changing aspect ratio by more than 2%. Reused and newly generated layers may be mixed, including an entirely reused layer stack.',
    "Separate the clean background/base plate, ICON artwork, text and complete decorated border/frame where present. Keep attached frame ornaments within the same border layer unless explicitly requested otherwise. Do not invent missing categories. Keep complete words/text lines together, not individual letters. Separate nested UI components when useful.",
    connectedStructureInstructions,
    "Inspect the source first. Use image_gen to isolate/reconstruct each layer. Preserve style, exact text, proportions, placement and colors. Reconstruct occluded base pixels. Never return copies of the whole component under different layer names. Do not use bounding-box crops as a substitute for separating overlapping content.",
    "Output one PNG per semantic layer. For reliable extraction, generate each isolated layer against perfectly uniform #ff00ff magenta (or #00ff00 if the artwork contains magenta) and set its manifest background to that hex color. The server will remove this declared key color from the exterior and hollow interiors, trim empty margins, validate real transparency, and export RGBA PNG. Keep 4% empty gutters around artwork. Never draw a checkerboard. If the image already has genuine alpha transparency, omit background. Do not claim that a checkerboard RGB image is transparent. Only a deliberately full rectangular background may use allowOpaque:true.",
    "No contact sheets, labels or surrounding source UI. Order layers from base to foreground with ascending zIndex. Borders must have empty interiors in the declared key color; icons/text must not retain their base plate. Inspect generated images and their alpha metadata before submitting. Do not stop merely because a uniform-key image lacks alpha: submit with background for server matting. Reject checkerboards, gradients or texture on the backdrop.",
    "Return a JSON manifest with a layers array (2–64 entries). Each entry: name, layerType (button|texture|background|icon|text|border|decoration|component), imagePath (absolute local PNG path), x, y, w, h (tight artwork bounds in parent pixels), zIndex (integer), optional text, fontFamily, fontSize, textColor, textAlign, textRender (image|editable), background, allowOpaque. Leave unknown fontFamily empty; do not invent font identity. Transparent margins are trimmed before fitting to the declared bounds; artwork aspect ratios differing by more than 25% are rejected to prevent distortion. Keep total layer area under 16 million pixels.",
    "If the component cannot meaningfully be separated further, fail the task with a clear explanation rather than inventing layers. This is AI reconstruction, not recovery of original PSD source data.",
    splitInstructions(job.splitOptions),
    "The server preserves native PNG pixels and fits the final layout to the actual image aspect ratio, centered within the planned bounds. Never stretch or clip artwork to fill those bounds. Keep the full silhouette and intentional transparent margins.",
  ].join("\n\n");
}

export async function prepareLayerImage(image, layer, options = {}) {
  const decoded = await sharp(image, { limitInputPixels: 16777216 }).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = decoded.info;
  let data = decoded.data;
  if (layer.background) {
    const bg = [1, 3, 5].map(i => parseInt(layer.background.slice(i, i + 2), 16));
    let matches = 0, count = 0;
    const sample = (x, y) => { count++; const p = (y * width + x) * 4; if (data[p + 3] < 8 || bg.every((c, i) => Math.abs(data[p + i] - c) <= 32)) matches++; };
    for (let x = 0; x < width; x++) { sample(x, 0); sample(x, height - 1); }
    for (let y = 0; y < height; y++) { sample(0, y); sample(width - 1, y); }
    if (matches / count < .9) {
      if(!options.candidateMode) throw new Error(`图层“${layer.name}”底色不是声明的均匀纯色；棋盘格或复杂背景不能自动抠图`);
      options.warnings.push("背景不是均匀纯色，保留生成原图；需要重做透明背景。");
    } else data = removeBackground(data, width, height, normalizeOptions({ background: layer.background, removalMode: "color", tolerance: 24, feather: 8 })).data;
  }
  let x0 = width, y0 = height, x1 = -1, y1 = -1, transparent = 0;
  const visibleThreshold = 1;
  for (let p = 0; p < width * height; p++) {
    if (data[p * 4 + 3] < visibleThreshold) { transparent++; continue; }
    const x = p % width, y = Math.floor(p / width);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  if (x1 < x0 || y1 < y0) throw new Error(`图层“${layer.name}”没有可见像素`);
  if (!layer.allowOpaque && transparent < Math.max(1, width * height * .005)) {
    if(!options.candidateMode) throw new Error(`图层“${layer.name}”缺少真实透明区域。请返回带 alpha 的 PNG，或纯色底图片并声明 background`);
    options.warnings.push("缺少真实透明区域，当前图层可能遮挡其他元素，建议重做。");
  }
  if (options.preserveFrame) { x0 = 0; y0 = 0; x1 = width - 1; y1 = height - 1; }
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const ratio = (w / h) / (layer.w / layer.h);
  const tolerance = options.preserveResolution ? .08 : .25;
  const mismatch=ratio < 1-tolerance || ratio > 1+tolerance;
  if (mismatch && !options.candidateMode) throw new Error(`图层“${layer.name}”内容宽高比与坐标不匹配，已阻止拉伸；请校正范围或重新生成`);
  const pipeline = sharp(Buffer.from(data), { raw: { width, height, channels: 4 } }).extract({ left: x0, top: y0, width: w, height: h });
  if(mismatch) {
    options.warnings.push("生成内容比例偏离计划范围；布局将按素材比例居中适配，请检查位置或选择重做。");
  }
  return pipeline.png().toBuffer();
}

// Keep the planned placement as an envelope; fit the complete native PNG inside it.
// Integer layout coordinates are required by preset exports, so round only here.
export function fitLayerLayout(layer, imageWidth, imageHeight) {
  if (layer.candidateRetained || layer.preservation?.mode === "source-pixels") return layer;
  const frame = layer.plannedRect || { x: layer.x, y: layer.y, w: layer.w, h: layer.h };
  const scale = Math.min(frame.w / imageWidth, frame.h / imageHeight);
  const w = Math.max(1, Math.round(imageWidth * scale)), h = Math.max(1, Math.round(imageHeight * scale));
  return { ...layer, plannedRect: frame, x: frame.x + Math.floor((frame.w - w) / 2),
    y: frame.y + Math.floor((frame.h - h) / 2), w, h };
}

export async function writeLayers(directory, job, layers, images, revision, componentCache = path.join(directory, "component-images"), options = {}) {
  // Validate the whole set before producing any published layer assets.
  const prepared = [];
  const highResolution = job.splitOptions?.resolutionMode === "hd";
  for (const [i, layer] of layers.entries()) prepared.push(options.prepared || layer.candidateRetained || layer.preservation?.mode === "source-pixels" ? images[i] : layer.reuse
    ? images[i]
    : await prepareLayerImage(images[i], layer, {preserveResolution:job.reviewBeforePublish || highResolution || Boolean(layer.sheetCrop),preserveFrame:Boolean(layer.sheetCrop),candidateMode:job.reviewBeforePublish,warnings:(layer.warnings ||= [])}));
  for (const [i, image] of prepared.entries()) await validateHdImage(job, layers[i], image);
  const output = path.join(directory, revision);
  await fs.mkdir(output, { recursive: true });
  const files = {}, slices = [], overlays = [];
  let reusedImages = 0, reusedLayers = 0;
  for (const [i, layer] of layers.entries()) {
    const png = prepared[i];
    const { file, contentHash, reused, png: stored } = await writeComponentImage(output, componentCache, png);
    if (reused) reusedImages++;
    if (layer.reuse) reusedLayers++;
    files[`layers/${file}`] = new Uint8Array(stored);
    const {width: imageWidth, height: imageHeight} = await sharp(stored).metadata();
    const layout = fitLayerLayout(layer, imageWidth, imageHeight);
    slices.push({ ...layout, imageWidth, imageHeight, contentHash, file: `${revision}/${file}` });
    overlays.push({ input: await sharp(png).resize(layout.w, layout.h, {fit:"contain", background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer(), left: layout.x, top: layout.y, zIndex: layer.zIndex });
  }
  overlays.sort((a, b) => a.zIndex - b.zIndex);
  const atlas = await sharp({ create: { width: job.width, height: job.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(overlays.map(({ zIndex, ...overlay }) => overlay)).png().toBuffer();
  await fs.writeFile(path.join(output, "atlas.png"), atlas);
  const manifest = { schema: "drawpaint.ui-layers.v1", width: job.width, height: job.height,
    origin: "top-left", units: "pixels", parent: job.parent, reconstruction: preservesSource(job) ? "source-preserved" : job.maskPurpose === "reference" ? "mask-guided-ai" : job.method === "hybrid" ? "source-mask-local-repair" : "ai", textFormat: "raster",
    ...(job.maskPurpose === "reference" ? {maskPurpose:"reference", resolutionNote:"x/y/w/h describe layout; imageWidth/imageHeight describe the full-resolution PNG. Masks are input guides, never output alpha."} : {}),
    layers: slices.map(s => ({ ...s, file: `layers/${path.basename(s.file)}`,
      ...(s.maskFile ? { maskFile: `masks/${s.regionId}.png`, repairMaskFile: `masks/${s.regionId}-repair.png` } : {}),
      ...Object.fromEntries(["referenceFile","guideFile","exclusionFile"].filter(k=>s[k]).map(k=>[k,`references/${path.basename(s[k])}`])) })) };
  if (job.method === "hybrid") for (const layer of slices) {
    files[`masks/${layer.regionId}.png`] = new Uint8Array(await fs.readFile(path.join(directory, layer.maskFile)));
    files[`masks/${layer.regionId}-repair.png`] = new Uint8Array(await fs.readFile(path.join(directory, layer.repairMaskFile)));
    for (const key of ["referenceFile","guideFile","exclusionFile"]) if(layer[key]) files[`references/${path.basename(layer[key])}`] = new Uint8Array(await fs.readFile(path.join(directory,layer[key])));
  }
  if(job.maskPurpose === "reference") {
    manifest.referenceImage="references/original.png";
    manifest.referenceGuide="references/numbered-guide.png";
    files[manifest.referenceImage]=new Uint8Array(await fs.readFile(path.join(directory,job.sourceFile)));
    files[manifest.referenceGuide]=new Uint8Array(await fs.readFile(path.join(directory,job.hybridDraft.guideFile)));
  }
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  files["preview.png"] = new Uint8Array(atlas);
  await fs.writeFile(path.join(output, "manifest.json"), files["manifest.json"]);
  await fs.writeFile(path.join(output, "ui-assets.zip"), zipSync(files, { level: 0 }));
  return { slices, revision, reusedImages, reusedLayers, atlasFile: `${revision}/atlas.png`, manifestFile: `${revision}/manifest.json`, exportFile: `${revision}/ui-assets.zip` };
}
