/** Dedicated annotation tool id (Cowart: cowart-annotation). */
export const ANNOTATION_TOOL_ID = "drawpaint-annotation";
export const ANNOTATION_TOOL_LABEL = "标注";
export const ANNOTATION_EDIT_TOOL_LABEL = "按标注修改";

export const ANNOTATION_DEFAULT_COLOR = "red";
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
  "请根据 DrawPaint 标注截图做精准局部修改（inpainting / 组件替换）。",
  "",
  "截图包含当前图片以及图片附近的标注箭头和标注文字。",
  "- 把标注文字当作修改要求。",
  "- 若提供了「标注参考图 / 元素参考」，把参考图中的元素/内容合成到箭头指向的位置（保持图1主体风格）。",
  "- 不要把标注箭头、标注文字、选区框或工具 UI 画进结果图。",
  "- 保留原图主体与风格；把新图放到原图旁边。",
].join("\n");

export const ANNOTATION_REF_MAX = 10;