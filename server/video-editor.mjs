import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { readJson, writeJson } from "./storage.mjs";

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
    if (!source || !["job", "asset"].includes(source.type) || !uuid.test(source.id || "")) throw new Error("片段来源无效");
    const position = Number(raw.position), track = Number(raw.track), start = Number(raw.in), end = Number(raw.out);
    if (![position, track, start, end].every(Number.isFinite) || position < 0 || position > 3600 || !Number.isInteger(track) || track < 0 || track > 7 || start < 0 || end <= start || end > 3600) throw new Error("片段时间或轨道无效");
    return {
      id: raw.id, source, name: String(raw.name || "片段").slice(0, 100),
      position, track, in: start, out: end,
      ...(raw.nodeX != null && Number.isFinite(Number(raw.nodeX)) ? { nodeX: Math.max(-10000, Math.min(10000, Math.round(Number(raw.nodeX)))) } : {}),
      ...(raw.nodeY != null && Number.isFinite(Number(raw.nodeY)) ? { nodeY: Math.max(-10000, Math.min(10000, Math.round(Number(raw.nodeY)))) } : {}),
      mediaDuration: Number.isFinite(Number(raw.mediaDuration)) && Number(raw.mediaDuration) > 0 ? Math.min(3600, Number(raw.mediaDuration)) : end,
      fps: Number.isFinite(Number(raw.fps)) && Number(raw.fps) >= 1 && Number(raw.fps) <= 120 ? Number(raw.fps) : 24,
      startFrame: Number.isFinite(Number(raw.startFrame)) && raw.startFrame != null ? Math.max(start, Math.min(end, Number(raw.startFrame))) : null,
      endFrame: Number.isFinite(Number(raw.endFrame)) && raw.endFrame != null ? Math.max(start, Math.min(end, Number(raw.endFrame))) : null,
      prompt: String(raw.prompt || "").slice(0, 2000),
      ...(typeof raw.modelId === "string" ? { modelId: raw.modelId.slice(0, 60) } : {}),
      status: ["running", "completed", "failed"].includes(raw.status) ? raw.status : "completed",
    };
  });
  return { schema: "drawpaint.video-project.v1", width, height, clips, revision: randomUUID(), updatedAt: new Date().toISOString() };
}

export function buildExportArgs(clips, files, outputPath, audioIndices = [], size = { width: 640, height: 640 }) {
  if (!clips.length || clips.length !== files.length) throw new Error("没有可导出的片段");
  const total = Math.max(...clips.map(clip => clip.position + clip.out - clip.in));
  if (total > 3600) throw new Error("总时长超过一小时");
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  for (let i = 0; i < clips.length; i++) args.push("-ss", String(clips[i].in), "-t", String(clips[i].out - clips[i].in), "-i", files[i]);
  const order = clips.map((_, index) => index).sort((a, b) => clips[b].track - clips[a].track || a - b);
  const { width, height } = size;
  const filters = [`color=c=0x111827:s=${width}x${height}:r=24:d=${total.toFixed(3)}[v0]`];
  for (let layer = 0; layer < order.length; layer++) {
    const index = order[layer], clip = clips[index];
    const start = clip.position.toFixed(3), end = (clip.position + clip.out - clip.in - 1 / 24).toFixed(3);
    filters.push(`[${index}:v]fps=24,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,setpts=PTS-STARTPTS+${start}/TB[c${index}]`);
    filters.push(`[v${layer}][c${index}]overlay=eof_action=pass:enable='between(t,${start},${end})'[v${layer + 1}]`);
  }
  for (const index of audioIndices) {
    const delay = Math.round(clips[index].position * 1000);
    filters.push(`[${index}:a]asetpts=PTS-STARTPTS,adelay=${delay}:all=1[a${index}]`);
  }
  if (audioIndices.length) filters.push(`${audioIndices.map(index => `[a${index}]`).join("")}amix=inputs=${audioIndices.length}:duration=longest:dropout_transition=0,atrim=duration=${total.toFixed(3)}[aout]`);
  args.push("-filter_complex", filters.join(";"), "-map", `[v${order.length}]`);
  if (audioIndices.length) args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "192k");
  else args.push("-an");
  args.push("-t", total.toFixed(3), "-r", "24", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outputPath);
  return args;
}

export function buildClipExportArgs(clip, inputPath, outputPath) {
  const duration = clip.out - clip.in;
  if (!Number.isFinite(clip.in) || !Number.isFinite(duration) || clip.in < 0 || duration <= 0 || duration > 3600) throw new Error("片段裁剪范围无效");
  return ["-y", "-hide_banner", "-loglevel", "error", "-ss", clip.in.toFixed(3), "-i", inputPath,
    "-t", duration.toFixed(3), "-map", "0:v:0", "-map", "0:a?", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", outputPath];
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

export function createVideoEditor({ canvasDir, jobIds, generatedStore }) {
  const projectFile = path.join(canvasDir, "video-project.json");
  const assets = path.join(canvasDir, "video-assets");
  const exportsDir = path.join(canvasDir, "video-exports");
  const exportsFile = path.join(canvasDir, "video-exports.json");
  fs.mkdirSync(assets, { recursive: true });
  fs.mkdirSync(exportsDir, { recursive: true });
  const exports = readJson(exportsFile, {});
  const saveExports = () => writeJson(exportsFile, exports);

  async function sourceFile(source) {
    if (source.type === "asset") {
      if (!uuid.test(source.id)) throw new Error("素材 ID 无效");
      const file = ["mp4", "webm", "mov"].map(ext => path.join(assets, `${source.id}.${ext}`)).find(fs.existsSync);
      if (!file) throw new Error("视频素材不存在");
      return file;
    }
    if (!jobIds.has(source.id)) throw new Error("生成任务不存在");
    const { file } = await generatedStore.resolve(source.id);
    if (!file) throw new Error("生成任务尚未完成或视频源已丢失");
    return file;
  }

  return async function handleEditor(req, res, url) {
    if (!url.pathname.startsWith("/api/video/")) return false;
    try {
      if (req.method === "GET" && url.pathname === "/api/video/project") {
        json(res, 200, readJson(projectFile, { schema: "drawpaint.video-project.v1", clips: [] })); return true;
      }
      if (req.method === "PUT" && url.pathname === "/api/video/project") {
        const input = await readBody(req);
        const current = readJson(projectFile, { schema: "drawpaint.video-project.v1", clips: [] });
        if (Object.hasOwn(input, "baseRevision") && input.baseRevision !== (current.revision ?? current.updatedAt ?? null)) {
          const error = new Error("项目已在另一个页面更新，请刷新后重试");
          error.status = 409;
          throw error;
        }
        const project = normalizeProject(input);
        for (const clip of project.clips) {
          if (clip.source.type === "job" && !jobIds.has(clip.source.id)) throw new Error("片段引用了未知任务");
          if (clip.source.type === "asset" && !(await sourceFile(clip.source))) throw new Error("片段引用了未知素材");
        }
        writeJson(projectFile, project); json(res, 200, project); return true;
      }
      if (req.method === "POST" && url.pathname === "/api/video/import") {
        const body = await readBody(req, 128 * 1024 * 1024);
        const match = allowedVideo.exec(body.video || "");
        if (!match || Buffer.byteLength(match[2], "base64") > 90 * 1024 * 1024) throw new Error("请选择不超过 90 MB 的 MP4、WebM 或 MOV 视频");
        const id = randomUUID(), ext = match[1] === "video/quicktime" ? "mov" : match[1].split("/")[1];
        const file = path.join(assets, `${id}.${ext}`);
        fs.writeFileSync(file, Buffer.from(match[2], "base64"));
        try {
          const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "format=duration:stream=r_frame_rate", "-of", "json", file]);
          const metadata = JSON.parse(stdout);
          const duration = Number(metadata.format?.duration);
          const [num, den] = String(metadata.streams?.[0]?.r_frame_rate || "24/1").split("/").map(Number);
          const fps = num / den;
          if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) throw new Error("无法识别视频时长或视频超过一小时");
          json(res, 200, { id, duration, fps: Number.isFinite(fps) && fps > 0 ? fps : 24, url: `/api/video/assets/${id}.${ext}` });
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
        if (!["job", "asset"].includes(source.type) || !uuid.test(source.id || "") || !Number.isFinite(time) || time < 0 || time > 3600) throw new Error("帧位置无效");
        const file = await sourceFile(source);
        const { stdout } = await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", time.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=512:512:force_original_aspect_ratio=decrease", "-f", "image2pipe", "-vcodec", "png", "-"], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
        if (!stdout?.length) throw new Error("该位置没有可用视频帧");
        res.writeHead(200, { "Content-Type": "image/png", "Content-Length": stdout.length, "Cache-Control": "private, max-age=86400" });
        res.end(stdout); return true;
      }
      if (req.method === "POST" && url.pathname === "/api/video/exports") {
        const body = await readBody(req);
        const project = normalizeProject(readJson(projectFile, { clips: [] }));
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
          const clips = project.clips.filter(clip => clip.status === "completed");
          if (!clips.length) throw new Error("时间线上没有已完成的片段");
          const files = await Promise.all(clips.map(clip => sourceFile(clip.source)));
          const audioIndices = [];
          for (let index = 0; index < files.length; index++) {
            const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0", files[index]]);
            if (stdout.trim()) audioIndices.push(index);
          }
          args = buildExportArgs(clips, files, file, audioIndices, project);
          filename = "DrawPaint-edit.mp4";
          kind = "timeline";
        }
        exports[id] = { id, kind, filename, status: "running", createdAt: new Date().toISOString() }; saveExports();
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
      const exportMatch = /^\/api\/video\/exports\/([a-f0-9-]{36})(\/file)?$/.exec(url.pathname);
      if (["GET", "HEAD"].includes(req.method) && exportMatch) {
        const record = exports[exportMatch[1]];
        if (!record) { json(res, 404, { error: "导出任务不存在" }); return true; }
        if (exportMatch[2]) {
          if (record.status !== "completed") { json(res, 404, { error: "导出尚未完成" }); return true; }
          streamFile(req, res, path.join(exportsDir, `${record.id}.mp4`)); return true;
        }
        json(res, 200, record); return true;
      }
    } catch (error) {
      json(res, error.status || 400, { error: error.message || "视频编辑请求失败" }); return true;
    }
    return false;
  };
}
