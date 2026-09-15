import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic.mjs";

export function readSnapshot(root) {
  const file = path.join(root, "snapshot.json");
  if (!fs.existsSync(file)) return { document: null, revision: 0 };
  // A damaged snapshot must never be mistaken for a new, empty canvas.
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value?.document?.store || typeof value.document.store !== "object" || Array.isArray(value.document.store)) throw new Error("已保存的画布结构不完整，已暂停加载和覆盖，请从备份恢复");
  return { ...value, revision: value.revision || 0 };
}

export function saveSnapshot(root, value) {
  const previous = readSnapshot(root);
  if (previous.document && value.baseRevision !== previous.revision) {
    const error = new Error("其他窗口已保存新版画布。已暂停本窗口保存，防止覆盖素材；请先备份当前画布，再加载最新版本。");
    error.status = 409; throw error;
  }
  if (!value.document?.store || typeof value.document.store !== "object" || Array.isArray(value.document.store)) throw new Error("画布数据不完整，未覆盖已保存记录");
  const result = { document: value.document, session: value.session,
    importedRevisions: Array.isArray(value.importedRevisions) ? value.importedRevisions.filter(v => typeof v === "string").slice(-10000) : [],
    revision: previous.revision + 1, updatedAt: new Date().toISOString() };
  const file = path.join(root, "snapshot.json");
  if (previous.document) {
    fs.copyFileSync(file, path.join(root, "snapshot.previous.json"));
    const before = Object.values(previous.document.store || {}).some(r => r.typeName === "shape");
    const after = Object.values(value.document.store || {}).some(r => r.typeName === "shape");
    if (before && !after) fs.copyFileSync(file, path.join(root, "snapshot.before-empty.json"));
  }
  writeJsonAtomic(file, result);
  return { revision: result.revision };
}
