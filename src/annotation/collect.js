import { Box } from "tldraw";
import {
  ANNOTATION_EDIT_COLORS,
  ANNOTATION_EDIT_NEAR_MARGIN_MAX,
  ANNOTATION_EDIT_NEAR_MARGIN_MIN,
  ANNOTATION_EDIT_RELATED_TEXT_MARGIN,
} from "./constants.js";

export function isImageShape(shape) {
  return shape?.type === "image";
}

export function isAnnotationArrowShape(shape) {
  if (shape?.type !== "arrow") return false;
  const meta = shape.meta || {};
  if (meta.drawpaintAnnotationArrow === true || meta.cowartAnnotationArrow === true) {
    return true;
  }
  return shapeHasAnnotationColor(shape);
}

export function isAnnotationTextShape(shape) {
  if (shape?.type !== "text") return false;
  const meta = shape.meta || {};
  if (meta.drawpaintAnnotationText === true || meta.cowartAnnotationText === true) {
    return true;
  }
  return shapeHasAnnotationColor(shape);
}

function shapeHasAnnotationColor(shape) {
  const color = shape?.props?.color;
  const labelColor = shape?.props?.labelColor;
  return ANNOTATION_EDIT_COLORS.has(color) || ANNOTATION_EDIT_COLORS.has(labelColor);
}

export function expandBox(bounds, padding) {
  return new Box(
    bounds.x - padding,
    bounds.y - padding,
    bounds.w + padding * 2,
    bounds.h + padding * 2,
  );
}

export function annotationEditNearMargin(targetBounds) {
  return Math.min(
    ANNOTATION_EDIT_NEAR_MARGIN_MAX,
    Math.max(ANNOTATION_EDIT_NEAR_MARGIN_MIN, Math.max(targetBounds.w, targetBounds.h)),
  );
}

function uniqueShapeIds(shapeIds) {
  return Array.from(new Set(shapeIds.filter(Boolean)));
}

/**
 * Cowart collectAnnotationEditShapeIds:
 * target image + nearby annotation arrows + related text.
 */
export function collectAnnotationEditShapeIds(editor, imageShapeId) {
  const targetShape = editor.getShape(imageShapeId);
  if (!isImageShape(targetShape)) {
    throw new Error("请选择一张图片后再按标注修改。");
  }

  const targetBounds = editor.getShapePageBounds(imageShapeId);
  if (!targetBounds) {
    throw new Error("无法读取当前图片的画布位置。");
  }

  const nearBounds = expandBox(targetBounds, annotationEditNearMargin(targetBounds));
  const relatedArrowIds = [];
  const relatedArrowBounds = [];
  const relatedTextIds = [];

  for (const shape of editor.getCurrentPageShapesSorted()) {
    if (!shape || shape.id === imageShapeId) continue;
    const bounds = editor.getShapePageBounds(shape);
    if (!bounds) continue;

    if (isAnnotationArrowShape(shape) && nearBounds.collides(bounds)) {
      relatedArrowIds.push(shape.id);
      relatedArrowBounds.push(bounds);
      continue;
    }

    if (!isAnnotationTextShape(shape)) continue;

    if (nearBounds.collides(bounds)) {
      relatedTextIds.push(shape.id);
      continue;
    }

    if (
      relatedArrowBounds.some((arrowBounds) =>
        expandBox(arrowBounds, ANNOTATION_EDIT_RELATED_TEXT_MARGIN).collides(bounds),
      )
    ) {
      relatedTextIds.push(shape.id);
    }
  }

  return uniqueShapeIds([imageShapeId, ...relatedArrowIds, ...relatedTextIds]);
}

export function unionPageBounds(editor, shapeIds) {
  let union = null;
  for (const id of shapeIds) {
    const b = editor.getShapePageBounds(id);
    if (!b) continue;
    union = union ? union.union(b) : b.clone();
  }
  return union;
}
