/** Dedicated annotation tool id (Cowart: cowart-annotation). */
export const ANNOTATION_TOOL_ID = "drawpaint-annotation";
export const ANNOTATION_TOOL_LABEL = "标注";
export const ANNOTATION_EDIT_TOOL_LABEL = "按标注修改";

export const ANNOTATION_DEFAULT_COLOR = "red";
/** tldraw size style for stroke + label text (s/m/l/xl). Applied only when creating. */
export const ANNOTATION_DEFAULT_SIZE = "l";
/**
 * Mild scale boost at create time only (font ≈ size × scale).
 * Do not re-apply on select — that breaks the style panel size control.
 */
export const ANNOTATION_SCALE_BOOST = 1.25;
export const ANNOTATION_MIN_LENGTH = 8;
export const ANNOTATION_BEND_RATIO = 0.12;
export const ANNOTATION_MIN_BEND = 16;
export const ANNOTATION_MAX_BEND = 48;
/** 0 = arrow tail / start (Cowart ANNOTATION_LABEL_POSITION). */
export const ANNOTATION_LABEL_POSITION = 0;

export const ANNOTATION_EDIT_EXPORT_PADDING = 32;
export const ANNOTATION_EDIT_NEAR_MARGIN_MIN = 160;
export const ANNOTATION_EDIT_NEAR_MARGIN_MAX = 720;
export const ANNOTATION_EDIT_RELATED_TEXT_MARGIN = 120;
export const ANNOTATION_EDIT_STATUS_RESET_MS = 2200;

export const ANNOTATION_EDIT_COLORS = new Set(["red", "yellow", "orange"]);

export const ANNOTATION_EDIT_PROMPT = [
  "Make precise local edits based on the DrawPaint annotation screenshot (inpainting / component replacement).",
  "",
  "The screenshot contains the current image and nearby annotation arrows and text.",
  "- Treat annotation text as editing requirements.",
  "- If annotation/element references are provided, composite their content at the arrow targets while preserving the source image style.",
  "- Do not render annotation arrows, annotation text, selection outlines or tool UI in the result.",
  "- Preserve the source subject and style; place the new image beside the original.",
].join("\n");

export const ANNOTATION_REF_MAX = 10;