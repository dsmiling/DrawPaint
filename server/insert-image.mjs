import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  assetsDir,
  pendingInsertsPath,
  readJson,
  selectionPath,
  snapshotPath,
  writeJson,
} from "./storage.mjs";

function isAiImageHolderRecord(record) {
  if (!record || record.typeName !== "shape" || record.type !== "frame") return false;
  const meta = record.meta || {};
  return meta.drawpaintAiImageHolder === true || meta.cowartAiImageHolder === true;
}

function collectDescendantIds(store, rootId) {
  const ids = [];
  for (const [id, record] of Object.entries(store || {})) {
    if (record?.typeName === "shape" && record.parentId === rootId) {
      ids.push(id, ...collectDescendantIds(store, id));
    }
  }
  return ids;
}

function nextIndex(store, parentId) {
  const siblings = Object.values(store || {}).filter(
    (r) => r?.typeName === "shape" && r.parentId === parentId,
  );
  if (siblings.length === 0) return "a1";
  const last = siblings
    .map((s) => s.index || "a0")
    .sort()
    .at(-1);
  // crude fractional bump: append '0' style — good enough for MCP inserts
  return `${last}V`;
}

function findPageId(store) {
  const page = Object.values(store || {}).find((r) => r?.typeName === "page");
  return page?.id || "page:page";
}

function getShapeBounds(shape) {
  return {
    x: shape.x || 0,
    y: shape.y || 0,
    w: shape.props?.w || 512,
    h: shape.props?.h || 512,
    rotation: shape.rotation || 0,
    parentId: shape.parentId,
  };
}

function overlaps(a, b, margin = 0) {
  return !(
    a.x + a.w + margin <= b.x ||
    b.x + b.w + margin <= a.x ||
    a.y + a.h + margin <= b.y ||
    b.y + b.h + margin <= a.y
  );
}

function placeBeside(store, anchor, placement = "right", margin = 40, size) {
  const pageShapes = Object.values(store || {}).filter((r) => r?.typeName === "shape");
  let x = anchor.x;
  let y = anchor.y;
  if (placement === "left") x = anchor.x - size.w - margin;
  else if (placement === "below") y = anchor.y + anchor.h + margin;
  else x = anchor.x + anchor.w + margin;

  const candidate = { x, y, w: size.w, h: size.h };
  let guard = 0;
  while (guard < 40) {
    const hit = pageShapes.some((s) => {
      if (s.type !== "image" && s.type !== "frame") return false;
      const b = getShapeBounds(s);
      return overlaps(candidate, b, 8);
    });
    if (!hit) break;
    if (placement === "below") candidate.y += size.h + margin;
    else if (placement === "left") candidate.x -= size.w + margin;
    else candidate.x += size.w + margin;
    guard += 1;
  }
  return { x: candidate.x, y: candidate.y };
}

/**
 * Insert image into snapshot + queue live pending-insert for open canvas.
 */
export function insertDrawpaintImage(canvasDir, args = {}) {
  const snap = readJson(snapshotPath(canvasDir), null);
  if (!snap?.document?.store) {
    throw new Error("No canvas snapshot yet. Open the DrawPaint canvas and save once first.");
  }

  const store = { ...snap.document.store };
  const selection = readJson(selectionPath(canvasDir), { shapes: [] });
  const abs = path.isAbsolute(args.imagePath)
    ? args.imagePath
    : path.resolve(args.imagePath);
  if (!fs.existsSync(abs)) throw new Error(`Image not found: ${abs}`);

  const ext = path.extname(abs).toLowerCase() || ".png";
  const dir = assetsDir(canvasDir, "default");
  fs.mkdirSync(dir, { recursive: true });
  const fileName = args.fileName || `${Date.now()}-agent${ext}`;
  const dest = path.join(dir, path.basename(fileName.endsWith(ext) ? fileName : `${fileName}${ext}`));
  fs.copyFileSync(abs, dest);
  const assetFile = path.basename(dest);
  const relativePath = `canvas/pages/default/assets/${assetFile}`;
  const url = `/api/assets/${assetFile}`;

  const anchorId =
    args.anchorShapeId ||
    args.sourceShapeId ||
    selection.shapes?.[0]?.id ||
    null;
  const anchor = anchorId ? store[anchorId] : null;
  const anchorIsHolder = isAiImageHolderRecord(anchor);
  const replaceHolder =
    anchorIsHolder && args.replaceAiImageHolder !== false;

  let displayW = args.displayWidth;
  let displayH = args.displayHeight;
  let x;
  let y;
  let rotation = 0;
  let parentId = findPageId(store);

  if (replaceHolder && anchor) {
    const b = getShapeBounds(anchor);
    x = b.x;
    y = b.y;
    rotation = b.rotation;
    parentId = b.parentId || parentId;
    displayW = b.w;
    displayH = b.h;
  } else if (anchor && args.matchAnchor !== false) {
    const b = getShapeBounds(anchor);
    displayW = displayW || b.w;
    displayH = displayH || b.h;
    const placed = placeBeside(
      store,
      b,
      args.placement || "right",
      args.margin ?? 40,
      { w: displayW, h: displayH },
    );
    x = placed.x;
    y = placed.y;
    parentId = b.parentId || parentId;
  } else {
    displayW = displayW || 512;
    displayH = displayH || 512;
    x = 100;
    y = 100;
  }

  const assetId = `asset:${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const shapeId = `shape:${randomUUID().replace(/-/g, "").slice(0, 16)}`;

  // Probe natural size if not provided — keep display size from anchor when replacing
  let naturalW = displayW;
  let naturalH = displayH;

  store[assetId] = {
    id: assetId,
    type: "image",
    typeName: "asset",
    props: {
      name: assetFile,
      src: url,
      w: naturalW,
      h: naturalH,
      mimeType: ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png",
      isAnimated: false,
    },
    meta: {
      ...(args.assetMeta || {}),
    },
  };

  const shapeMeta = {
    ...(args.shapeMeta || {}),
  };
  if (replaceHolder && anchorId) {
    shapeMeta.drawpaintGeneratedForAiImageHolder = anchorId;
    shapeMeta.drawpaintReplacedAiImageHolder = true;
  } else if (args.annotationScreenshot) {
    shapeMeta.drawpaintGeneratedFromAnnotationEdit = true;
    if (anchorId) shapeMeta.drawpaintAnnotationSourceShapeId = anchorId;
    shapeMeta.drawpaintAnnotationScreenshot = args.annotationScreenshot;
  } else {
    shapeMeta.drawpaintGeneratedStandalone = true;
  }

  if (replaceHolder && anchorId) {
    const removeIds = [anchorId, ...collectDescendantIds(store, anchorId)];
    for (const id of removeIds) delete store[id];
  }

  store[shapeId] = {
    x,
    y,
    rotation,
    isLocked: false,
    opacity: 1,
    meta: shapeMeta,
    id: shapeId,
    type: "image",
    props: {
      w: displayW,
      h: displayH,
      assetId,
      playing: true,
      url: "",
      crop: null,
      flipX: false,
      flipY: false,
      altText: args.altText || "",
    },
    parentId,
    index: nextIndex(store, parentId),
    typeName: "shape",
  };

  writeJson(snapshotPath(canvasDir), {
    ...snap,
    document: {
      ...snap.document,
      store,
    },
    updatedAt: new Date().toISOString(),
  });

  const pendingItem = {
    id: randomUUID(),
    type: "insert_image",
    url,
    relativePath,
    replaceAiImageHolder: Boolean(replaceHolder),
    replaceSelected: Boolean(replaceHolder),
    anchorShapeId: anchorId,
    x,
    y,
    w: displayW,
    h: displayH,
    rotation,
    parentId,
    prompt: args.altText || "",
    createdAt: new Date().toISOString(),
    // Signal open canvas to reload snapshot for consistency
    reloadSnapshot: true,
  };
  const pending = readJson(pendingInsertsPath(canvasDir), []);
  pending.push(pendingItem);
  writeJson(pendingInsertsPath(canvasDir), pending);

  return {
    assetId,
    shapeId,
    relativePath,
    url,
    bounds: { x, y, w: displayW, h: displayH },
    replacedHolder: Boolean(replaceHolder),
    anchorShapeId: anchorId,
    pendingItemId: pendingItem.id,
  };
}

export function enrichSelection(selection) {
  const shapes = (selection?.shapes || []).map((s) => ({
    ...s,
    isAiImageHolder:
      s.type === "frame" &&
      (s.meta?.drawpaintAiImageHolder === true ||
        s.meta?.cowartAiImageHolder === true ||
        s.props?.name === "AI 图片"),
  }));
  return { ...selection, shapes };
}
