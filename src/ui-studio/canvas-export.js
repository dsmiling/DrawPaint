import { uiNodeShapes, uiShapePage } from "./canvas.js";
import { nodeKey } from "./layer-tree.js";

// Capture the current editor synchronously, without waiting for autosave.
export function captureCanvasPreset(editor, node) {
  const page = editor.getCurrentPageId(), owned = new Set(), orders = new Map();
  function walk(n) {
    const children = (n.children || []).map(walk).filter(Boolean);
    const own = n.sliceId ? uiNodeShapes(editor, { ...n, children: undefined }) : [];
    for (const s of own) {
      if (owned.has(s.id)) continue;
      owned.add(s.id);
      if (uiShapePage(editor, s) !== page) throw new Error("请先将所选节点的全部组件放在当前页，再导出画布布局");
      const transform = editor.getShapePageTransform(s), angle = transform.rotation();
      if (Math.abs(Math.sin(angle * 2)) > .00001 || s.props.crop) throw new Error("当前画布导出支持直角旋转；请恢复任意角度旋转或裁剪后重试");
      const bounds = editor.getShapePageBounds(s), indices = [s.index];
      let hidden = s.opacity === 0, opacity = hidden ? s.meta.uiVisibleOpacity ?? 1 : s.opacity, parent = editor.getShape(s.parentId);
      while (parent) { hidden ||= parent.opacity === 0; opacity *= parent.opacity === 0 ? parent.meta.uiVisibleOpacity ?? 1 : parent.opacity; indices.unshift(parent.index); parent = editor.getShape(parent.parentId); }
      const key = `${nodeKey(n)}/${s.id}`;
      orders.set(key, indices.join("/"));
      children.push({ ...n.slice, name: n.name, key, ref: { jobId: n.jobId, revision: n.revision, sliceId: n.sliceId },
        x: Math.round(bounds.x), y: Math.round(bounds.y), w: Math.max(1, Math.round(bounds.w)), h: Math.max(1, Math.round(bounds.h)),
        rotation: ((Math.round(angle * 180 / Math.PI) % 360) + 360) % 360,
        flipX: Boolean(s.props.flipX), flipY: Boolean(s.props.flipY), opacity, hidden, children: [] });
    }
    if (!children.length) return null;
    if (children.length === 1 && own.length === 1 && !(n.children || []).length) return children[0];
    const x = Math.min(...children.map(c => c.x)), y = Math.min(...children.map(c => c.y));
    return { name: n.name, layerType: n.slice?.layerType || "component", x, y,
      w: Math.max(...children.map(c => c.x + c.w)) - x, h: Math.max(...children.map(c => c.y + c.h)) - y, children };
  }
  const root = walk(node);
  if (!root) throw new Error("所选节点没有可导出的画布图片");
  const ordered = [...orders].sort((a, b) => a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0).map(([key]) => key);
  function normalize(n, parentX, parentY) {
    const x = n.x, y = n.y;
    let ranks = n.ref ? [ordered.indexOf(n.key)] : n.children.flatMap(c => normalize(c, x, y));
    ranks.sort((a, b) => a - b);
    if (ranks.at(-1) - ranks[0] + 1 !== ranks.length) throw new Error("图层组与其他组交错叠放，请先在图层树整理顺序，再导出分组预设");
    n.order = ranks[0]; n.children.sort((a, b) => a.order - b.order);
    n.x -= parentX; n.y -= parentY;
    return ranks;
  }
  normalize(root, root.x, root.y);
  return { name: node.name, width: root.w, height: root.h, root };
}
