import { componentMetadata } from "./ui-schema.mjs";
import { splitInstructions, connectedStructureInstructions } from "./split-options.mjs";

// Regions describe artwork bounds in the immutable source image, not crop instructions.
export function validatePlan(regions, width, height) {
  if (!Array.isArray(regions) || regions.length < 2 || regions.length > 64) throw new Error("拆解方案须包含 2–64 个组件");
  const ids = new Set();
  const result = regions.map((region, index) => {
    const id = String(region.id || `region-${index + 1}`);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || ids.has(id)) throw new Error("组件标识重复或无效");
    ids.add(id);
    const { x, y, w, h, zIndex } = region;
    if (![x, y, w, h, zIndex].every(Number.isInteger) || x < 0 || y < 0 || w < 1 || h < 1 || x + w > width || y + h > height || Math.abs(zIndex) > 10000) throw new Error(`组件 ${index + 1} 的范围或层序无效，范围不能超出效果图`);
    const points = key => {
      const values = region[key] || [];
      if (!Array.isArray(values) || values.length > 20 || values.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isInteger) || p[0] < 0 || p[1] < 0 || p[0] >= width || p[1] >= height)) throw new Error("提示点须为原图范围内的整数坐标，最多 20 个");
      return values;
    };
    const repairMode = region.repairMode || "none";
    if (!["none", "surface", "image"].includes(repairMode)) throw new Error("无效的修补方式");
    const maskMode = region.maskMode || "sam";
    if (!["sam", "rectangle"].includes(maskMode) || maskMode === "rectangle" && region.layerType !== "background") throw new Error("只有明确的矩形背景可以使用完整矩形掩膜");
    const cleanupArea = region.cleanupArea ?? 0, edgeFeather = region.edgeFeather ?? 0;
    if (!Number.isInteger(cleanupArea) || cleanupArea < 0 || cleanupArea > 1000 || !Number.isInteger(edgeFeather) || edgeFeather < 0 || edgeFeather > 3) throw new Error("边缘清理参数无效");
    return { ...componentMetadata(region), id, name: String(region.name || `组件 ${index + 1}`).slice(0, 120),
      x, y, w, h, zIndex, group: String(region.group || "").slice(0, 80), notes: String(region.notes || "").slice(0, 1000),
      positivePoints: points("positivePoints"), negativePoints: points("negativePoints"),
      parentId: region.parentId || null, repairMode, maskMode, cleanupArea, edgeFeather };
  });
  for (const region of result) {
    if (!region.parentId) continue;
    const parent = result.find(r => r.id === region.parentId);
    if (!parent || parent.zIndex >= region.zIndex) throw new Error("父层必须存在且位于子层之后；不允许循环层级");
    if (region.x >= parent.x + parent.w || region.y >= parent.y + parent.h || region.x + region.w <= parent.x || region.y + region.h <= parent.y) throw new Error("子层必须与其承载的父层相交");
  }
  if (result.reduce((sum, r) => sum + r.w * r.h, 0) > 16777216) throw new Error("拆解图层总面积超过 1600 万像素，请先拆大组件再逐层细分");
  return result;
}

export function buildPlanPrompt(job) {
  return [
    "Inspect the supplied complete game UI mockup and plan its semantic decomposition. This is analysis only: do not generate, crop, or edit images.",
    `Source canvas: ${job.width} x ${job.height} pixels, origin at top left. User request: ${job.prompt}`,
    "Identify 2–64 useful layers: clean scene background, title, complete menu buttons or text lines, selection indicator, frames and decorations. Keep words together. Do not split every letter or tiny ornament. Bounds may overlap. Background should cover the entire canvas and must be reconstructed cleanly behind foreground layers.",
    connectedStructureInstructions,
    "For a frame with attached ornaments, create ONE region covering the full frame plus every attached ornament. Do not assign those ornaments child regionIds or exclusion masks. Its ownership reference includes the entire connected structure. Use multiple positive points across frame and ornaments when needed. If the source is already one inseparable structure, report that it cannot be usefully split; never invent seams to reach a layer count.",
    'Return {regions:[{id,name,layerType,x,y,w,h,zIndex,group,notes,text?}]}. Coordinates are integer tight artwork bounds in source pixels. zIndex increases from background to foreground. layerType: component|button|text|icon|texture|background|border|decoration. Use group to name related components (e.g. menu). Notes describe isolation and occlusion repair. Include exact visible text for text layers, leave unknown fontFamily empty.',
    ...(job.hybrid ? [
      "This plan creates advisory boundary masks for AI FULL-LAYER RECONSTRUCTION. Masks help identify elements; they are not final alpha, hard crop boundaries or restrictions on generated pixels. Every layer is reconstructed, including foreground icons and text. Also include positivePoints:[[x,y]] (1–3 solid target points), negativePoints:[[x,y]] (0–2 competing-object points, never a child covering this parent), parentId (nearest material parent or null), maskMode (sam; rectangle only for a real rectangular background). Points are absolute integer SOURCE coordinates. Bounds describe complete intended artwork, including hidden portions and intentional glow; do not follow defects of a coarse mask. Each instance needs its own id. Keep cleanupArea:0 and edgeFeather:0. Explain element identity, exact text, appearance and what child content must be removed in notes.",
      "Ordinary text should be a text layer with exact content and textRender:image by default to preserve source lettering. Decorative logos remain raster icon/decoration assets. OCR is an uncertain hint; correct errors against the ORIGINAL image. fontFamily stays empty unless known. The cleaned image is diagnostic only; restore decorative text by planning from the original. Parent surfaces must include their covered child area in their intended bounds. No whole-image foreground copy.",
      `OCR hints: ${JSON.stringify(job.ocr?.regions || [])}`,
    ] : []),
    "Every requested visible element should be accounted for once, except where intentional overlap is required. Do not create a full source-image foreground layer or retain menu text on the clean background. Total region area <= 16000000 pixels. User will review and edit this plan before generation.",
    splitInstructions(job.splitOptions),
  ].join("\n\n");
}
