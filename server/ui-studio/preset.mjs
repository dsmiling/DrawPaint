// A preset uses the newest successful decomposition for each component.
// Failed attempts and historical revisions never replace its source artwork.
export function buildPreset(service, id, input = {}) {
  const job = service.get(id);
  if (job.status !== "ready" || !job.slices?.length || input.revision !== job.revision) throw new Error("请重新选择已完成的素材版本");
  const all = service.list(), latest = input.variant !== "source";
  const refinement = (owner, sliceId) => latest && all.filter(j => j.operation === "decompose" && j.status === "ready" && j.parent?.jobId === owner.id && j.parent.revision === owner.revision && (j.parent.sliceId || null) === sliceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  let count = 0;
  function rootChildren(owner, depth) {
    if (depth > 12) throw new Error("预设超过 500 个节点或 12 层，请选择较小的组件导出");
    const refined = refinement(owner, null);
    return refined ? rootChildren(refined, depth + 1) : owner.slices.slice().sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0)).map(s => sliceNode(owner, s, depth));
  }
  function sliceNode(owner, slice, depth) {
    if (++count > 500 || depth > 12) throw new Error("预设超过 500 个节点或 12 层，请选择较小的组件导出");
    const { file, componentIds, ...metadata } = slice;
    const node = { ...metadata, jobId: owner.id, revision: owner.revision, imageFile: file, children: [] };
    const refined = refinement(owner, slice.id);
    if (refined) node.children = rootChildren(refined, depth + 1);
    return node;
  }
  const selected = input.sliceId ? job.slices.find(s => s.id === input.sliceId) : null;
  if (input.sliceId && !selected) throw new Error("组件不存在");
  const root = selected ? sliceNode(job, selected, 0) : { name: job.presetName || job.prompt, layerType: "preset", x: 0, y: 0, w: job.width, h: job.height,
    children: rootChildren(job, 0) };
  root.x = 0; root.y = 0;
  return { schema: "drawpaint.ui-preset.v1", name: root.name, width: root.w, height: root.h, variant: latest ? "latest" : "source", root };
}
