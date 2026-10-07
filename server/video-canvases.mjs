import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeJsonAtomic } from "./ui-studio/atomic.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const empty = () => ({ schema: "drawpaint.video-project.v1", width: 640, height: 640, clips: [] });

export function createVideoCanvases(canvasDir) {
  const directory = path.join(canvasDir, "video-canvases");
  function fileFor(id) {
    if (id === "default") return path.join(canvasDir, "video-project.json");
    if (!uuid.test(id || "")) throw fail("视频画布 ID 无效");
    return path.join(directory, `${id}.json`);
  }
  function read(id = "default") {
    const file = fileFor(id);
    let value;
    try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") {
        if (id === "default") value = empty();
        else throw fail("视频画布不存在", 404);
      } else throw fail("视频画布读取失败，请保留文件并检查保存内容", 500);
    }
    if (!value || !Array.isArray(value.clips)) throw fail("视频画布内容无效", 500);
    return { ...value, id, name: value.name || (id === "default" ? "默认画布" : "视频画布") };
  }
  function summary(project) {
    return { id: project.id, name: project.name, width: project.width || 640, height: project.height || 640,
      clipCount: project.clips.length, updatedAt: project.updatedAt || null };
  }
  function list() {
    const ids = fs.existsSync(directory) ? fs.readdirSync(directory).filter(file => uuid.test(file.slice(0, -5)) && file.endsWith(".json")).map(file => file.slice(0, -5)) : [];
    return [summary(read()), ...ids.map(id => summary(read(id))).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))];
  }
  function nameOf(name) {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 80) throw fail("画布名称需要 1–80 个字符");
    return name.trim();
  }
  function create(name) {
    const id = randomUUID(), now = new Date().toISOString();
    const project = { ...empty(), id, name: nameOf(name), revision: randomUUID(), createdAt: now, updatedAt: now };
    writeJsonAtomic(fileFor(id), project);
    return project;
  }
  function rename(id, name) {
    const project = { ...read(id), name: nameOf(name) };
    // Renaming does not change the content revision used by open editors.
    writeJsonAtomic(fileFor(id), project);
    return project;
  }
  function save(id, project, input) {
    const current = read(id);
    if (Object.hasOwn(input, "baseRevision") && input.baseRevision !== (current.revision ?? current.updatedAt ?? null)) {
      throw fail("此画布已在另一个页面更新，请刷新后重试", 409);
    }
    const next = { ...project, id, name: current.name, ...(current.createdAt ? { createdAt: current.createdAt } : {}) };
    writeJsonAtomic(fileFor(id), next);
    return next;
  }
  return { read, list, create, rename, save };
}
