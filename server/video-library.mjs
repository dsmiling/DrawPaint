import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_VIDEO_FOLDERS, folderDescendants, folderPath, videoAssetKey } from "../shared/video-library.js";
import { writeJsonAtomic } from "./ui-studio/atomic.mjs";

const sourcePattern = /^(job|asset):[a-f0-9-]{36}$/;
const folderPattern = /^[a-zA-Z0-9_-]{1,80}$/;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
function nameOf(value, maximum = 80) {
  if (typeof value !== "string") fail("请填写名称");
  const name = value.trim();
  if (!name || name.length > maximum || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) fail("名称无效，请使用普通文字且不要包含路径符号");
  return name;
}

export function createVideoLibrary({ canvasDir, getJobs = () => [] }) {
  const indexFile = path.join(canvasDir, "video-library.json"), importsDir = path.join(canvasDir, "video-assets");
  function sources() {
    const files = fs.existsSync(importsDir) ? fs.readdirSync(importsDir).filter(file => /^[a-f0-9-]{36}\.(mp4|webm|mov)$/.test(file)) : [];
    return [...getJobs(), ...files.map(file => ({ source: { type: "asset", id: file.slice(0, 36) } }))];
  }
  function assertFolder(state, id) {
    if (id === null) return;
    if (typeof id !== "string" || !folderPattern.test(id)) fail("文件夹编号无效");
    if (!state.folders.some(folder => folder.id === id)) fail("文件夹不存在，请刷新素材目录", 404);
  }
  function validate(state) {
    if (state?.version !== 1 || !Number.isInteger(state.revision) || !Array.isArray(state.folders) || state.folders.length > 200 || !state.items || typeof state.items !== "object" || Array.isArray(state.items)) fail("视频素材目录索引损坏，请保留索引文件后恢复", 500);
    const ids = new Set(), names = new Set();
    for (const folder of state.folders) {
      if (!folderPattern.test(folder.id || "") || ids.has(folder.id)) fail("文件夹编号重复或无效");
      ids.add(folder.id); nameOf(folder.name);
      const key = `${folder.parentId ?? ""}:${folder.name.normalize("NFKC").toLocaleLowerCase()}`;
      if (names.has(key)) fail("同一文件夹下已有这个名称"); names.add(key);
    }
    for (const folder of state.folders) {
      assertFolder(state, folder.parentId);
      if (folderDescendants(state.folders, folder.id).has(folder.parentId)) fail("文件夹不能移动到自身或子文件夹中");
      if (folderPath(state.folders, folder.id).length > 12) fail("文件夹最多支持 12 层");
    }
    for (const [key, item] of Object.entries(state.items)) {
      if (!sourcePattern.test(key) || !item || typeof item !== "object") fail("视频素材索引无效");
      assertFolder(state, item.folderId);
      if (item.name != null) nameOf(item.name, 100);
    }
  }
  function load() {
    let state;
    if (!fs.existsSync(indexFile)) state = { version: 1, revision: 0, folders: DEFAULT_VIDEO_FOLDERS.map(folder => ({ ...folder })), items: {} };
    else {
      try { state = JSON.parse(fs.readFileSync(indexFile, "utf8")); validate(state); }
      catch { fail("视频素材目录索引无法读取，请保留索引文件后恢复", 500); }
    }
    let changed = !fs.existsSync(indexFile);
    for (const asset of sources()) {
      const key = videoAssetKey(asset);
      if (!sourcePattern.test(key) || state.items[key]) continue;
      const destination = asset.source.type === "asset" ? "imported" : asset.frameAnimation?.enabled ? "animation" : "normal";
      state.items[key] = { folderId: state.folders.some(folder => folder.id === destination) ? destination : null }; changed = true;
    }
    return { state, changed };
  }
  function save(state) { validate(state); state.revision++; writeJsonAtomic(indexFile, state); return state; }
  function read() { const { state, changed } = load(); return changed ? save(state) : state; }
  function knownKeys(keys) {
    const known = new Set(sources().map(videoAssetKey));
    if (!Array.isArray(keys) || !keys.length || keys.length > 500 || keys.some(key => !sourcePattern.test(key) || !known.has(key))) fail("素材不存在，请刷新素材列表", 404);
    return [...new Set(keys)];
  }
  function change(input) {
    const { state } = load(); let affectedFolderId;
    if (input.action === "create-folder") {
      assertFolder(state, input.parentId); if (state.folders.length >= 200) fail("最多支持 200 个文件夹");
      affectedFolderId = randomUUID(); state.folders.push({ id: affectedFolderId, name: nameOf(input.name), parentId: input.parentId });
    } else if (["rename-folder", "move-folder", "delete-folder"].includes(input.action)) {
      assertFolder(state, input.id); if (input.id === null) fail("素材库根目录不能修改");
      const folder = state.folders.find(item => item.id === input.id);
      if (input.action === "rename-folder") folder.name = nameOf(input.name);
      if (input.action === "move-folder") { assertFolder(state, input.parentId); folder.parentId = input.parentId; }
      if (input.action === "delete-folder") {
        if (state.folders.some(item => item.parentId === folder.id) || Object.values(state.items).some(item => item.folderId === folder.id)) fail("文件夹中还有素材或子文件夹，请先移出后再移除", 409);
        state.folders = state.folders.filter(item => item.id !== folder.id);
      }
    } else if (input.action === "move-assets") {
      assertFolder(state, input.folderId);
      for (const key of knownKeys(input.keys)) state.items[key].folderId = input.folderId;
    } else if (input.action === "rename-asset") {
      const [key] = knownKeys([input.key]); state.items[key].name = nameOf(input.name, 100);
    } else fail("未知素材目录操作");
    return { ...save(state), ...(affectedFolderId ? { affectedFolderId } : {}) };
  }
  function register(source, destination) {
    const { state } = load(), key = videoAssetKey({ source }); knownKeys([key]);
    // A folder may have been removed while generation or import was running.
    if (destination !== undefined) state.items[key].folderId = destination === null || state.folders.some(folder => folder.id === destination) ? destination : null;
    return save(state);
  }
  return { read, change, register, assertFolder: id => assertFolder(read(), id), indexFile };
}
