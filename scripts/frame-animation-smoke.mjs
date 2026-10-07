import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { FRAME_ANIMATION_TEMPLATES } from "../shared/frame-animation-templates.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "output", "frame-animation-smoke");
const stateFile = path.join(output, "run.json");
const base = "http://127.0.0.1:43218";
const resume = process.argv.includes("--resume");
const prototype = process.argv[2];
const selected = FRAME_ANIMATION_TEMPLATES.find(item => item.id === (process.argv[3] || "idle"));

async function request(route, method = "GET", body) {
  const response = await fetch(base + route, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}
async function save(state) {
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2));
}
async function waitFor(route, label) {
  const started = Date.now();
  let lastLog = 0;
  while (Date.now() - started < 30 * 60 * 1000) {
    const value = await request(route);
    if (value.status === "failed") throw new Error(value.error || `${label}失败`);
    if (value.status === "completed") return value;
    if (Date.now() - lastLog >= 30000) { console.log(`${label}: ${value.phase || value.status}`); lastLog = Date.now(); }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  throw new Error(`${label}等待超过 30 分钟；可使用 --resume 继续读取同一任务`);
}
async function download(url, filename) {
  const response = await fetch(base + url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  await fs.writeFile(path.join(output, filename), Buffer.from(await response.arrayBuffer()));
}

await fs.mkdir(output, { recursive: true });
let state;
if (resume) {
  state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  if (process.argv.includes("--reexport")) { delete state.exportId; delete state.export; await save(state); }
} else {
  if (!prototype || !selected) throw new Error("用法：node scripts/frame-animation-smoke.mjs <原型 PNG> [idle|walk|run|attack|hit|jump]，或 --resume");
  try { await fs.access(stateFile); throw new Error("已有验证记录，请使用 --resume，避免重复提交"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const setup = await request("/api/video/setup");
  if (!setup.models.find(item => item.id === "minimax-h3")?.ready) throw new Error("本地 MiniMax H3 未就绪");
  const bytes = await fs.readFile(path.resolve(prototype));
  await fs.writeFile(path.join(output, "prototype.png"), bytes);
  const image = `data:image/png;base64,${bytes.toString("base64")}`;
  const reference = await request("/api/video/reference-images", "POST", { image });
  const canvas = await request("/api/video/canvases", "POST", { name: "动作模板 · 鸭嘴骑士 · 本地验证" });
  const clips = FRAME_ANIMATION_TEMPLATES.map((template, index) => ({
    id: randomUUID(), name: `鸭嘴骑士 · ${template.name}`, source: null, status: "draft",
    firstImageId: reference.id, ...(template.loop ? { lastImageId: reference.id } : {}),
    prompt: template.prompt, frameAnimation: { enabled: true, background: "auto" }, modelId: "minimax-h3",
    position: index * 2.5, track: 0, in: 0, out: template.seconds, mediaDuration: template.seconds, fps: 24,
    nodeX: index % 3 * 280, nodeY: Math.floor(index / 3) * 280,
  }));
  const clip = clips[FRAME_ANIMATION_TEMPLATES.indexOf(selected)];
  await request(`/api/video/project?canvasId=${canvas.id}`, "PUT", { ...canvas, width: 640, height: 640, clips, baseRevision: canvas.revision, view: { graphPan: { x: 40, y: 40 }, graphZoom: 70, timelineZoom: 50, selectedIds: [clip.id] } });
  state = { canvasId: canvas.id, canvasName: canvas.name, clipId: clip.id, templateId: selected.id, fps: selected.fps, loop: selected.loop, createdAt: new Date().toISOString() };
  await save(state);
  const job = await request("/api/video/jobs", "POST", { name: clip.name, image, ...(selected.loop ? { lastImage: image } : {}), modelId: "minimax-h3", seconds: selected.seconds, prompt: selected.prompt, frameAnimation: clip.frameAnimation });
  state.jobId = job.id; state.frameAnimation = job.frameAnimation; await save(state);
  const project = await request(`/api/video/project?canvasId=${canvas.id}`);
  await request(`/api/video/project?canvasId=${canvas.id}`, "PUT", { ...project, baseRevision: project.revision, clips: project.clips.map(item => item.id === clip.id ? { ...item, source: { type: "job", id: job.id }, status: "running", frameAnimation: job.frameAnimation } : item) });
  console.log(`已提交 ${selected.name}: ${job.id}，画布 ${canvas.name}`);
}
if (!state.jobId) throw new Error("提交结果未确认，请先检查本地生成任务，不自动重复提交");
const generated = await waitFor(`/api/video/jobs/${state.jobId}`, "动作生成");
const info = await request(`/api/video/media-info?type=job&id=${state.jobId}`);
const project = await request(`/api/video/project?canvasId=${state.canvasId}`);
await request(`/api/video/project?canvasId=${state.canvasId}`, "PUT", { ...project, baseRevision: project.revision, clips: project.clips.map(item => item.id === state.clipId ? { ...item, source: { type: "job", id: state.jobId }, status: "completed", out: info.duration, mediaDuration: info.duration, mediaWidth: info.width, mediaHeight: info.height, fps: info.fps, startFrame: 0, endFrame: Math.max(0, info.duration - 1 / info.fps), frameAnimation: state.frameAnimation } : item) });
await download(generated.url, `${state.templateId}.mp4`);
if (!state.exportId) {
  // Preserve the stabilised alpha master, including translucent attack effects.
  // Hard edges are an explicit art choice, not the default cleanup strategy.
  const exported = await request("/api/video/exports", "POST", { canvasId: state.canvasId, clipId: state.clipId, format: "sequence", fps: state.fps, maxSize: 128, imageFormat: "png", resampling: "nearest", loop: state.loop,
    backgroundRemoval: { removeBackground: true, background: state.frameAnimation.background, removalMode: "color", tolerance: 55, feather: 8, edgeDecontaminate: true, edgeTrim: 0, hardAlpha: false } });
  state.exportId = exported.id; await save(state);
}
const exported = await waitFor(`/api/video/exports/${state.exportId}`, "透明序列帧导出");
await download(exported.url, `${state.templateId}-frames.zip`);
state.export = exported; state.completedAt = new Date().toISOString(); await save(state);
console.log(JSON.stringify({ status: "completed", canvas: state.canvasName, video: `${state.templateId}.mp4`, exportId: state.exportId, frames: exported.frameCount, fps: exported.fps, dimensions: [exported.width, exported.height], transparentFrames: exported.transparentFrames, warnings: exported.warnings, preview: base + exported.previewUrl }, null, 2));
