import { createShapeId } from "tldraw";

export const AI_IMAGE_HOLDER_LABEL = "AI 图片";

export const AI_IMAGE_ASPECT_PRESETS = [
  { id: "1-1", label: "1:1", w: 512, h: 512 },
  { id: "3-2", label: "3:2", w: 768, h: 512 },
  { id: "2-3", label: "2:3", w: 512, h: 768 },
  { id: "4-3", label: "4:3", w: 683, h: 512 },
  { id: "3-4", label: "3:4", w: 512, h: 683 },
  { id: "16-9", label: "16:9", w: 1024, h: 576 },
  { id: "9-16", label: "9:16", w: 576, h: 1024 },
];

export function getAiImageHolderMeta() {
  return {
    drawpaintAiImageHolder: true,
    drawpaintAiImageHolderVersion: 1,
    // Cowart-compatible alias for ported workflows / imported canvases
    cowartAiImageHolder: true,
  };
}

export function isAiImageHolderShape(shape) {
  if (!shape || shape.type !== "frame") return false;
  const meta = shape.meta || {};
  return meta.drawpaintAiImageHolder === true || meta.cowartAiImageHolder === true;
}

export function reduceAspectRatio(w, h) {
  const width = Math.round(Number(w) || 0);
  const height = Math.round(Number(h) || 0);
  if (width <= 0 || height <= 0) return { label: "unknown", decimal: 1 };
  const preset = AI_IMAGE_ASPECT_PRESETS.find(
    (p) => Math.abs(p.w / p.h - width / height) < 0.02,
  );
  if (preset) {
    return { label: preset.label, decimal: width / height, presetId: preset.id };
  }
  return { label: `${width}:${height}`, decimal: width / height };
}

export function createAiImageHolderShape(editor, id, shapeOverrides = {}) {
  const preset = AI_IMAGE_ASPECT_PRESETS.find((p) => p.id === "1-1") || AI_IMAGE_ASPECT_PRESETS[0];
  const w = shapeOverrides.w ?? preset.w;
  const h = shapeOverrides.h ?? preset.h;
  const { x, y, rotation, parentId, ...rest } = shapeOverrides;

  editor.createShape({
    id,
    type: "frame",
    x: x ?? 0,
    y: y ?? 0,
    rotation: rotation ?? 0,
    parentId,
    meta: {
      ...getAiImageHolderMeta(),
      ...(rest.meta || {}),
    },
    props: {
      w,
      h,
      name: AI_IMAGE_HOLDER_LABEL,
      ...(rest.props || {}),
    },
  });
  return id;
}

export function createAiImageHolderAtViewportCenter(editor, presetId = "1-1") {
  const preset =
    AI_IMAGE_ASPECT_PRESETS.find((p) => p.id === presetId) || AI_IMAGE_ASPECT_PRESETS[0];
  const bounds = editor.getViewportPageBounds();
  const id = createShapeId();
  createAiImageHolderShape(editor, id, {
    x: bounds.midX - preset.w / 2,
    y: bounds.midY - preset.h / 2,
    w: preset.w,
    h: preset.h,
  });
  editor.select(id);
  return id;
}

export function summarizeHolderForRequest(shape) {
  if (!isAiImageHolderShape(shape)) return null;
  const w = shape.props?.w ?? 0;
  const h = shape.props?.h ?? 0;
  const aspect = reduceAspectRatio(w, h);
  return {
    anchorShapeId: shape.id,
    isAiImageHolder: true,
    targetWidth: w,
    targetHeight: h,
    targetAspectRatio: aspect.label,
    targetAspectDecimal: aspect.decimal,
  };
}
