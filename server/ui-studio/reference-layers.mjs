import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { prepareLayerImage, writeLayers } from "./layers.mjs";
import { splitInstructions } from "../../shared/split-options.mjs";
import { preservesSource, sourcePixelInstructions, sourcePixelLayer } from "./source-pixels.mjs";
import { sheetInstructions } from "./sheets.mjs";

const colours = [[58,210,166],[255,190,69],[110,156,255],[239,121,188],[174,145,255]];
const encode = (data,width,height) => sharp(data,{raw:{width,height,channels:4}}).png().toBuffer();

// These overlays annotate the original. They never clip the generation input.
export async function addReferenceGuides(directory, job, draft) {
  const source = await sharp(path.join(directory,job.sourceFile)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const overview = Buffer.from(source.data);
  for (const [index,layer] of draft.layers.entries()) {
    const mask = await sharp(path.join(directory,layer.maskFile)).greyscale().removeAlpha().raw().toBuffer();
    const excluded = await sharp(path.join(directory,layer.exclusionFile)).greyscale().removeAlpha().raw().toBuffer();
    const crop = Buffer.alloc(layer.w*layer.h*4), colour = colours[index%colours.length];
    for(let y=0;y<layer.h;y++) for(let x=0;x<layer.w;x++) {
      const p=y*layer.w+x, q=(y+layer.y)*source.info.width+x+layer.x;
      source.data.copy(crop,p*4,q*4,q*4+4);
      if(mask[p]) for(let c=0;c<3;c++) overview[q*4+c]=Math.round(overview[q*4+c]*.65+colour[c]*.35);
    }
    layer.referenceFile = `${draft.folder}/${layer.regionId}-reference.png`;
    await fs.writeFile(path.join(directory,layer.referenceFile),await encode(crop,layer.w,layer.h));
    for(let p=0;p<mask.length;p++) {
      const tint=excluded[p]?[255,65,65]:colour, weight=excluded[p] ? .6 : mask[p]/255*.4;
      for(let c=0;c<3;c++) crop[p*4+c]=Math.round(crop[p*4+c]*(1-weight)+tint[c]*weight);
    }
    layer.guideFile = `${draft.folder}/${layer.regionId}-guide.png`;
    await fs.writeFile(path.join(directory,layer.guideFile),await encode(crop,layer.w,layer.h));
    layer.referenceIndex=index+1;
    layer.warnings = layer.warnings.filter(w=>!w.includes("没有可见像素")&&!w.includes("未选择修补"));
    if (!layer.visiblePixels) layer.warnings.push("边界参考为空，AI 将结合原图、范围和文字说明识别元素。");
  }
  const font=Math.max(9,Math.min(24,Math.round(job.width/30)));
  const labels=draft.layers.map((l,i)=>`<g><rect x="${l.x}" y="${l.y}" width="${font*2}" height="${font*1.5}" fill="#17212e"/><text x="${l.x+2}" y="${l.y+font}" fill="white" font-size="${font}" font-family="sans-serif">${i+1}</text></g>`).join("");
  draft.guideFile=`${draft.folder}/numbered-guide.png`;
  await fs.writeFile(path.join(directory,draft.guideFile),await sharp(await encode(overview,job.width,job.height)).composite([{input:Buffer.from(`<svg width="${job.width}" height="${job.height}" xmlns="http://www.w3.org/2000/svg">${labels}</svg>`)}]).png().toBuffer());
  draft.maskPurpose="reference";
  return draft;
}

export function referenceLayerPrompt(job,directory) {
  const requests=job.hybridDraft.layers.map(l=>({
    regionId:l.regionId,referenceIndex:l.referenceIndex,name:l.name,layerType:l.layerType,
    x:l.x,y:l.y,width:l.w,height:l.h,zIndex:l.zIndex,parentId:l.parentId,
    text:l.text,notes:l.notes,instructions:l.reconstructionNotes||"",
    imagePath:path.join(directory,l.referenceFile),guidePath:path.join(directory,l.guideFile),
    maskPath:path.join(directory,l.maskFile),excludedMaskPath:path.join(directory,l.exclusionFile),
    occlusionMaskPath:path.join(directory,l.repairMaskFile),
    suggestedLongestSide:preservesSource(job) ? Math.max(l.w,l.h) : Math.min(4096,Math.max(1024,Math.max(l.w,l.h)*2)),
    children:job.hybridDraft.layers.filter(c=>c.parentId===l.regionId).map(c=>({id:c.regionId,name:c.name,text:c.text})),
  }));
  const referencePaths=[path.join(directory,job.sourceFile),path.join(directory,job.hybridDraft.guideFile),...(job.sourceMasterFile?[path.join(directory,job.sourceMasterFile)]:[])];
  if(preservesSource(job)) return {maskPurpose:"reference",referencePaths,repairRequests:requests,generationPrompt:[
    sourcePixelInstructions,
    "Produce one independent semantic layer per regionId. Inspect reusableComponents first; exact original artwork matches may use reuse:{jobId,revision,sliceId}. Separate planned children from parents and reconstruct only hidden material. All x/y/width/height are fixed source coordinates, including transparent margins. Do not redraw already visible pixels.",
    JSON.stringify({referencePaths,layers:requests}),splitInstructions(job.splitOptions),
    `Return {repairs:[{regionId,sourcePixels:{alphaPath,repairMaskPath?,repairImagePath?}}]} or {regionId,reuse:{jobId,revision,sliceId}}. Use absolute PNG paths. Submit via complete-repairs; successful status is ${job.autoContinue ? "ready, automatically imported into the canvas" : "review_repairs for review"}. Do not submit twice.`,
  ].join("\n\n")};
  if(job.splitOptions?.generationMode === "sheet") return {maskPurpose:"reference",referencePaths,repairRequests:requests,generationPrompt:[
    sheetInstructions,JSON.stringify({referencePaths,layers:requests}),splitInstructions(job.splitOptions),
    `Return {sheets:[{imagePath,background?}],repairs:[{regionId,sheetIndex,sheetRect:{x,y,w,h}}]}. Reused rows replace sheetIndex/sheetRect with reuse. Inspect every isolated layer before submission via complete-repairs. Successful status is ${job.autoContinue ? "ready, automatically imported into the canvas" : "review_repairs"}. Do not submit twice.`,
  ].join("\n\n")};
  return {maskPurpose:"reference",referencePaths,repairRequests:requests,generationPrompt:[
    "Produce complete independent UI layers using the ORIGINAL image as appearance evidence and numbered MASK OVERLAYS as semantic boundary references. Before any generation, inspect reusableComponents and open plausible imagePath candidates. Reuse existing layers when artwork, exact text, colours, state, framing and resolution satisfy the request; names alone do not prove a match. Return reuse:{jobId,revision,sliceId} for a match and do not call image generation for it. Only generate missing or unsuitable layers. Mixed reuse/new results and entirely reused stacks are supported. Each regionId must be represented exactly once. This is full-layer reconstruction or reuse, not masked inpainting.",
    "The masks are imperfect advisory annotations. Their pixels are NOT authoritative output alpha or a pixelwise editing restriction. Correct jagged/incomplete contours, reconstruct hidden material, preserve fine strokes, holes, antialiasing and intentional translucent edges. Red guide areas indicate user-marked competing content; interpret this semantic intent in context, do not literally punch red-shaped holes. Never reproduce guide colours, numbers or mask defects.",
    "Preserve element identity, original colours, typography/exact text, proportions and layout. Generate only the named layer: remove all separately planned children from a parent and reconstruct the parent's continuous material. For foreground layers omit the backing plate and neighbours. Reconstruct missing parts naturally; do not invent unrelated ornaments or change button states.",
    "Pass the original source/crop AND the layer guide as image references to the image generation/editing tool. When referencePaths has a third image, it is the original high-resolution master for appearance detail; all layout coordinates still refer to the first image. Generate at high resolution (suggestedLongestSide is guidance); preserve the native generated detail. One PNG per regionId. No contact sheets. For reliable extraction request a perfectly uniform #ff00ff backdrop (#00ff00 when the artwork uses magenta), including hollow interiors, and declare background. Genuine transparent RGBA is also accepted without background, but verify actual alpha metadata. Never render a checkerboard or simulate transparency; reject and regenerate those outputs. Only a deliberately full rectangular background layer may declare allowOpaque:true.",
    "Keep the main silhouette, proportions, palette, relative stroke weight and visual style. Resolve blurry or blocky source detail into crisp coherent artwork; small local detail differences are acceptable. Do not reproduce low-resolution pixels or mask softness, and do not introduce stronger bevels or new ornaments. Inspect source and output at layout size and native resolution, including light/dark backgrounds. Reject blurry edges, mosaic blocks, key-colour halos, missing holes and duplicated foreground content before submission.",
    "Layout x/y/width/height remain source coordinates and are separate from PNG resolution. The server preserves high-resolution PNGs, removes only a declared uniform backdrop and normally trims empty margins. If the intended layer includes transparent margins, inspect the generation and supply generatedRect:{x,y,w,h} in GENERATED pixels matching the FULL planned rectangle; this preserves those margins. Do not use the old mask to crop output. Never guess mapping. Aspect mismatch over 8% is rejected; inspect and correct the framing or regenerate instead of distorting the artwork.",
    JSON.stringify({referencePaths,layers:requests}),
    splitInstructions(job.splitOptions),
    `Return {repairs:[{regionId,reuse?:{jobId,revision,sliceId},imagePath?,background?,allowOpaque?,generatedRect?}]}. For reused layers provide only regionId and reuse; no imagePath, background or mapping. New images use absolute PNG paths. Complete every requested layer exactly once via complete-repairs. Inspect actual artwork and transparency before submission. Reuse preserves the entire native PNG and its framing. The service keeps alpha; it does not composite through any input mask. Stop on ${job.autoContinue ? "ready: the service automatically publishes validated layers to the canvas" : "review_repairs: the user will review the result"}. Do not call approve-repairs or submit twice.`,
  ].join("\n\n")};
}

export async function finishReferenceLayers(service,job,results,signal) {
  const draft=job.hybridDraft,directory=service.directory(job.id);
  if(!Array.isArray(results)||results.length!==draft.layers.length||new Set(results.map(r=>r.regionId)).size!==results.length||results.some(r=>!draft.layers.some(l=>l.regionId===r.regionId))) throw new Error("请为每个参考图层返回一次完整生成结果");
  const images=[],layers=[];
  let totalPixels=0;
  for(const entry of draft.layers) {
    if(signal?.aborted) throw new Error("任务已取消");
    const result=results.find(r=>r.regionId===entry.regionId);
    if(result._candidateKeep) {
      images.push(await service.upload(result.dataUrl));
      layers.push({...job.repairPreview.slices.find(s=>s.regionId===entry.regionId),candidateRetained:true,id:`slice-${layers.length+1}`});
      continue;
    }
    if(result.sourcePixels || preservesSource(job) && !result.reuse) {
      const {image,preservation}=await sourcePixelLayer(service,job,entry,result);
      images.push(image);
      const {imageFile,repairInputFile,visiblePixels,score,...metadata}=entry;
      layers.push({...metadata,id:`slice-${layers.length+1}`,semanticSource:"ai",extraction:"source-preserved",maskPurpose:"reference",preservation});
      continue;
    }
    if (result.reuse) {
      const ref=result.reuse;
      if (!/^[a-f0-9-]{36}$/.test(ref.jobId||"") || !/^[a-f0-9-]{36}$/.test(ref.revision||"") || !/^slice-\d+$/.test(ref.sliceId||"")) throw new Error("复用组件引用无效");
      if (["dataUrl","imagePath","background","allowOpaque","generatedRect"].some(k=>result[k]!==undefined)) throw new Error("复用图层不能同时提供新图片、底色或映射");
      const image=await service.reuseLayerImage(job,{...entry,reuse:ref});
      const meta=await sharp(image).metadata();
      totalPixels+=meta.width*meta.height;
      if(totalPixels>67108864) throw new Error("生成图层总面积超过 6400 万像素，请分批拆解");
      images.push(image);
      const {imageFile,repairInputFile,visiblePixels,score,...metadata}=entry;
      const warnings=[...entry.warnings];
      if(meta.width<entry.w||meta.height<entry.h) warnings.push("复用素材分辨率低于布局尺寸，请检查清晰度。");
      layers.push({...metadata,id:`slice-${layers.length+1}`,semanticSource:"ai",extraction:"reused",maskPurpose:"reference",reuse:{jobId:ref.jobId,revision:ref.revision,sliceId:ref.sliceId},warnings});
      continue;
    }
    if(result.background!==undefined&&!/^#[\da-f]{6}$/i.test(result.background)) throw new Error("生成素材的纯色背景声明无效");
    if(result.allowOpaque!==undefined&&typeof result.allowOpaque!=="boolean") throw new Error("allowOpaque 必须为布尔值");
    if(result.allowOpaque&&entry.layerType!=="background") throw new Error("只有完整矩形背景可以声明不透明");
    let image=await service.upload(result.dataUrl);
    const original=await sharp(image).metadata();
    const rect=result.generatedRect;
    if(rect) {
      const {x,y,w,h}=rect;
      if(![x,y,w,h].every(Number.isInteger)||x<0||y<0||w<1||h<1||x+w>original.width||y+h>original.height) throw new Error("生成图映射范围无效或超出图片");
      image=await sharp(image).extract({left:x,top:y,width:w,height:h}).png().toBuffer();
    }
    const candidateWarnings=job.reviewBeforePublish && Array.isArray(result.warnings) ? result.warnings.filter(w=>typeof w==="string").slice(0,10).map(w=>w.slice(0,1000)) : [];
    image=await prepareLayerImage(image,{...entry,background:result.background,allowOpaque:result.allowOpaque},{preserveResolution:true,preserveFrame:Boolean(rect),candidateMode:job.reviewBeforePublish,warnings:candidateWarnings});
    const meta=await sharp(image).metadata();
    totalPixels+=meta.width*meta.height;
    if(totalPixels>67108864) throw new Error("生成图层总面积超过 6400 万像素，请分批拆解");
    const warnings=[...entry.warnings,...candidateWarnings];
    if(meta.width<entry.w||meta.height<entry.h) warnings.push("生成素材分辨率低于布局尺寸，请检查清晰度或重新生成。");
    images.push(image);
    const {imageFile,repairInputFile,visiblePixels,score,...metadata}=entry;
    layers.push({...metadata,id:`slice-${layers.length+1}`,semanticSource:entry.semanticSource==="manual"?"manual":"ai",extraction:"mask-guided-ai",maskPurpose:"reference",warnings,
      ...(result.sheetCrop?{sheetCrop:result.sheetCrop}:{}),
      generationMapping:{generatedWidth:original.width,generatedHeight:original.height,...(rect?{generatedRect:rect}:{}),frame:rect?"explicit":"trimmed",layoutWidth:entry.w,layoutHeight:entry.h}});
  }
  return writeLayers(directory,job,layers,images,randomUUID(),path.join(service.root,"component-images"),{prepared:true});
}
