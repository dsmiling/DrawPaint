/** Rough arrow-label font sizes (mirrors tldraw ARROW_LABEL_FONT_SIZES). */
const LABEL_FONT = { s: 18, m: 20, l: 24, xl: 28 };

/**
 * Screen point just below an annotation arrow's label (tail / start).
 * Coordinates match `editor.pageToViewport` (viewport of the canvas).
 */
export function getAnnotationRefPinAnchor(editor, shape) {
  if (!editor || !shape || shape.type !== "arrow") return null;
  const transform = editor.getShapePageTransform(shape);
  if (!transform) return null;

  const pageStart = transform.applyToPoint(shape.props.start);
  const scale = shape.props.scale || 1;
  const fontSize = (LABEL_FONT[shape.props.size] || 20) * scale;
  const lines = Math.max(1, String(shape.props.text || " ").split("\n").length);
  // Label is centered on the path point; place pins under its bottom edge.
  const labelHalfH = (fontSize * 1.35 * lines + 10 * scale) / 2;
  return editor.pageToViewport({
    x: pageStart.x,
    y: pageStart.y + labelHalfH + 6 * scale,
  });
}

export function getAnnotationRefPinThumbSize(editor) {
  const z = editor?.getZoomLevel?.() || 1;
  return Math.round(Math.min(64, Math.max(28, 44 * z)));
}
