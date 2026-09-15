import {
  ANNOTATION_DEFAULT_SIZE,
  ANNOTATION_LABEL_POSITION,
  ANNOTATION_REF_MAX,
} from "./constants.js";
import { isImageShape } from "./collect.js";
import { getAnnotationScale } from "./scale.js";

export { ANNOTATION_REF_MAX };

/** One-shot marker: after v2, we never rewrite size/scale on select. */
const SCALE_V2_META = "drawpaintAnnotationScaleV2";

export function isAnnotationArrowMeta(meta = {}) {
  return meta.drawpaintAnnotationArrow === true || meta.cowartAnnotationArrow === true;
}

export function isAnnotationArrowShape(shape) {
  return shape?.type === "arrow" && isAnnotationArrowMeta(shape.meta);
}

/** Promote a plain arrow into an annotation arrow so ref dock / edit collect work. */
export function ensureAnnotationArrow(editor, shape) {
  if (!shape || shape.type !== "arrow") return false;
  if (isAnnotationArrowMeta(shape.meta)) {
    // Only pin label placement/color — never keep rewriting size/scale (style panel must work).
    const props = {};
    const meta = { ...(shape.meta || {}) };
    let metaChanged = false;

    if (shape.props?.labelPosition !== ANNOTATION_LABEL_POSITION) {
      props.labelPosition = ANNOTATION_LABEL_POSITION;
    }
    const labelColor = shape.props?.labelColor || shape.props?.color;
    if (shape.props?.labelColor !== labelColor) {
      props.labelColor = labelColor;
    }

    // Roll back the previous too-aggressive boost once, then leave size/scale alone.
    if (meta[SCALE_V2_META] !== true) {
      props.size = ANNOTATION_DEFAULT_SIZE;
      props.scale = getAnnotationScale(editor);
      meta[SCALE_V2_META] = true;
      metaChanged = true;
    }

    if (Object.keys(props).length || metaChanged) {
      editor.updateShape({
        id: shape.id,
        type: "arrow",
        ...(metaChanged ? { meta } : {}),
        ...(Object.keys(props).length ? { props } : {}),
      });
    }
    return true;
  }
  editor.updateShape({
    id: shape.id,
    type: "arrow",
    meta: {
      ...(shape.meta || {}),
      drawpaintAnnotationArrow: true,
      cowartAnnotationArrow: true,
      [SCALE_V2_META]: true,
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
  if (!isAnnotationArrowShape(shape)) {
    ensureAnnotationArrow(editor, shape);
  }
  const current = getAnnotationRefs(editor.getShape(arrowId) || shape);
  if (current.length >= ANNOTATION_REF_MAX) {
    throw new Error(`每个标注最多 ${ANNOTATION_REF_MAX} 张参考图`);
  }
  // de-dupe canvas shape
  if (ref.source === "canvas" && ref.shapeId) {
    if (current.some((r) => r.source === "canvas" && r.shapeId === ref.shapeId)) {
      throw new Error("该图片已挂在此标注上");
    }
  }
  // de-dupe upload by relativePath / url
  if (ref.source === "upload") {
    const key = ref.relativePath || ref.url || ref.filePath;
    if (
      key &&
      current.some(
        (r) =>
          r.source === "upload" &&
          (r.relativePath === key || r.url === key || r.filePath === key),
      )
    ) {
      throw new Error("该上传图已挂在此标注上");
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

/**
 * Infer "WHAT to place" images from an annotation arrow:
 * 1) arrow start binding to an image (most common: drag from ref → target)
 * 2) fallback: image whose bounds contain the arrow start point
 *
 * Never returns the edit target image (excludeShapeIds).
 */
export function inferCanvasRefsForArrow(editor, arrowShape, excludeShapeIds = new Set()) {
  if (!editor || arrowShape?.type !== "arrow") return [];
  const inferred = [];
  const seen = new Set();

  const pushImage = (shape) => {
    if (!isImageShape(shape)) return;
    if (excludeShapeIds.has(shape.id) || seen.has(shape.id)) return;
    seen.add(shape.id);
    inferred.push({
      source: "canvas",
      shapeId: shape.id,
      name: shape.props?.altText || "canvas-image",
      inferred: true,
    });
  };

  try {
    const bindings =
      editor.getBindingsFromShape?.(arrowShape, "arrow") ||
      editor.getBindingsFromShape?.(arrowShape.id, "arrow") ||
      [];
    for (const binding of bindings) {
      // start = tail / label side = reference content; end = tip = edit location
      if (binding?.props?.terminal !== "start") continue;
      pushImage(editor.getShape(binding.toId));
    }
  } catch {
    // older editors without bindings API
  }

  if (inferred.length > 0) return inferred;

  try {
    const transform = editor.getShapePageTransform(arrowShape);
    if (!transform) return inferred;
    const start = transform.applyToPoint(arrowShape.props.start);
    for (const shape of editor.getCurrentPageShapes()) {
      if (!isImageShape(shape) || excludeShapeIds.has(shape.id) || seen.has(shape.id)) {
        continue;
      }
      const bounds = editor.getShapePageBounds(shape);
      if (!bounds) continue;
      const pad = Math.max(48, Math.min(bounds.w, bounds.h) * 0.12);
      if (
        start.x >= bounds.x - pad &&
        start.x <= bounds.x + bounds.w + pad &&
        start.y >= bounds.y - pad &&
        start.y <= bounds.y + bounds.h + pad
      ) {
        pushImage(shape);
      }
    }
  } catch {
    // ignore geometry failures
  }

  return inferred;
}

/**
 * Collect explicit + inferred element refs from annotation arrows in an edit export.
 * @param {object} [options]
 * @param {Iterable<string>} [options.excludeShapeIds] shapes that must not become refs (edit target)
 * @param {boolean} [options.persistInferred] write inferred canvas refs onto arrow meta (pins / next submit)
 */
export function collectRefsFromShapeIds(editor, shapeIds, options = {}) {
  const excludeShapeIds = new Set(options.excludeShapeIds || []);
  const persistInferred = options.persistInferred === true;
  const out = [];

  for (const id of shapeIds) {
    const shape = editor.getShape(id);
    if (shape?.type !== "arrow") continue;

    const arrowText = String(shape.props?.text || "").trim() || null;
    const explicit = getAnnotationRefs(shape);
    const seenCanvas = new Set(
      explicit.filter((r) => r.source === "canvas" && r.shapeId).map((r) => r.shapeId),
    );

    for (const ref of explicit) {
      out.push({ ...ref, arrowId: id, arrowText });
    }

    const inferred = inferCanvasRefsForArrow(
      editor,
      shape,
      new Set([...excludeShapeIds, ...seenCanvas]),
    );
    for (const ref of inferred) {
      if (persistInferred) {
        try {
          addAnnotationRef(editor, id, {
            source: "canvas",
            shapeId: ref.shapeId,
            name: ref.name,
          });
        } catch {
          // duplicate / capacity — still include in this submit
        }
      }
      out.push({
        id: ref.id || `inferred-${ref.shapeId}`,
        ...ref,
        arrowId: id,
        arrowText,
      });
      if (ref.shapeId) seenCanvas.add(ref.shapeId);
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
    if (ref.source === "upload") {
      let relativePath = ref.relativePath || null;
      let filePath = ref.filePath || null;
      let url = ref.url || null;

      // Recover relativePath from /api/assets/... url if meta was partial.
      if (!relativePath && url) {
        relativePath = assetSrcToRelativePath(url);
      }
      if (!relativePath && filePath) {
        const base = String(filePath).split(/[/\\]/).pop();
        if (base) relativePath = `canvas/pages/default/assets/${base}`;
      }

      // If only url remains, re-upload so the agent always gets a local asset path.
      if (!relativePath && url && uploadAsset) {
        try {
          const res = await fetch(url);
          const blob = await res.blob();
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          const uploaded = await uploadAsset(
            dataUrl,
            ref.name || "annotation-ref-upload.png",
          );
          relativePath = uploaded.relativePath;
          filePath = uploaded.filePath || filePath;
          url = uploaded.url || url;
        } catch (error) {
          console.warn("[DrawPaint] failed to rematerialize upload ref", ref, error);
        }
      }

      if (!relativePath && !filePath) {
        console.warn("[DrawPaint] skip upload ref without path", ref);
        continue;
      }

      results.push({
        arrowId: ref.arrowId,
        arrowText: ref.arrowText,
        source: "upload",
        relativePath: relativePath || null,
        filePath: filePath || null,
        name: ref.name || "upload",
        url: url || null,
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
