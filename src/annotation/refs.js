import { ANNOTATION_LABEL_POSITION, ANNOTATION_REF_MAX } from "./constants.js";

export { ANNOTATION_REF_MAX };

export function isAnnotationArrowMeta(meta = {}) {
  return meta.drawpaintAnnotationArrow === true || meta.cowartAnnotationArrow === true;
}

export function isAnnotationArrowShape(shape) {
  return shape?.type === "arrow" && isAnnotationArrowMeta(shape.meta);
}

/** Promote a plain arrow into an annotation arrow so ref dock / edit collect work. */
export function ensureAnnotationArrow(editor, shape) {
  if (!shape || shape.type !== "arrow") return false;
  if (isAnnotationArrowMeta(shape.meta)) return true;
  editor.updateShape({
    id: shape.id,
    type: "arrow",
    meta: {
      ...(shape.meta || {}),
      drawpaintAnnotationArrow: true,
      cowartAnnotationArrow: true,
    },
    props: {
      labelPosition: ANNOTATION_LABEL_POSITION,
      labelColor: shape.props?.labelColor || shape.props?.color,
    },
  });
  return true;
}

export function getAnnotationRefs(shape) {
  const refs = shape?.meta?.drawpaintAnnotationRefs;
  return Array.isArray(refs) ? refs : [];
}

export function createRefId() {
  return `aref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function updateAnnotationRefs(editor, arrowId, nextRefs) {
  const shape = editor.getShape(arrowId);
  if (!shape || !isAnnotationArrowShape(shape)) return;
  editor.updateShape({
    id: arrowId,
    type: "arrow",
    meta: {
      ...shape.meta,
      drawpaintAnnotationRefs: nextRefs.slice(0, ANNOTATION_REF_MAX),
      // keep label pinned while editing meta
      ...(shape.props?.labelPosition !== ANNOTATION_LABEL_POSITION
        ? {}
        : {}),
    },
  });
}

export function addAnnotationRef(editor, arrowId, ref) {
  const shape = editor.getShape(arrowId);
  if (!shape) throw new Error("标注箭头不存在");
  const current = getAnnotationRefs(shape);
  if (current.length >= ANNOTATION_REF_MAX) {
    throw new Error(`每个标注最多 ${ANNOTATION_REF_MAX} 张参考图`);
  }
  // de-dupe canvas shape
  if (ref.source === "canvas" && ref.shapeId) {
    if (current.some((r) => r.source === "canvas" && r.shapeId === ref.shapeId)) {
      throw new Error("该图片已挂在此标注上");
    }
  }
  updateAnnotationRefs(editor, arrowId, [
    ...current,
    { id: createRefId(), ...ref },
  ]);
}

export function removeAnnotationRef(editor, arrowId, refId) {
  const shape = editor.getShape(arrowId);
  if (!shape) return;
  updateAnnotationRefs(
    editor,
    arrowId,
    getAnnotationRefs(shape).filter((r) => r.id !== refId),
  );
}

/** Collect refs from annotation arrows included in an edit export. */
export function collectRefsFromShapeIds(editor, shapeIds) {
  const out = [];
  for (const id of shapeIds) {
    const shape = editor.getShape(id);
    if (!isAnnotationArrowShape(shape)) continue;
    for (const ref of getAnnotationRefs(shape)) {
      out.push({
        ...ref,
        arrowId: id,
        arrowText: String(shape.props?.text || "").trim() || null,
      });
    }
  }
  return out;
}

function assetSrcToRelativePath(src) {
  if (!src || typeof src !== "string") return null;
  const m = src.match(/\/api\/assets\/([^/?#]+)/);
  if (m) return `canvas/pages/default/assets/${m[1]}`;
  return null;
}

/**
 * Resolve annotation refs to uploaded local paths for the agent.
 * @returns {Promise<Array<{ arrowId, arrowText, source, relativePath, name }>>}
 */
export async function materializeAnnotationRefs(editor, refs, uploadAsset) {
  const results = [];
  for (const ref of refs) {
    if (ref.source === "upload" && ref.relativePath) {
      results.push({
        arrowId: ref.arrowId,
        arrowText: ref.arrowText,
        source: "upload",
        relativePath: ref.relativePath,
        name: ref.name || "upload",
        url: ref.url || null,
      });
      continue;
    }

    if (ref.source === "canvas" && ref.shapeId) {
      const imageShape = editor.getShape(ref.shapeId);
      if (!imageShape || imageShape.type !== "image") {
        continue;
      }
      const assetId = imageShape.props?.assetId;
      const asset = assetId ? editor.getAsset(assetId) : null;
      const src = asset?.props?.src;
      const existing = assetSrcToRelativePath(src);
      if (existing) {
        results.push({
          arrowId: ref.arrowId,
          arrowText: ref.arrowText,
          source: "canvas",
          relativePath: existing,
          name: asset?.props?.name || "canvas-image",
          shapeId: ref.shapeId,
        });
        continue;
      }
      if (src && String(src).startsWith("data:")) {
        const uploaded = await uploadAsset(
          src,
          asset?.props?.name || `annotation-ref-${ref.shapeId}.png`,
        );
        results.push({
          arrowId: ref.arrowId,
          arrowText: ref.arrowText,
          source: "canvas",
          relativePath: uploaded.relativePath,
          name: uploaded.relativePath.split("/").pop(),
          shapeId: ref.shapeId,
        });
        continue;
      }
      // last resort: try fetch url
      if (src) {
        try {
          const res = await fetch(src);
          const blob = await res.blob();
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          const uploaded = await uploadAsset(
            dataUrl,
            asset?.props?.name || `annotation-ref-${ref.shapeId}.png`,
          );
          results.push({
            arrowId: ref.arrowId,
            arrowText: ref.arrowText,
            source: "canvas",
            relativePath: uploaded.relativePath,
            name: uploaded.relativePath.split("/").pop(),
            shapeId: ref.shapeId,
          });
        } catch (error) {
          console.warn("[DrawPaint] failed to materialize canvas ref", ref, error);
        }
      }
    }
  }
  return results;
}

export function previewUrlForRef(editor, ref) {
  if (ref.source === "upload" && ref.url) return ref.url;
  if (ref.source === "canvas" && ref.shapeId) {
    const shape = editor.getShape(ref.shapeId);
    const assetId = shape?.props?.assetId;
    const asset = assetId ? editor.getAsset(assetId) : null;
    return asset?.props?.src || null;
  }
  return ref.url || null;
}
