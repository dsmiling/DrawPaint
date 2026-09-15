import sharp from "sharp";
import { sourcePixelMode } from "../../shared/split-options.mjs";

export const sheetInstructions = `BATCH SPRITE SHEET MODE. First inspect reusableComponents and reuse exact matching artwork and resolution. Generate ONLY missing components together on a high-resolution sprite sheet with ONE image-generation call per sheet, instead of one call per component. Each component must be complete, isolated, non-overlapping and surrounded by empty gutters. Never pack the assembled UI: remove foreground children from base plates and fill their occluded material. Preserve source style, colour, relative line thickness, silhouettes and text. Masks are advisory boundary hints, never authoritative output alpha.
Prefer 2–4 components per sheet, never more than 8 (one is allowed), with generous space for each; aim for at least 1024 native pixels on each component's visible long side. HD submission rejects visible content below 768 pixels even if its surrounding sheet or transparent frame is large. Use 2048–4096 sheet dimensions when supported, at most 16 million pixels. If actual cells are too small or blurry, reduce the batch size or generate those layers individually; do not upscale a tiny cell to pretend it has detail. Reuse previous successes only when they meet the same clarity and resolution requirements. No labels, numbering, grid lines, checkerboards or extra decorations. A uniform #ff00ff or #00ff00 backdrop including hollow interiors is preferred; genuine RGBA is also accepted.
Inspect the ACTUAL returned sheet, then report pixel rectangles around each complete isolated component. Do not assume the generator followed a requested grid. Preserve useful transparent margins; each rectangle represents the FULL original layout frame, including placement offsets. Rectangles must not overlap and must match original frame proportions within 8%. The server crops PNGs at native resolution and only scales their DISPLAY to original x/y/w/h; it never uses the assembled sheet as the canvas result.
Return a top-level sheets:[{imagePath:<absolute PNG path>,background?:"#ff00ff"}] array and refer to sheets with zero-based sheetIndex and sheetRect:{x,y,w,h} on each new layer. Reused layers provide reuse:{jobId,revision,sliceId} instead, without sheet fields. No separate imagePath/dataUrl/generatedRect on sheet layers. allowOpaque:true is only for deliberate full rectangular background layers. Provide each requested region exactly once. The CLI uploads each sheet ONCE; the server cuts it into independent PNGs. All-reuse needs no sheets or image-generation calls.`;

export async function expandSheets(service, job, entries, sheets) {
  const hasReferences = Array.isArray(entries) && entries.some(e => e.sheetIndex !== undefined || e.sheetRect !== undefined);
  if (sheets === undefined && !hasReferences) return entries;
  if (sourcePixelMode(job.splitOptions) || job.method === "hybrid" && job.maskPurpose !== "reference") throw new Error("原像素提取和局部修补任务不能提交生成图集");
  if (!Array.isArray(entries) || entries.length > 64 || !Array.isArray(sheets) || !sheets.length || sheets.length > 8) throw new Error("图集须为 1–8 张，并提供对应的图层范围");
  const decoded = [];
  let area = 0;
  for (const sheet of sheets) {
    if (sheet.background !== undefined && !/^#[\da-f]{6}$/i.test(sheet.background)) throw new Error("图集底色声明无效");
    const png = await service.upload(sheet.dataUrl), meta = await sharp(png).metadata();
    area += meta.width * meta.height;
    if (area > 67108864) throw new Error("图集总面积超过 6400 万像素");
    decoded.push({png,meta,background:sheet.background,rects:[]});
  }
  // Validate all mappings before any crop or publication.
  for (const entry of entries) {
    if (entry.sheetIndex === undefined && entry.sheetRect === undefined) continue;
    const sheet = decoded[entry.sheetIndex], r = entry.sheetRect;
    if (!Number.isInteger(entry.sheetIndex) || !sheet || !r || ![r.x,r.y,r.w,r.h].every(Number.isInteger) || r.x < 0 || r.y < 0 || r.w < 1 || r.h < 1 || r.x+r.w > sheet.meta.width || r.y+r.h > sheet.meta.height) throw new Error("图集索引或切割范围无效、超出图片");
    if (["reuse","sourcePixels","imagePath","dataUrl","generatedRect","background"].some(k=>entry[k]!==undefined)) throw new Error("图集图层不能混用复用、新图或其他裁切字段");
    if (sheet.rects.some(b=>r.x < b.x+b.w && r.x+r.w > b.x && r.y < b.y+b.h && r.y+r.h > b.y)) throw new Error("同张图集的组件切割范围不能重叠");
    sheet.rects.push(r);
    if (sheet.rects.length > 8) throw new Error("每张图集最多 8 个组件，请分批以保留细节");
  }
  if (decoded.some(s=>!s.rects.length)) throw new Error("存在没有对应图层的图集");
  const result=[];
  for (const entry of entries) {
    if (entry.sheetIndex === undefined) {result.push(entry);continue;}
    const {sheetIndex,sheetRect,...metadata}=entry, sheet=decoded[sheetIndex];
    const {x,y,w,h}=sheetRect;
    const png=await sharp(sheet.png).extract({left:x,top:y,width:w,height:h}).png().toBuffer();
    result.push({...metadata,dataUrl:`data:image/png;base64,${png.toString("base64")}`,
      ...(sheet.background ? {background:sheet.background}:{}), generatedRect:{x:0,y:0,w,h},sheetCrop:{sheetIndex,x,y,w,h,sheetWidth:sheet.meta.width,sheetHeight:sheet.meta.height}});
  }
  return result;
}
