import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { initCanvasLayout, readJson, resolveProjectDir, writeJson } from "./storage.mjs";
import { createVideoEditor, streamFile } from "./video-editor.mjs";
import { createGeneratedVideoStore } from "./video-generated.mjs";
import { createVideoQueueReader } from "./video-queue.mjs";
import { listPromptModels, refineVideoPrompt } from "./video-prompt.mjs";
import { buildVideoGraph, modelById } from "./video-models.mjs";
import { createVideoRuntime } from "./video-runtime.mjs";
import { extractVideoContinuationFrame } from "./video-continuation.mjs";
import { prepareAnimationReferences } from "./video-animation-input.mjs";
import { frameAnimationPrompt, normalizeFrameAnimation } from "../shared/frame-animation.js";

const comfy = "http://127.0.0.1:8188";
const projectDir = resolveProjectDir(process.env.DRAWPAINT_PROJECT_DIR);
const canvasDir = initCanvasLayout(projectDir);
const comfyOutputDir = path.resolve(projectDir, "..", "ComfyUI", "output");
const jobFile = path.join(canvasDir, "video-jobs.json");
const jobIds = new Set(readJson(jobFile, []));
const jobOptionsFile = path.join(canvasDir, "video-job-options.json");
const jobOptions = readJson(jobOptionsFile, {});
const runtime = createVideoRuntime({ projectDir, canvasDir, comfyUrl: comfy });

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

async function bodyJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 24 * 1024 * 1024) throw new Error("请求图片过大（每张最多 8 MB）");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function comfyJson(route, options) {
  const response = await fetch(`${comfy}${route}`, { ...options, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`ComfyUI ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

function videoOutput(history) {
  const outputs = history?.outputs || {};
  for (const output of Object.values(outputs)) {
    for (const item of output?.images || []) {
      if (item?.type === "output" && item.filename?.endsWith(".mp4")) return item;
    }
  }
  return null;
}

function resolveComfyOutputImage(image, label) {
  if (!image || typeof image !== "object" || image.type && image.type !== "output") throw new Error(`${label}图片引用无效`);
  const filename = typeof image.filename === "string" ? path.posix.basename(image.filename) : "";
  const subfolder = typeof image.subfolder === "string" ? image.subfolder.replaceAll("\\", "/") : "";
  if (!filename || filename !== image.filename || !/\.(png|jpe?g|webp)$/i.test(filename)
    || !/^[\w/-]*$/.test(subfolder) || subfolder.split("/").some(part => part === "..")) throw new Error(`${label}图片引用无效`);
  const file = path.resolve(comfyOutputDir, subfolder, filename);
  const relative = path.relative(comfyOutputDir, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label}图片路径无效`);
  return file;
}

const generatedStore = createGeneratedVideoStore({ canvasDir, comfyJson, videoOutput, jobOptions });
const videoQueue = createVideoQueueReader({ jobIds, jobOptions, generatedStore, comfyJson });
const handleEditor = createVideoEditor({ canvasDir, jobIds, generatedStore, jobOptions });

export async function handleVideo(req, res, url) {
  if (!url.pathname.startsWith("/api/video/")) return false;
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/127\.0\.0\.1:(43217|43218|43219)$/.test(origin)) {
    json(res, 403, { error: "请求来源不受支持" }); return true;
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,HEAD,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  try {
    if (await handleEditor(req, res, url)) return true;
    if (req.method === "GET" && url.pathname === "/api/video/prompt-models") {
      json(res, 200, await listPromptModels(url.searchParams.get("provider") || "cursor")); return true;
    }
    if (req.method === "POST" && url.pathname === "/api/video/refine-prompt") {
      json(res, 200, await refineVideoPrompt(await bodyJson(req))); return true;
    }
    if (req.method === "GET" && url.pathname === "/api/video/setup") {
      json(res, 200, await runtime.status()); return true;
    }
    if (req.method === "POST" && url.pathname === "/api/video/start") {
      json(res, 200, await runtime.start()); return true;
    }
    if (req.method === "GET" && url.pathname === "/api/video/health") {
      const setup = await runtime.status();
      json(res, 200, { ready: setup.models.find(model => model.id === "minimax-h3")?.ready || false, model: "MiniMax H3", mode: "image-to-video", error: setup.error });
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/video/jobs") {
      const limit = Number(url.searchParams.get("limit") ?? 30);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("视频素材数量须为 1–500");
      const { jobs } = await videoQueue.read(limit);
      json(res, 200, { jobs }); return true;
    }
    if (req.method === "GET" && url.pathname === "/api/video/queue") {
      json(res, 200, await videoQueue.read(30, true)); return true;
    }
    const continuationMatch = /^\/api\/video\/jobs\/([a-f0-9-]{36})\/continuation-frame$/.exec(url.pathname);
    if (req.method === "POST" && continuationMatch) {
      const id = continuationMatch[1];
      if (!jobIds.has(id)) throw new Error("找不到这段已生成视频。");
      const { file } = await generatedStore.resolve(id);
      if (!file) throw new Error("视频尚未生成完成，无法选取续接画面。");
      const body = await bodyJson(req);
      if (typeof body.time !== "number") throw new Error("请提供视频中所选画面的时间。");
      json(res, 200, await extractVideoContinuationFrame({ file, outputRoot: comfyOutputDir, time: body.time }));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/video/jobs") {
      const body = await bodyJson(req);
      if (body.folderId !== undefined) handleEditor.library.assertFolder(body.folderId);
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(body.image || "");
      const imageRefPath = body.imageRef ? resolveComfyOutputImage(body.imageRef, "起始帧") : null;
      const prompt = String(body.prompt || "").trim();
      const frameAnimation = normalizeFrameAnimation(body.frameAnimation);
      const modelId = String(body.modelId || "minimax-h3");
      const seconds = Number(body.seconds ?? (modelId === "minimax-h3" ? 5 : 2));
      const model = modelById(modelId);
      if (body.conditioningMode !== undefined) {
        if (!["start_only", "start_and_end"].includes(body.conditioningMode)) throw new Error("视频关键帧模式无效。");
        if (body.conditioningMode === "start_only" && (body.lastImage || body.lastImageRef)) throw new Error("单首帧模式不能提交尾帧约束。");
        if (body.conditioningMode === "start_and_end" && !(body.lastImage || body.lastImageRef)) throw new Error("首尾帧模式须提供尾帧。");
      }
      if (!match && !imageRefPath) throw new Error("请上传图片或选择本机已生成的关键帧");
      if (match && Buffer.byteLength(match[2], "base64") > 8 * 1024 * 1024) throw new Error("请上传不超过 8 MB 的 PNG、JPEG 或 WebP 图片");
      if (!prompt || prompt.length > 2000) throw new Error("请输入 1 至 2000 字的动作描述");
      if (!model) throw new Error("请选择有效的视频模型");
      if (!model.durations.includes(seconds)) throw new Error(`${model.name} 不支持 ${seconds} 秒时长`);
      if ((body.lastImage || body.lastImageRef) && !model.supportsEndFrame) throw new Error(`${model.name} 暂不支持尾帧约束`);
      const setup = await runtime.status();
      const choice = setup.models.find(item => item.id === modelId);
      if (!choice?.ready) throw new Error(choice?.missingFiles.length ? `模型文件缺失：${choice.missingFiles.join("、")}` : setup.error || `模型节点未就绪：${choice?.missingNodes.join("、") || "请重新检查连接"}`);
      const id = randomUUID();
      let imageBuffer = match ? Buffer.from(match[2], "base64") : await fs.promises.readFile(imageRefPath);
      let imageMetadata = await sharp(imageBuffer).metadata();
      if (!imageMetadata.width || !imageMetadata.height) throw new Error("无法读取起始图片尺寸");
      if ([5, 6, 7, 8].includes(imageMetadata.orientation)) {
        const normalized = await sharp(imageBuffer).rotate().toBuffer({ resolveWithObject: true });
        imageBuffer = normalized.data;
        imageMetadata = normalized.info;
      }
      let lastBuffer = null, lastExtension = null, lastMime = null;
      if (body.lastImage || body.lastImageRef) {
        const lastMatch = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(body.lastImage || "");
        const lastImageRefPath = body.lastImageRef ? resolveComfyOutputImage(body.lastImageRef, "尾帧") : null;
        if (!lastMatch && !lastImageRefPath || lastMatch && Buffer.byteLength(lastMatch[2], "base64") > 8 * 1024 * 1024) throw new Error("尾帧图片格式或大小无效");
        lastBuffer = lastMatch ? Buffer.from(lastMatch[2], "base64") : await fs.promises.readFile(lastImageRefPath);
        lastExtension = lastMatch ? (lastMatch[1] === "image/jpeg" ? "jpg" : lastMatch[1].split("/")[1]) : path.extname(lastImageRefPath).slice(1).replace(/^jpe?g$/i, "jpg");
        lastMime = lastMatch?.[1] || (lastExtension === "jpg" ? "image/jpeg" : `image/${lastExtension}`);
      }
      const prepared = await prepareAnimationReferences(imageBuffer, lastBuffer, frameAnimation);
      imageBuffer = prepared.image; lastBuffer = prepared.lastImage;
      if (frameAnimation.enabled) {
        imageMetadata = await sharp(imageBuffer).metadata();
        if (lastBuffer) { lastExtension = "png"; lastMime = "image/png"; }
      }
      const generationPrompt = frameAnimation.enabled ? frameAnimationPrompt(prompt, prepared.settings.background) : prompt;
      const format = imageMetadata.format === "jpg" ? "jpeg" : imageMetadata.format;
      const mime = `image/${format}`;
      if (!["image/png", "image/jpeg", "image/webp"].includes(mime)) throw new Error("不支持该起始图片格式");
      const extension = format === "jpeg" ? "jpg" : format;
      const form = new FormData();
      form.append("image", new Blob([imageBuffer], { type: mime }), `DrawPaint_${id}.${extension}`);
      form.append("overwrite", "false");
      const uploaded = await comfyJson("/upload/image", { method: "POST", body: form });
      let lastImage = null;
      if (lastBuffer) {
        const lastForm = new FormData();
        lastForm.append("image", new Blob([lastBuffer], { type: lastMime }), `DrawPaint_${id}_last.${lastExtension}`);
        lastForm.append("overwrite", "false");
        lastImage = (await comfyJson("/upload/image", { method: "POST", body: lastForm })).name;
      }
      const graph = buildVideoGraph({
        modelId, image: uploaded.name, lastImage, prompt: generationPrompt, seconds, id,
        imageWidth: imageMetadata.width, imageHeight: imageMetadata.height,
      });
      const queued = await comfyJson("/prompt", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: graph }),
      });
      if (!queued.prompt_id) throw new Error("ComfyUI 未返回任务编号");
      jobIds.add(queued.prompt_id);
      writeJson(jobFile, [...jobIds]);
      jobOptions[queued.prompt_id] = { frameAnimation: prepared.settings, lockBackground: prepared.settings.enabled, name: String(body.name || "生成视频").slice(0, 100), prompt, modelId, seconds, createdAt: new Date().toISOString() };
      writeJson(jobOptionsFile, jobOptions);
      handleEditor.library.register({ type: "job", id: queued.prompt_id }, body.folderId);
      json(res, 200, { id: queued.prompt_id, frameAnimation: prepared.settings, preparation: prepared.preparation });
      return true;
    }
    const backgroundMatch = /^\/api\/video\/jobs\/([a-f0-9-]{36})\/fix-background$/.exec(url.pathname);
    if (req.method === "POST" && backgroundMatch) {
      const id = backgroundMatch[1], settings = jobOptions[id]?.frameAnimation;
      if (!jobIds.has(id) || !settings?.enabled || !["#ff00ff", "#00ff00"].includes(settings.background)) throw new Error("请选择使用固定底色的帧动画视频");
      jobOptions[id].lockBackground = true; writeJson(jobOptionsFile, jobOptions);
      await generatedStore.resolve(id, { wait: false, retry: true });
      json(res, 200, await videoQueue.get(id)); return true;
    }
    const match = /^\/api\/video\/jobs\/([a-f0-9-]{36})(\/file)?$/.exec(url.pathname);
    if (["GET", "HEAD"].includes(req.method) && match) {
      const id = match[1];
      if (!jobIds.has(id)) { json(res, 404, { error: "当前服务未提交该任务" }); return true; }
      if (match[2]) {
        const { file } = await generatedStore.resolve(id);
        if (!file) { json(res, 404, { error: "视频尚未生成或视频源已丢失" }); return true; }
        streamFile(req, res, file);
        return true;
      }
      json(res, 200, await videoQueue.get(id));
      return true;
    }
    json(res, 404, { error: "接口不存在" });
  } catch (error) {
    json(res, 400, { error: error.message || "视频请求失败" });
  }
  return true;
}
