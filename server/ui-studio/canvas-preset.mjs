import { componentMetadata } from "../../shared/ui-schema.mjs";

export function buildCanvasPreset(service, id, input) {
  const owner = service.get(id), value = input.canvas;
  if (owner.status !== "ready" || owner.revision !== input.revision) throw new Error("所选素材版本已变化，请重新导出");
  if (!value || !Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 1 || value.height < 1 || value.width * value.height > 16777216) throw new Error("画布预设尺寸无效或过大");
  let count = 0, area = 0;
  function walk(n, parentWidth, parentHeight, depth) {
    if (!n || ++count > 500 || depth > 24) throw new Error("预设层级或节点数量超限");
    if (![n.x, n.y, n.w, n.h].every(Number.isInteger) || n.x < 0 || n.y < 0 || n.w < 1 || n.h < 1 || n.x + n.w > parentWidth || n.y + n.h > parentHeight) throw new Error("预设图层超出父节点范围");
    if (!Array.isArray(n.children)) throw new Error("预设缺少有效子节点");
    const result = { ...componentMetadata(n), name: String(n.name || "未命名图层").slice(0, 120), x: n.x, y: n.y, w: n.w, h: n.h, children: [] };
    if (n.ref) {
      if (n.children.length) throw new Error("图片图层不能同时包含子节点");
      const source = service.get(n.ref.jobId);
      if (source.status !== "ready" || source.revision !== n.ref.revision) throw new Error("画布组件来源版本已变化，请刷新后重新导出");
      const slice = source.slices?.find(s => s.id === n.ref.sliceId);
      if (!slice) throw new Error("画布组件来源不存在");
      if (![0, 90, 180, 270].includes(n.rotation || 0) || !Number.isFinite(n.opacity ?? 1) || (n.opacity ?? 1) < 0 || (n.opacity ?? 1) > 1) throw new Error("图层旋转或透明度无效");
      area += n.w * n.h;
      if (area > 33554432) throw new Error("图层总面积过大，请拆成组件导出");
      Object.assign(result, { jobId: source.id, revision: source.revision, imageFile: slice.file,
        rotation: n.rotation || 0, flipX: Boolean(n.flipX), flipY: Boolean(n.flipY), hidden: Boolean(n.hidden), opacity: n.opacity ?? 1 });
    } else {
      if (!n.children.length) throw new Error("空图层组不能导出");
      result.children = n.children.map(c => walk(c, n.w, n.h, depth + 1));
    }
    return result;
  }
  const root = walk(value.root, value.width, value.height, 0);
  if (root.x !== 0 || root.y !== 0 || root.w !== value.width || root.h !== value.height) throw new Error("预设根节点尺寸不匹配");
  return { schema: "drawpaint.ui-preset.v1", variant: "canvas", name: root.name, width: value.width, height: value.height, root };
}
