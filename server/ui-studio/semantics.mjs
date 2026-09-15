import { componentMetadata } from "../../shared/ui-schema.mjs";

export function updateSemantics(service, id, input) {
  const job = service.get(id);
  if (job.status !== "ready" || input.revision !== job.revision) throw new Error("素材版本已变化，请重新选择节点");
  if ((input.metadataRevision ?? 0) !== (job.metadataRevision || 0)) throw new Error("组件属性已被其他窗口修改，请刷新后重试");
  const changes = input.slices || [];
  if (!Array.isArray(changes) || changes.length > 500) throw new Error("组件属性清单无效");
  const known = new Set(job.slices.map(s => s.id)), updates = new Map();
  for (const value of changes) {
    if (!known.has(value.id) || updates.has(value.id)) throw new Error("组件 ID 不存在或重复");
    updates.set(value.id, componentMetadata({ ...job.slices.find(s => s.id === value.id), ...value, semanticSource: input.source === "ai" ? "ai" : "manual" }));
  }
  return service.save({ ...job, ...(input.presetName !== undefined ? { presetName: String(input.presetName).trim().slice(0, 120) || "UI 预设" } : {}),
    slices: job.slices.map(s => ({ ...s, ...updates.get(s.id) })), metadataRevision: (job.metadataRevision || 0) + 1 });
}

export function classificationPrompt(job, parent) {
  const slices = parent.slices.filter(s => !job.parent.sliceId || s.id === job.parent.sliceId);
  return ["Inspect the supplied UI atlas and slice images. Classify semantic components; do not generate or edit any images.",
    `User request: ${job.prompt}`,
    "Choose layerType: button, text, icon, texture, background, border, decoration, component. A button may contain raster text but remains button; use text for isolated lettering. Do not pretend a flat screenshot is already decomposed. Unknown items remain component.",
    "Return {presetName,slices:[{id,name,layerType,text?,fontFamily?,fontSize?,textColor?,textAlign?,textRender?}]}. Preserve every supplied id; names should be short Chinese descriptions. Read text exactly; leave fontFamily empty if the actual font cannot be identified. Do not invent exact font identities. Default textRender:image preserves the bitmap. Do not change positions or images.",
    JSON.stringify(slices.map(({ id, name, x, y, w, h }) => ({ id, name, x, y, w, h }))),
  ].join("\n\n");
}
