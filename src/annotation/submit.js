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
      ? ["(No annotation reference images; edit using the screenshot arrows and text only.)"]
      : [
          "These references show the elements/content to place at annotated locations. Composite the corresponding content at the arrow targets:",
          ...elementRefs.map((r, i) => {
            const where = r.arrowText ? `(arrow text: ${r.arrowText})` : "";
            const path =
              r.filePath || r.absolutePath || r.relativePath || "(missing path)";
            return `${i + 1}. [${r.source}] ${path} ${where} arrow=${r.arrowId}`;
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
    "## Annotation / element references (WHAT to place)",
    ...refLines,
    "",
    "Insert using insert_drawpaint_image:",
    `- anchorShapeId: "${imageShapeId}"`,
    "- placement: right, margin: 40, matchAnchor: true",
    "- replaceAiImageHolder: false",
    "Do not delete or move the original image or annotations; place the clean new image to the right of the original.",
    "Finally, call clear_drawpaint_pending_request.",
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
  const baseShapeIds = collectAnnotationEditShapeIds(editor, imageShapeId);

  // Explicit dock refs + inferred from arrow start binding / proximity (exclude edit target).
  // Do NOT persist inferred refs onto the arrow — that suddenly adds pin thumbs after submit.
  const rawRefs = collectRefsFromShapeIds(editor, baseShapeIds, {
    excludeShapeIds: [imageShapeId],
    persistInferred: false,
  });
  const refImageIds = rawRefs
    .filter((r) => r.source === "canvas" && r.shapeId && r.shapeId !== imageShapeId)
    .map((r) => r.shapeId);
  const shapeIds = Array.from(new Set([...baseShapeIds, ...refImageIds]));

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
