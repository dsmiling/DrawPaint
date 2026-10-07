import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { readJson, writeJson } from "./storage.mjs";
import { buildClipSequenceArgs, normalizeSequenceOptions, packageSequence, runSequenceFFmpeg, sequenceOutputArgs } from "./video-sequence.mjs";
import { videoFrameRange } from "../shared/video-frame-range.js";
import { normalizeFrameAnimation } from "../shared/frame-animation.js";
import { createVideoCanvases } from "./video-canvases.mjs";
import { clipRate, durationOf, endOf, exportable } from "../shared/video-editing.js";
import { writeJsonAtomic } from "./ui-studio/atomic.mjs";
import { createVideoLibrary } from "./video-library.mjs";
import { attachedVideoSequences } from "./video-attached-sequences.mjs";
import sharp from "sharp";

const execFileAsync = promisify(execFile);
const uuid = /^[a-f0-9-]{36}$/;
const allowedVideo = /^data:(video\/(?:mp4|webm|quicktime));base64,([A-Za-z0-9+/=]+)$/;

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("上传内容过大");
    chunks.push(chunk);
  }
  return size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

export function normalizeProject(input) {
  if (!Array.isArray(input?.clips) || input.clips.length > 100) throw new Error("片段列表无效");
  const width = Number(input.width ?? 640), height = Number(input.height ?? 640);
  if (![[640, 640], [960, 540], [540, 960], [1280, 720], [720, 1280]].some(([w, h]) => w === width && h === height)) throw new Error("输出画布尺寸无效");
  const seen = new Set();
  const clips = input.clips.map(raw => {
    if (!uuid.test(raw.id || "") || seen.has(raw.id)) throw new Error("片段 ID 无效或重复");
    seen.add(raw.id);
    const source = raw.source;
    const draft = raw.status === "draft";
    if (draft ? source != null : !source || !["job", "asset"].includes(source.type) || !uuid.test(source.id || "")) throw new Error("片段来源无效");
    const position = Number(raw.position), track = Number(raw.track), start = Number(raw.in), end = Number(raw.out);
    if (![position, track, start, end].every(Number.isFinite) || position < 0 || position > 3600 || !Number.isInteger(track) || track < 0 || track > 7 || start < 0 || end <= start || end > 3600) throw new Error("片段时间或轨道无效");
    if (raw.playbackRate != null && (!Number.isFinite(raw.playbackRate) || raw.playbackRate < .25 || raw.playbackRate > 4)) throw new Error("播放速度须为 0.25–4 倍");
    if (raw.volume != null && (!Number.isFinite(raw.volume) || raw.volume < 0 || raw.volume > 1)) throw new Error("音量须为 0–100%");
    for (const key of ["hidden", "locked", "muted"]) if (raw[key] != null && typeof raw[key] !== "boolean") throw new Error("片段开关无效");
    for (const key of ["firstImageId", "lastImageId"]) if (raw[key] != null && !uuid.test(raw[key])) throw new Error("参考图 ID 无效");
    return {
      id: raw.id, source: source || null, name: String(raw.name || "片段").slice(0, 100),
      position, track, in: start, out: end,
      ...(raw.nodeX != null && Number.isFinite(Number(raw.nodeX)) ? { nodeX: Math.max(-10000, Math.min(10000, Math.round(Number(raw.nodeX)))) } : {}),
      ...(raw.nodeY != null && Number.isFinite(Number(raw.nodeY)) ? { nodeY: Math.max(-10000, Math.min(10000, Math.round(Number(raw.nodeY)))) } : {}),
      mediaDuration: Number.isFinite(Number(raw.mediaDuration)) && Number(raw.mediaDuration) > 0 ? Math.min(3600, Number(raw.mediaDuration)) : end,
      fps: Number.isFinite(Number(raw.fps)) && Number(raw.fps) >= 1 && Number(raw.fps) <= 120 ? Number(raw.fps) : 24,
      startFrame: Number.isFinite(Number(raw.startFrame)) && raw.startFrame != null ? Math.max(start, Math.min(end, Number(raw.startFrame))) : null,
      endFrame: Number.isFinite(Number(raw.endFrame)) && raw.endFrame != null ? Math.max(start, Math.min(end, Number(raw.endFrame))) : null,
      prompt: String(raw.prompt || "").slice(0, 2000),
      ...(raw.frameAnimation != null ? { frameAnimation: normalizeFrameAnimation(raw.frameAnimation) } : {}),
      ...(typeof raw.modelId === "string" ? { modelId: raw.modelId.slice(0, 60) } : {}),
      ...Object.fromEntries(["hidden", "locked", "muted", "playbackRate", "volume", "firstImageId", "lastImageId"].filter(key => raw[key] != null).map(key => [key, raw[key]])),
      ...Object.fromEntries(["nodeWidth", "nodeHeight", "mediaWidth", "mediaHeight"].filter(key => Number.isFinite(raw[key])).map(key => [key, Math.round(Math.max(key.startsWith("node") ? 180 : 1, Math.min(key.startsWith("node") ? 600 : 16384, raw[key])))])),
      status: ["draft", "running", "completed", "failed"].includes(raw.status) ? raw.status : "completed",
    };
  });
  const view = input.view && typeof input.view === "object" ? {
    graphPan: { x: Math.max(-10000, Math.min(10000, Number(input.view.graphPan?.x) || 0)), y: Math.max(-10000, Math.min(10000, Number(input.view.graphPan?.y) || 0)) },
    graphZoom: Math.max(20, Math.min(200, Number(input.view.graphZoom) || 100)),
    timelineZoom: Math.max(25, Math.min(120, Number(input.view.timelineZoom) || 50)),
    ...(Array.isArray(input.view.selectedIds) ? { selectedIds: input.view.selectedIds.filter(id => seen.has(id)).slice(0, 100) } : {}),
  } : undefined;
  return { schema: "drawpaint.video-project.v1", width, height, clips, ...(view ? { view } : {}), revision: randomUUID(), updatedAt: new Date().toISOString() };
}

export function buildExportArgs(clips, files, outputPath, audioIndices = [], size = { width: 640, height: 640 }, sequence = null) {
  if (!clips.length || clips.length !== files.length) throw new Error("没有可导出的片段");
  const total = Math.max(...clips.map(endOf));
  if (total > 3600) throw new Error("总时长超过一小时");
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  for (let i = 0; i < clips.length; i++) args.push("-ss", String(clips[i].in), "-t", String(clips[i].out - clips[i].in), "-i", files[i]);
  const order = clips.map((_, index) => index).sort((a, b) => clips[b].track - clips[a].track || a - b);
  const { width, height } = size;
  const fps = sequence?.fps || 24;
  const filters = [`color=c=0x111827:s=${width}x${height}:r=${fps}:d=${total.toFixed(6)}[v0]`];
  for (let layer = 0; layer < order.length; layer++) {
    const index = order[layer], clip = clips[index];
    const start = clip.position.toFixed(3), end = endOf(clip).toFixed(6), rate = clipRate(clip);
    filters.push(`[${index}:v]setpts=${rate === 1 ? "PTS-STARTPTS" : `(PTS-STARTPTS)/${rate}` }+${start}/TB,fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease${sequence?.resampling === "nearest" ? ":flags=neighbor" : ""},pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1[c${index}]`);
    filters.push(`[v${layer}][c${index}]overlay=eof_action=pass:enable='gte(t,${start})*lt(t,${end})'[v${layer + 1}]`);
  }
  if (sequence) {
    args.push("-filter_complex", filters.join(";"), "-map", `[v${order.length}]`, ...sequenceOutputArgs(sequence, outputPath));
    return args;
  }
  audioIndices = audioIndices.filter(index => !clips[index].muted);
  for (const index of audioIndices) {
    const delay = Math.round(clips[index].position * 1000);
    filters.push(`[${index}:a]asetpts=PTS-STARTPTS,${audioFilters(clips[index])}adelay=${delay}:all=1[a${index}]`);
  }
  if (audioIndices.length) filters.push(`${audioIndices.map(index => `[a${index}]`).join("")}amix=inputs=${audioIndices.length}:duration=longest:dropout_transition=0,atrim=duration=${total.toFixed(3)}[aout]`);
  args.push("-filter_complex", filters.join(";"), "-map", `[v${order.length}]`);
  if (audioIndices.length) args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "192k");
  else args.push("-an");
  args.push("-t", total.toFixed(3), "-r", "24", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outputPath);
  return args;
}

export function buildClipExportArgs(clip, inputPath, outputPath) {
  const duration = durationOf(clip), rate = clipRate(clip);
  if (!Number.isFinite(clip.in) || !Number.isFinite(duration) || clip.in < 0 || duration <= 0 || duration > 3600) throw new Error("片段裁剪范围无效");
  return ["-y", "-hide_banner", "-loglevel", "error", "-ss", clip.in.toFixed(3), ...(rate !== 1 ? ["-t", (clip.out - clip.in).toFixed(6)] : []), "-i", inputPath,
    "-t", duration.toFixed(3), "-map", "0:v:0", ...(clip.muted ? ["-an"] : ["-map", "0:a?"]), "-vf", `${rate !== 1 ? `setpts=(PTS-STARTPTS)/${rate},` : ""}pad=ceil(iw/2)*2:ceil(ih/2)*2`,
    ...(!clip.muted && audioFilters(clip) ? ["-af", audioFilters(clip).slice(0, -1)] : []),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", outputPath];
}

function audioFilters(clip) {
  const filters = [], rate = clipRate(clip);
  let tempo = rate;
  while (tempo > 2) { filters.push("atempo=2"); tempo /= 2; }
  while (tempo < .5) { filters.push("atempo=0.5"); tempo /= .5; }
  if (tempo !== 1) filters.push(`atempo=${tempo}`);
  if (clip.volume != null && clip.volume !== 1) filters.push(`volume=${clip.volume}`);
  return filters.length ? filters.join(",") + "," : "";
}

export function streamFile(req, res, file, mime = "video/mp4") {
  if (!fs.existsSync(file)) { json(res, 404, { error: "文件不存在" }); return; }
  const size = fs.statSync(file).size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  let start = 0, end = size - 1, status = 200;
  if (range) {
    start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    end = range[2] && range[1] ? Number(range[2]) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); res.end(); return; }
    end = Math.min(end, size - 1); status = 206;
  }
  const headers = { "Content-Type": mime, "Content-Length": end - start + 1, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);
  if (req.method === "HEAD") res.end();
  else fs.createReadStream(file, { start, end }).pipe(res);
}

export function createVideoEditor({ canvasDir, jobIds, generatedStore, jobOptions = {} }) {
  const canvases = createVideoCanvases(canvasDir);
  const videoLibrary = createVideoLibrary({ canvasDir, getJobs: () => [...jobIds].map(id => ({ ...jobOptions[id], source: { type: "job", id } })) });
  const assets = path.join(canvasDir, "video-assets");
  const assetIndexFile = path.join(canvasDir, "video-assets.json"), assetIndex = readJson(assetIndexFile, {});
  const references = path.join(canvasDir, "video-reference-images");
  const exportsDir = path.join(canvasDir, "video-exports");
  const exportsFile = path.join(canvasDir, "video-exports.json");
  fs.mkdirSync(assets, { recursive: true });
  fs.mkdirSync(references, { recursive: true });
  fs.mkdirSync(exportsDir, { recursive: true });
  const exports = readJson(exportsFile, {});
  let preparingExport = false;
  const saveExports = () => writeJson(exportsFile, exports);
  for (const record of Object.values(exports)) {
    if (record.status === "running") {
      record.status = "failed"; record.error = "服务重启中断了导出，请重新导出";
    }
  }
  saveExports();

  async function sourceFile(source, { transparent = false } = {}) {
    if (source.type === "asset") {
      if (!uuid.test(source.id)) throw new Error("素材 ID 无效");
      const file = ["mp4", "webm", "mov"].map(ext => path.join(assets, `${source.id}.${ext}`)).find(fs.existsSync);
      if (!file) throw new Error("视频素材不存在");
      return file;
    }
    if (!jobIds.has(source.id)) throw new Error("生成任务不存在");
    const { file } = transparent && generatedStore.resolveForFrames
      ? await generatedStore.resolveForFrames(source.id) : await generatedStore.resolve(source.id);
    if (!file) throw new Error("生成任务尚未完成或视频源已丢失");
    return file;
  }

  async function mediaInfo(source) {
    const file = await sourceFile(source);
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "format=duration:stream=width,height,r_frame_rate:stream_side_data=rotation", "-of", "json", file], { windowsHide: true });
    const metadata = JSON.parse(stdout), stream = metadata.streams?.[0];
    const [numerator, denominator] = String(stream?.r_frame_rate || "24/1").split("/").map(Number);
    const duration = Number(metadata.format?.duration), fps = numerator / denominator;
    if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) throw new Error("无法识别视频时长或视频超过一小时");
    let width = Number(stream?.width), height = Number(stream?.height);
    if (Math.abs((stream?.side_data_list?.find(item => item.rotation != null)?.rotation || 0) % 180) === 90) [width, height] = [height, width];
    return { duration, fps: Number.isFinite(fps) && fps > 0 ? fps : 24, width, height };
  }

  const handleEditor = async function handleEditor(req, res, url) {
    if (!url.pathname.startsWith("/api/video/")) return false;
    let ownsExportLock = false;
    try {
      if (req.method === "GET" && url.pathname === "/api/video/library") { json(res, 200, videoLibrary.read()); return true; }
      if (req.method === "POST" && url.pathname === "/api/video/library") { json(res, 200, videoLibrary.change(await readBody(req))); return true; }
      if (req.method === "GET" && url.pathname === "/api/video/sequences") {
        const project = canvases.read(url.searchParams.get("canvasId") ?? "default");
        json(res, 200, { sequences: attachedVideoSequences(exports, exportsDir, project) }); return true;
      }
      if (req.method === "GET" && url.pathname === "/api/video/canvases") {
        json(res, 200, { canvases: canvases.list() }); return true;
      }
      if (req.method === "POST" && url.pathname === "/api/video/canvases") {
        const input = await readBody(req);
        json(res, 201, canvases.create(input.name)); return true;
      }
      const canvasMatch = /^\/api\/video\/canvases\/([^/]+)$/.exec(url.pathname);
      if (req.method === "PATCH" && canvasMatch) {
        const input = await readBody(req);
        json(res, 200, canvases.rename(canvasMatch[1], input.name)); return true;
      }
      if (req.method === "GET" && url.pathname === "/api/video/project") {
        json(res, 200, canvases.read(url.searchParams.get("canvasId") ?? "default")); return true;
      }
      if (req.method === "PUT" && url.pathname === "/api/video/project") {
        const input = await readBody(req);
        const canvasId = url.searchParams.get("canvasId") ?? "default";
        const project = normalizeProject(input);
        for (const clip of project.clips) {
          if (clip.source?.type === "job" && !jobIds.has(clip.source.id)) throw new Error("片段引用了未知任务");
          if (clip.source?.type === "asset" && !(await sourceFile(clip.source))) throw new Error("片段引用了未知素材");
          for (const key of ["firstImageId", "lastImageId"]) if (clip[key] && !fs.existsSync(path.join(references, `${clip[key]}.png`))) throw new Error("片段参考图不存在");
        }
        json(res, 200, canvases.save(canvasId, project, input)); return true;
      }
      if (req.method === "GET" && url.pathname === "/api/video/assets") {
        const entries = fs.readdirSync(assets).filter(file => /^[a-f0-9-]{36}\.(mp4|webm|mov)$/.test(file)).map(file => {
          const id = file.slice(0, 36), ext = file.slice(37);
          return { ...assetIndex[id], id, name: assetIndex[id]?.name || "导入视频", source: { type: "asset", id, ext }, status: "completed", url: `/api/video/assets/${file}` };
        });
        json(res, 200, { assets: entries.reverse() }); return true;
      }
      if (req.method === "GET" && url.pathname === "/api/video/media-info") {
        const source = { type: url.searchParams.get("type"), id: url.searchParams.get("id") };
        if (!["job", "asset"].includes(source.type) || !uuid.test(source.id || "")) throw new Error("视频来源无效");
        json(res, 200, await mediaInfo(source)); return true;
      }
      if (req.method === "POST" && url.pathname === "/api/video/reference-images") {
        const body = await readBody(req, 12 * 1024 * 1024);
        const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(body.image || "");
        if (!match || Buffer.byteLength(match[1], "base64") > 8 * 1024 * 1024) throw new Error("请选择不超过 8 MB 的 PNG、JPEG 或 WebP 关键帧");
        const image = sharp(Buffer.from(match[1], "base64"), { limitInputPixels: 16000000 }).rotate(), metadata = await image.metadata();
        if (!metadata.width || !metadata.height || (metadata.pages || 1) > 1) throw new Error("关键帧须为单张静态图片");
        const id = randomUUID(), file = path.join(references, `${id}.png`);
        await image.png().toFile(file);
        json(res, 201, { id, url: `/api/video/reference-images/${id}.png` }); return true;
      }
      const referenceMatch = /^\/api\/video\/reference-images\/([a-f0-9-]{36})\.png$/.exec(url.pathname);
      if (["GET", "HEAD"].includes(req.method) && referenceMatch) {
        streamFile(req, res, path.join(references, `${referenceMatch[1]}.png`), "image/png"); return true;
      }
      if (req.method === "POST" && url.pathname === "/api/video/import") {
        const body = await readBody(req, 128 * 1024 * 1024);
        if (body.folderId !== undefined) videoLibrary.assertFolder(body.folderId);
        const match = allowedVideo.exec(body.video || "");
        if (!match || Buffer.byteLength(match[2], "base64") > 90 * 1024 * 1024) throw new Error("请选择不超过 90 MB 的 MP4、WebM 或 MOV 视频");
        const id = randomUUID(), ext = match[1] === "video/quicktime" ? "mov" : match[1].split("/")[1];
        const file = path.join(assets, `${id}.${ext}`);
        fs.writeFileSync(file, Buffer.from(match[2], "base64"));
        try {
          const info = await mediaInfo({ type: "asset", id });
          assetIndex[id] = { ...info, name: String(body.name || "导入视频").slice(0, 100), createdAt: new Date().toISOString() };
          writeJsonAtomic(assetIndexFile, assetIndex);
          videoLibrary.register({ type: "asset", id }, body.folderId);
          json(res, 200, { id, ...info, url: `/api/video/assets/${id}.${ext}` });
        } catch (error) {
          fs.unlinkSync(file); throw error;
        }
        return true;
      }
      const assetMatch = /^\/api\/video\/assets\/([a-f0-9-]{36})\.(mp4|webm|mov)$/.exec(url.pathname);
      if (["GET", "HEAD"].includes(req.method) && assetMatch) {
        streamFile(req, res, path.join(assets, `${assetMatch[1]}.${assetMatch[2]}`), assetMatch[2] === "webm" ? "video/webm" : assetMatch[2] === "mov" ? "video/quicktime" : "video/mp4"); return true;
      }
      if (req.method === "GET" && url.pathname === "/api/video/frame") {
        const source = { type: url.searchParams.get("type"), id: url.searchParams.get("id") };
        const time = Number(url.searchParams.get("time"));
        const maxSize = Number(url.searchParams.get("maxSize") ?? 512);
        if (![256, 512, 1024, 2048].includes(maxSize)) throw new Error("帧预览尺寸无效");
        if (!["job", "asset"].includes(source.type) || !uuid.test(source.id || "") || !Number.isFinite(time) || time < 0 || time > 3600) throw new Error("帧位置无效");
        const file = await sourceFile(source, { transparent: url.searchParams.get("transparent") === "1" });
        const { stdout } = await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", time.toFixed(3), "-i", file, "-frames:v", "1", "-vf", `scale=w='min(${maxSize},iw)':h='min(${maxSize},ih)':force_original_aspect_ratio=decrease`, "-f", "image2pipe", "-vcodec", "png", "-"], { encoding: "buffer", maxBuffer: 24 * 1024 * 1024, windowsHide: true });
        if (!stdout?.length) throw new Error("该位置没有可用视频帧");
        res.writeHead(200, { "Content-Type": "image/png", "Content-Length": stdout.length, "Cache-Control": "private, max-age=86400" });
        res.end(stdout); return true;
      }
      if (req.method === "POST" && url.pathname === "/api/video/exports") {
        if (preparingExport || Object.values(exports).some(record => record.status === "running")) throw new Error("已有导出正在处理，请等待完成后重试");
        preparingExport = true; ownsExportLock = true;
        const body = await readBody(req);
        if (body.format != null && !["mp4", "sequence"].includes(body.format)) throw new Error("导出格式无效");
        const canvasId = body.canvasId ?? "default", savedProject = canvases.read(canvasId);
        const project = normalizeProject(savedProject);
        if (body.format === "sequence") {
          if (body.useFrameRange != null && typeof body.useFrameRange !== "boolean") throw new Error("首尾帧范围设置无效");
          if (body.useFrameRange && !body.clipId) throw new Error("首尾帧导出需要选择单个片段");
          let clips, files, dimensions, duration, name;
          const scope = body.clipId != null ? "clip" : "timeline";
          if (scope === "clip") {
            if (!uuid.test(body.clipId)) throw new Error("片段 ID 无效");
            let clip = project.clips.find(item => item.id === body.clipId);
            if (!clip || clip.status !== "completed") throw new Error("片段不存在或尚未生成完成");
            if (body.useFrameRange) {
              const range = videoFrameRange(clip);
              if (!range.valid) throw new Error("首帧不能晚于尾帧，请在完整模式调整");
              clip = { ...clip, in: range.start, out: range.end };
            }
            clips = [clip]; files = [await sourceFile(clip.source, { transparent: body.backgroundRemoval?.removeBackground === true })];
            const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:stream_side_data=rotation", "-of", "json", files[0]], { windowsHide: true });
            const metadata = JSON.parse(stdout).streams?.[0];
            dimensions = { width: Number(metadata?.width), height: Number(metadata?.height) };
            const rotation = metadata?.side_data_list?.find(item => item.rotation != null)?.rotation || 0;
            if (Math.abs(rotation % 180) === 90) [dimensions.width, dimensions.height] = [dimensions.height, dimensions.width];
            duration = durationOf(clip); name = clip.name;
          } else {
            clips = project.clips.filter(exportable);
            if (!clips.length) throw new Error("时间线上没有已完成的片段");
            files = await Promise.all(clips.map(clip => sourceFile(clip.source)));
            dimensions = project; duration = Math.max(...clips.map(endOf));
            name = savedProject.name;
          }
          const options = normalizeSequenceOptions(body, duration, dimensions);
          const id = randomUUID(), directory = path.join(exportsDir, id), file = path.join(exportsDir, `${id}.zip`);
          fs.mkdirSync(path.join(directory, "frames"), { recursive: true });
          const pattern = path.join(directory, "frames", "frame-%06d.png");
          const args = scope === "clip" ? buildClipSequenceArgs(clips[0], files[0], pattern, options) : buildExportArgs(clips, files, pattern, [], options, options);
          const filename = `${name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim() || "动画"}-frames.zip`;
          exports[id] = { id, canvasId, canvasName: savedProject.name, kind: "sequence", scope, ...(scope === "clip" ? { clipId: clips[0].id, clipSource: clips[0].source } : {}), filename, status: "running", phase: "extracting", fps: options.fps,
            frameCount: options.frameCount, width: options.width, height: options.height, imageFormat: options.format, resampling: options.resampling, loop: options.loop,
            useFrameRange: body.useFrameRange === true, backgroundRemoval: options.backgroundRemoval, createdAt: new Date().toISOString() };
          saveExports();
          // Respond immediately; frame extraction and atlas packing continue as a polled export job.
          void runSequenceFFmpeg(args).then(() => packageSequence(directory, options, {
            name, source: { canvasId, canvasName: savedProject.name, scope, clips: clips.map(clip => ({ id: clip.id, source: clip.source, in: clip.in, out: clip.out, position: clip.position, track: clip.track, playbackRate: clipRate(clip) })) }, sourceDuration: duration,
          }, file, progress => { exports[id] = { ...exports[id], ...progress }; saveExports(); })).then(manifest => {
            exports[id] = { ...exports[id], status: "completed", phase: "completed", duration: manifest.duration, sheetCount: manifest.sheets.length,
              backgroundRemoval: manifest.backgroundRemoval, transparentFrames: manifest.transparentFrames, warnings: manifest.warnings,
              url: `/api/video/exports/${id}/file`, previewUrl: `/api/video/exports/${id}/preview.html` };
            saveExports();
          }).catch(error => {
            exports[id] = { ...exports[id], status: "failed", error: error.message }; saveExports();
          });
          json(res, 200, exports[id]); return true;
        }
        const id = randomUUID(), file = path.join(exportsDir, `${id}.mp4`);
        let args, filename, kind;
        if (body.clipId != null) {
          if (!uuid.test(body.clipId)) throw new Error("片段 ID 无效");
          const clip = project.clips.find(item => item.id === body.clipId);
          if (!clip || clip.status !== "completed") throw new Error("片段不存在或尚未生成完成");
          args = buildClipExportArgs(clip, await sourceFile(clip.source), file);
          filename = `${clip.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim() || "片段"}.mp4`;
          kind = "clip";
        } else {
          const clips = project.clips.filter(exportable);
          if (!clips.length) throw new Error("时间线上没有已完成的片段");
          const files = await Promise.all(clips.map(clip => sourceFile(clip.source)));
          const audioIndices = [];
          for (let index = 0; index < files.length; index++) {
            const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0", files[index]]);
            if (stdout.trim()) audioIndices.push(index);
          }
          args = buildExportArgs(clips, files, file, audioIndices, project);
          filename = `${savedProject.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")}.mp4`;
          kind = "timeline";
        }
        exports[id] = { id, canvasId, canvasName: savedProject.name, kind, filename, status: "running", createdAt: new Date().toISOString() }; saveExports();
        const process = spawn("ffmpeg", args, { windowsHide: true });
        let stderr = "";
        process.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
        process.on("error", error => { exports[id] = { ...exports[id], status: "failed", error: error.message }; saveExports(); });
        process.on("close", code => {
          if (exports[id]?.status === "failed") return;
          exports[id] = { ...exports[id], status: code === 0 && fs.existsSync(file) ? "completed" : "failed", error: code === 0 ? null : stderr.slice(-500), url: code === 0 ? `/api/video/exports/${id}/file` : null };
          saveExports();
        });
        json(res, 200, exports[id]); return true;
      }
      const exportMatch = /^\/api\/video\/exports\/([a-f0-9-]{36})(\/(?:file|preview\.html|animation\.json|sheets\/sheet-\d{3}\.(?:png|webp)|frames\/frame-\d{6}\.(?:png|webp)))?$/.exec(url.pathname);
      if (["GET", "HEAD"].includes(req.method) && exportMatch) {
        const record = exports[exportMatch[1]];
        if (!record) { json(res, 404, { error: "导出任务不存在" }); return true; }
        if (exportMatch[2]) {
          if (record.status !== "completed") { json(res, 404, { error: "导出尚未完成" }); return true; }
          if (exportMatch[2] === "/file") {
            streamFile(req, res, path.join(exportsDir, `${record.id}.${record.kind === "sequence" ? "zip" : "mp4"}`), record.kind === "sequence" ? "application/zip" : "video/mp4");
          } else if (record.kind === "sequence") {
            const relative = exportMatch[2].slice(1), ext = path.extname(relative);
            streamFile(req, res, path.join(exportsDir, record.id, relative), ext === ".html" ? "text/html; charset=utf-8" : ext === ".json" ? "application/json; charset=utf-8" : ext === ".png" ? "image/png" : "image/webp");
          } else { json(res, 404, { error: "此导出没有序列帧预览" }); }
          return true;
        }
        json(res, 200, record); return true;
      }
    } catch (error) {
      json(res, error.status || 400, { error: error.message || "视频编辑请求失败" }); return true;
    } finally { if (ownsExportLock) preparingExport = false; }
    return false;
  };
  handleEditor.library = videoLibrary;
  return handleEditor;
}
