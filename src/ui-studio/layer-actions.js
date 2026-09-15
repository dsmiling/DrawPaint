import { updateLayerDocument } from "./document-edits.js";
import { createShapeId } from "tldraw";
import { buildLayerTree, copyLayerBranch, flattenLayerTree, moveLayerNode, nodeKey } from "./layer-tree.js";
import { uiNodeShapes, uiShapePage } from "./canvas.js";

export function duplicateUiNode(editor, jobs, roots, node) {
  const page = editor.getCurrentPageId();
  const drawOrder = s => { const indices = [s.index]; let p = editor.getShape(s.parentId); while (p) { indices.unshift(p.index); p = editor.getShape(p.parentId); } return indices.join("/"); };
  const images = uiNodeShapes(editor, node).sort((a, b) => drawOrder(a).localeCompare(drawOrder(b)));
  if (!images.length) throw new Error("该节点没有可复制的画布图片");
  if (images.some(s => uiShapePage(editor, s) !== page)) throw new Error("请先将子节点放到同一页面，再复制整个节点");
  const meta = editor.getDocumentSettings().meta;
  const plan = copyLayerBranch(roots, nodeKey(node), meta.uiLayerEdits || {}, () => `copy:${crypto.randomUUID()}`);
  const owner = new Map();
  for (const { node: child } of flattenLayerTree([node])) {
    if (child.sliceId) for (const s of uiNodeShapes(editor, { ...child, children: undefined })) owner.set(s.id, nodeKey(child));
  }
  const shapes = images.map(s => {
    const { index: _sourceIndex, ...record } = s;
    const transform = editor.getShapePageTransform(s), point = transform.point();
    // Flatten native groups into page space; the logical copied hierarchy is preserved.
    let opacity = s.opacity, parent = editor.getShape(s.parentId);
    while (parent) { opacity *= parent.opacity; parent = editor.getShape(parent.parentId); }
    return { ...record, id: createShapeId(), parentId: page, x: point.x + 24, y: point.y + 24,
      rotation: transform.rotation(), opacity, isLocked: false,
      meta: { ...s.meta, uiNodeKey: plan.mapping[owner.get(s.id)],
        uiHiddenBy: (s.meta.uiHiddenBy || []).map(key => plan.mapping[key] || key) } };
  });
  const tree = buildLayerTree(jobs, meta.uiHierarchy || {}, plan.edits);
  const layout = { ...meta.uiHierarchy, ...moveLayerNode(tree, plan.key, nodeKey(node), "after") };
  const origins = { ...meta.uiCoordinateOrigins };
  for (const [oldKey, newKey] of Object.entries(plan.mapping)) {
    const origin = origins[`${page}/${oldKey}`];
    if (origin) origins[`${page}/${newKey}`] = { x: origin.x + 24, y: origin.y + 24 };
  }
  const mark = editor.markHistoryStoppingPoint("复制 UI 节点");
  try {
    editor.run(() => {
      editor.createShapes(shapes);
      editor.bringToFront(shapes.map(s => s.id));
      updateLayerDocument(editor, { ...meta, uiHierarchy: layout, uiLayerEdits: plan.edits, uiCoordinateOrigins: origins });
    });
  } catch (error) { editor.bailToMark(mark); throw error; }
  return flattenLayerTree(buildLayerTree(jobs, layout, plan.edits)).find(r => nodeKey(r.node) === plan.key).node;
}

export function deleteUiNode(editor, node) {
  if (flattenLayerTree([node]).some(r => !["ready", "failed", "cancelled"].includes(r.node.job.status))) throw new Error("请先取消此节点下正在运行的任务，再删除节点");
  const meta = editor.getDocumentSettings().meta, edits = meta.uiLayerEdits || {};
  const deleted = [...new Set([...(edits.deleted || []), ...flattenLayerTree([node]).map(r => nodeKey(r.node))])];
  const images = uiNodeShapes(editor, node);
  const mark = editor.markHistoryStoppingPoint("删除 UI 节点");
  try {
    editor.run(() => {
      editor.deleteShapes(images.map(s => s.id));
      if (images.some(s => editor.getShape(s.id))) throw new Error("节点包含锁定图片，请先解锁再删除");
      updateLayerDocument(editor, { ...meta, uiLayerEdits: { ...edits, deleted } });
      editor.selectNone();
    });
  } catch (error) { editor.bailToMark(mark); throw error; }
}

export function updateCopyMetadata(editor, node, values) {
  const name = values.name.trim();
  if (!name || name.length > 120) throw new Error("名称须为 1–120 个字符");
  const meta = editor.getDocumentSettings().meta, edits = meta.uiLayerEdits || {};
  const copy = edits.copies?.[nodeKey(node)];
  if (!copy) throw new Error("副本节点已移除");
  editor.markHistoryStoppingPoint("修改副本属性");
  updateLayerDocument(editor, { ...meta, uiLayerEdits: { ...edits,
    copies: { ...edits.copies, [nodeKey(node)]: { ...copy, name, ...(node.slice ? { slice: { ...copy.slice, ...values, name, semanticSource: "manual" } } : {}) } } } });
}
