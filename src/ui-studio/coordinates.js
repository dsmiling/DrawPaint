import { nodeKey, flattenLayerTree } from "./layer-tree.js";
import { nodePreview, uiNodeShapes, uiShapePage, moveUiNode } from "./canvas.js";
import { commonTranslation, localToWorld, worldToLocal } from "./coordinate-math.js";

const originKey = (editor, node) => `${editor.getCurrentPageId()}/${nodeKey(node)}`;
const currentImages = (editor, node) => uiNodeShapes(editor, node).filter(s => s.type === "image" && uiShapePage(editor, s) === editor.getCurrentPageId());

function initialOrigin(editor, node) {
  const own = currentImages(editor, node).filter(s => s.meta.uiJobId === node.jobId && s.meta.uiRevision === node.revision && s.meta.sourceRect);
  const points = own.map(s => {
    const source = s.meta.sourceRect;
    return editor.getShapePageTransform(s).applyToPoint({ x: -source.x * s.props.w / source.w, y: -source.y * s.props.h / source.h });
  }).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (points.length) {
    const median = key => [...points].sort((a, b) => a[key] - b[key])[Math.floor(points.length / 2)][key];
    return { x: median("x"), y: median("y") };
  }
  const preview = nodePreview(editor, node);
  return preview ? { x: preview.x, y: preview.y } : null;
}

export function nodeWorldOrigin(editor, node) {
  if (!node) return { x: 0, y: 0 };
  if (node.sliceId) {
    const own = currentImages(editor, { ...node, children: undefined })[0];
    const point = own && editor.getShapePageTransform(own)?.point();
    return point ? { x: point.x, y: point.y } : null;
  }
  return editor.getDocumentSettings().meta.uiCoordinateOrigins?.[originKey(editor, node)] || initialOrigin(editor, node);
}

export function nodeCoordinates(editor, node, parent) {
  const world = nodeWorldOrigin(editor, node), parentWorld = nodeWorldOrigin(editor, parent);
  return { world, local: world && parentWorld ? worldToLocal(world, parentWorld) : null, parentWorld };
}

export function setNodeCoordinate(editor, node, parent, space, axis, value, mark = true) {
  if (!Number.isFinite(value)) throw new Error("坐标须为有效数字");
  const coordinates = nodeCoordinates(editor, node, parent);
  const current = coordinates[space];
  if (!current) throw new Error("当前页面缺少该节点或父节点的图片，无法设置坐标");
  const target = { ...current, [axis]: value };
  const world = space === "local" ? localToWorld(target, coordinates.parentWorld) : target;
  moveUiNode(editor, node, { x: world.x - coordinates.world.x, y: world.y - coordinates.world.y }, mark);
}

// Presets have fixed origins independent of their children's bounding box.
// Observe document edits so canvas dragging and undo update these origins too.
// Derived updates don't create an extra undo step.
export function trackCoordinateOrigins(editor, roots, activeNode) {
  const presets = flattenLayerTree(roots).map(r => r.node).filter(n => !n.sliceId);
  const positions = node => currentImages(editor, node).map(s => {
    const point = editor.getShapePageTransform(s).point();
    return { id: s.id, page: uiShapePage(editor, s), x: point.x, y: point.y };
  });
  let previous = new Map(), syncing = false;
  function sync() {
    if (syncing) return;
    syncing = true;
    try {
      const meta = editor.getDocumentSettings().meta, origins = { ...(meta.uiCoordinateOrigins || {}) };
      let changed = false;
      const active = activeNode();
      const activeKeys = new Set(active ? flattenLayerTree([active]).map(r => nodeKey(r.node)) : []);
      for (const preset of presets) {
        const key = originKey(editor, preset), points = positions(preset);
        if (!points.length) { previous.delete(key); continue; }
        if (!origins[key]) { const origin = initialOrigin(editor, preset); if (origin) { origins[key] = origin; changed = true; } }
        else {
          const delta = commonTranslation(previous.get(key) || [], points, activeKeys.has(nodeKey(preset)));
          if (delta) { origins[key] = localToWorld(origins[key], delta); changed = true; }
        }
        previous.set(key, points);
      }
      if (changed) editor.run(() => editor.updateDocumentSettings({ meta: { ...meta, uiCoordinateOrigins: origins } }), { history: "ignore" });
    } finally { syncing = false; }
  }
  sync();
  const stop = editor.store.listen(sync, { scope: "document", source: "all" });
  // Page changes change which parent coordinate system is being inspected.
  const stopSession = editor.store.listen(sync, { scope: "session", source: "all" });
  return () => { sync(); stop(); stopSession(); };
}
