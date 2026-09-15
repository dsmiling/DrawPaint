import sharp from "sharp";
import { sourcePixelMode } from "../../shared/split-options.mjs";

export const preservesSource = job => sourcePixelMode(job.splitOptions);

export const sourcePixelInstructions = [
  "SOURCE-PIXEL PRESERVATION overrides full-layer redraw instructions. Treat the original as an EDIT TARGET, not style inspiration. Keep its original coordinate system, silhouette, stroke thickness, colours, texture and visible pixel detail. Do not upscale/redesign visible artwork or crop/recenter it to match a new image.",
  "For each new layer return sourcePixels:{alphaPath,repairMaskPath?,repairImagePath?}. alphaPath is a refined, opaque grayscale ownership matte at EXACT layer width/height in source coordinates (white = this element, black = other elements). The advisory SAM/Mask is only a starting reference: inspect the original, correct semantic ownership, holes and fine edges; never blindly copy a coarse mask or a regenerated image silhouette. The server copies original RGB under this matte and retains original outer alpha; it does not use generated RGB there. Matte analysis/refinement may use local image processing. Do not use a rectangle containing neighbours as a semantic layer.",
  "Only occluded material and explicitly removed text may be painted. For these provide repairMaskPath (opaque grayscale, white only on missing/removed content) and repairImagePath (aligned RGBA crop, exact same dimensions). Use imagegen EDIT on the ORIGINAL crop for textured repairs, keeping surrounding pixels as context; the server discards generated RGB outside this explicit repair mask. Flat material may use local interpolation. Repair masks and final alpha are inferred and checked against the actual source, not mechanically accepted from advisory masks. Include covered child areas only within the correct parent's silhouette. Never put removed text into any layer.",
  "Keep source resolution; higher pixel counts are not higher fidelity. Reuse only assets visually matching the ORIGINAL, never a previous stylized redraw merely because its name matches. Inspect the recomposition against the source at 1x, excluding intentional removed text. Correct ownership/placement when contours differ; do not change original RGB to hide segmentation errors. No whole-layer imagePath for preservation mode. CLI converts the sourcePixels paths to inline PNG data for submission.",
].join("\n\n");

async function greyMask(service, value, width, height, name) {
  const png = await service.upload(value);
  const {data,info} = await sharp(png).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  if(info.width!==width || info.height!==height) throw new Error(`${name}必须与原图层尺寸一致，不会自动拉伸`);
  const result=Buffer.alloc(width*height);
  for(let p=0;p<result.length;p++) {
    const i=p*4;
    if(data[i]!==data[i+1] || data[i]!==data[i+2] || data[i+3]!==255) throw new Error(`${name}须为不透明灰度图`);
    result[p]=data[i];
  }
  return result;
}

export async function sourcePixelLayer(service, job, entry, result) {
  if (job.splitOptions?.resolutionMode === "hd") throw new Error("高清拆分不能回填原像素提取结果，请生成完整高清图层");
  const spec=result.sourcePixels;
  if(!spec || typeof spec!=="object") throw new Error(`“${entry.name}”开启原图保真，须提交元素归属及局部修补，不能整层重绘`);
  if(["dataUrl","imagePath","background","allowOpaque","generatedRect","reuse"].some(k=>result[k]!==undefined)) throw new Error("原像素图层不能混用整层生图或复用字段");
  if(Boolean(spec.repairMaskDataUrl)!==Boolean(spec.repairDataUrl)) throw new Error("局部修补须同时提供修补范围和图片");
  const {x,y,w,h}=entry;
  const source=await sharp(service.asset(job.id,job.sourceFile || "reference-1.png")).extract({left:x,top:y,width:w,height:h}).ensureAlpha().raw().toBuffer();
  const alpha=await greyMask(service,spec.alphaDataUrl,w,h,"元素归属图");
  const repair=spec.repairMaskDataUrl ? await greyMask(service,spec.repairMaskDataUrl,w,h,"修补范围") : Buffer.alloc(w*h);
  let generated;
  if(spec.repairDataUrl) {
    generated=await sharp(await service.upload(spec.repairDataUrl)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    if(generated.info.width!==w||generated.info.height!==h) throw new Error("局部修补图尺寸须与原图层一致，不会自动拉伸");
  }
  let visible=0, repaired=0;
  for(let p=0;p<alpha.length;p++) {
    const i=p*4;
    if(repair[p] && !alpha[p]) throw new Error("修补范围超出本图层归属区域");
    if(repair[p]) {
      if(generated.data[i+3]<250) throw new Error("局部修补区域缺少完整像素");
      const amount=repair[p]/255;
      for(let c=0;c<3;c++) source[i+c]=Math.round(source[i+c]*(1-amount)+generated.data[i+c]*amount);
    }
    source[i+3]=Math.round(source[i+3]*alpha[p]/255);
    if(source[i+3]) {visible++;if(repair[p]) repaired++;}
  }
  if(!visible) throw new Error(`“${entry.name}”没有可见像素，请修正元素归属`);
  return {image:await sharp(source,{raw:{width:w,height:h,channels:4}}).png().toBuffer(),
    preservation:{mode:"source-pixels",visiblePixels:visible,preservedPixels:visible-repaired,repairedPixels:repaired}};
}
