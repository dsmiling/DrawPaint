import { exportToBlob } from "tldraw";
import {
  ANNOTATION_EDIT_EXPORT_PADDING,
  ANNOTATION_EDIT_PROMPT,
} from "./constants.js";
import {
  collectAnnotationEditShapeIds,
  expandBox,
  unionPageBounds,
} from "./collect.js";
import {
  collectRefsFromShapeIds,
  materializeAnnotationRefs,
} from "./refs.js";

function getAnnotationEditExportPixelRatio(bounds) {
  const maxDimension = Math.max(bounds.w, bounds.h);
  if (maxDimension > 1600) return 1;
  if (maxDimension > 1000) return 1.5;
  return 2;
}

function annotationEditScreenshotFileName() {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `annotation-edit-${timestamp}.png`;
}

export function buildAnnotationEditPrompt({
  imageShapeId,
  shapeIds,
  exportWidth,
  exportHeight,
  screenshotRelativePath,
  elementRefs = [],
}) {
  const annotationCount = Math.max(0, shapeIds.length - 1);
  const refLines =
    elementRefs.length === 0
      ? ["（无标注参考图；仅按截图中的箭头与文字修改）"]
      : [
          "以下参考图是「要放入标注位置的元素/内容」。请把对应内容合成到截图中箭头指向处：",
          ...elementRefs.map((r, i) => {
            const where = r.arrowText ? `（箭头文字「${r.arrowText}」）` : "";
            return `${i + 1}. [${r.source}] ${r.relativePath} ${where} arrow=${r.arrowId}`;
          }),
        ];

  return [
    ANNOTATION_EDIT_PROMPT,
    "",
    `DrawPaint source image shape: ${imageShapeId}`,
    `Included annotation shapes: ${annotationCount}`,
    `Screenshot size: ${Math.round(exportWidth)}x${Math.round(exportHeight)}`,
    `Annotation screenshot local path: ${screenshotRelativePath}`,
    "Use this local screenshot file as the authoritative visual reference for WHERE to edit.",
    "",
    "## 标注参考图 / 元素参考（WHAT to place）",
    ...refLines,
    "",
    "插入时用 insert_drawpaint_image：",
    `- anchorShapeId: "${imageShapeId}"`,
    "- placement: right, margin: 40, matchAnchor: true",
    "- replaceAiImageHolder: false",
    "不要删除或移动原图与标注；把干净新图放到原图右侧。",
    "最后 clear_drawpaint_pending_request。",
  ].join("\n");
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("截图读取失败"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Export image + nearby annotations, upload screenshot, materialize element refs.
 */
export async function prepareAnnotationEditRequest(editor, imageShapeId, {
  uploadAsset,
}) {
  const shapeIds = collectAnnotationEditShapeIds(editor, imageShapeId);
  const rawBounds = unionPageBounds(editor, shapeIds);
  if (!rawBounds) throw new Error("无法计算截图范围。");

  const exportBounds = expandBox(rawBounds, ANNOTATION_EDIT_EXPORT_PADDING);
  const pixelRatio = getAnnotationEditExportPixelRatio(exportBounds);

  let blob;
  try {
    blob = await exportToBlob({
      editor,
      ids: shapeIds,
      format: "png",
      opts: {
        background: true,
        padding: 0,
        bounds: exportBounds,
        pixelRatio,
      },
    });
  } catch (error) {
    console.warn("[DrawPaint] export with bounds failed, fallback:", error);
    blob = await exportToBlob({
      editor,
      ids: shapeIds,
      format: "png",
      opts: {
        background: true,
        padding: ANNOTATION_EDIT_EXPORT_PADDING,
        pixelRatio,
      },
    });
  }

  if (!blob) throw new Error("截图导出失败（空结果）。");

  const dataUrl = await blobToDataUrl(blob);
  const uploaded = await uploadAsset(dataUrl, annotationEditScreenshotFileName());
  if (!uploaded?.relativePath) {
    throw new Error("标注截图上传失败。");
  }

  const rawRefs = collectRefsFromShapeIds(editor, shapeIds);
  const elementRefs = await materializeAnnotationRefs(editor, rawRefs, uploadAsset);

  const fullPrompt = buildAnnotationEditPrompt({
    imageShapeId,
    shapeIds,
    exportWidth: exportBounds.w * pixelRatio,
    exportHeight: exportBounds.h * pixelRatio,
    screenshotRelativePath: uploaded.relativePath,
    elementRefs,
  });

  return {
    shapeIds,
    imageShapeId,
    screenshotRelativePath: uploaded.relativePath,
    fullPrompt,
    annotationCount: Math.max(0, shapeIds.length - 1),
    elementRefs,
    referencePaths: elementRefs.map((r) => r.relativePath),
  };
}
