import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { Zip, ZipPassThrough } from "fflate";
import { detectBackground } from "../shared/background-removal.mjs";
import { matteVideoFrame } from "../shared/video-matting.mjs";
import { sequencePreviewHtml } from "./video-sequence-preview.mjs";
import { clipRate } from "../shared/video-editing.js";

export const MAX_SEQUENCE_FRAMES = 1200;

export function normalizeSequenceBackground(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("去背景设置无效");
  if (value.removeBackground != null && typeof value.removeBackground !== "boolean") throw new Error("去背景开关无效");
  const background = value.background ?? "auto", removalMode = value.removalMode ?? "edge";
  if (background !== "auto" && !/^#[\da-f]{6}$/i.test(background)) throw new Error("背景色须为六位十六进制颜色");
  if (!["edge", "color"].includes(removalMode)) throw new Error("去背景方式无效");
  const tolerance = Number(value.tolerance ?? 12), feather = Number(value.feather ?? 4);
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 150) throw new Error("颜色容差须为 0–150");
  if (!Number.isInteger(feather) || feather < 0 || feather > 60) throw new Error("边缘过渡须为 0–60");
  const edgeTrim = Number(value.edgeTrim ?? 0);
  if (!Number.isInteger(edgeTrim) || edgeTrim < 0 || edgeTrim > 3) throw new Error("边缘收缩须为 0–3 px");
  if (value.edgeDecontaminate != null && typeof value.edgeDecontaminate !== "boolean") throw new Error("净化色边开关无效");
  if (value.hardAlpha != null && typeof value.hardAlpha !== "boolean") throw new Error("硬边透明开关无效");
  return { removeBackground: value.removeBackground === true, background, removalMode, tolerance, feather, edgeDecontaminate: value.edgeDecontaminate !== false, edgeTrim, hardAlpha: value.hardAlpha === true };
}

export function normalizeSequenceOptions(input, duration, dimensions) {
  const fps = Number(input.fps ?? 12), maxSize = Number(input.maxSize ?? 512);
  const format = input.imageFormat ?? "png", resampling = input.resampling ?? "smooth";
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new Error("序列帧帧率须为 1–60 fps");
  if (![64, 128, 256, 512, 1024, 2048].includes(maxSize)) throw new Error("序列帧尺寸无效");
  if (!["smooth", "nearest"].includes(resampling)) throw new Error("序列帧缩放方式无效");
  if (!["png", "webp"].includes(format)) throw new Error("序列帧仅支持 PNG 或 WebP");
  if (input.loop != null && typeof input.loop !== "boolean") throw new Error("循环设置无效");
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("序列帧时长无效");
  const frameCount = Math.max(1, Math.ceil(duration * fps - 0.0001));
  if (frameCount > MAX_SEQUENCE_FRAMES) throw new Error(`序列帧最多 ${MAX_SEQUENCE_FRAMES} 帧，请降低帧率或裁短片段`);
  const { width, height } = dimensions;
  if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 16384)) throw new Error("无法识别视频尺寸");
  const scale = Math.min(1, maxSize / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  if (w * h * frameCount > 268435456) throw new Error("序列帧总尺寸过大，请降低分辨率或裁短片段");
  const backgroundRemoval = normalizeSequenceBackground(input.backgroundRemoval);
  const extractScale = Math.min(1, (backgroundRemoval.removeBackground ? 2048 : maxSize) / Math.max(width, height));
  const extractWidth = Math.max(1, Math.round(width * extractScale)), extractHeight = Math.max(1, Math.round(height * extractScale));
  if (extractWidth * extractHeight * frameCount > 536870912) throw new Error("抠图处理总尺寸过大，请降低帧率或裁短片段");
  return { fps, maxSize, format, resampling, loop: input.loop !== false, frameCount, width: w, height: h, extractWidth, extractHeight, backgroundRemoval };
}

export function sequenceOutputArgs(options, outputPattern) {
  return ["-an", "-frames:v", String(options.frameCount), "-fps_mode", "cfr", "-c:v", "png", "-pix_fmt", "rgba", "-start_number", "0", outputPattern];
}

export function buildClipSequenceArgs(clip, file, outputPattern, options) {
  const duration = clip.out - clip.in;
  if (!Number.isFinite(clip.in) || !Number.isFinite(duration) || clip.in < 0 || duration <= 0) throw new Error("片段裁剪范围无效");
  return ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(clip.in), "-i", file,
    "-map", "0:v:0", "-vf", `trim=duration=${duration},setpts=(PTS-STARTPTS)/${clipRate(clip)},tpad=stop_mode=clone:stop_duration=1,fps=${options.fps}:start_time=0,scale=${options.extractWidth ?? options.width}:${options.extractHeight ?? options.height}${options.resampling === "nearest" ? ":flags=neighbor" : ""},setsar=1`,
    ...sequenceOutputArgs(options, outputPattern)];
}

export function runSequenceFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `序列帧提取失败（${code}）`)));
  });
}

// Compressed images are streamed into a stored ZIP, rather than keeping the entire animation in memory.
async function writeSequenceZip(directory, filenames, outputFile) {
  const fd = fs.openSync(outputFile, "w");
  let bytes = 0;
  try {
    const zip = new Zip((error, data) => {
      if (error) throw error;
      bytes += data.length;
      if (bytes > 2 * 1024 ** 3) throw new Error("序列帧下载包超过 2 GB，请降低分辨率");
      let offset = 0;
      while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset);
    });
    for (const filename of filenames) {
      const entry = new ZipPassThrough(filename);
      zip.add(entry);
      for await (const chunk of fs.createReadStream(path.join(directory, filename))) entry.push(chunk);
      entry.push(new Uint8Array(), true);
    }
    zip.end();
  } finally { fs.closeSync(fd); }
}

export async function packageSequence(directory, options, { name, source, sourceDuration }, outputFile, onProgress = () => {}) {
  const rawFrames = (await fsp.readdir(path.join(directory, "frames"))).filter(file => /^frame-\d{6}\.png$/.test(file)).sort();
  if (rawFrames.length !== options.frameCount) throw new Error(`视频帧不足：预期 ${options.frameCount} 帧，实际 ${rawFrames.length} 帧，请检查裁切范围`);
  const { width, height, format, fps } = options;
  let backgroundRemoval = { ...options.backgroundRemoval }, transparentFrames = 0, emptyFrames = 0;
  if (backgroundRemoval.removeBackground) {
    onProgress({ phase: "matting", processedFrames: 0 });
    for (let index = 0; index < rawFrames.length; index++) {
      const framePath = path.join(directory, "frames", rawFrames[index]);
      const { data, info } = await sharp(await fsp.readFile(framePath)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const nativeWidth = info.width, nativeHeight = info.height;
      if (!((nativeWidth === options.extractWidth && nativeHeight === options.extractHeight) || (nativeWidth === width && nativeHeight === height))) throw new Error("提取的帧尺寸与导出设置不一致");
      // Resolve auto once, then keep the same key across the whole animation.
      if (index === 0) {
        const rgb = backgroundRemoval.background === "auto" ? detectBackground(data, nativeWidth, nativeHeight) : [1, 3, 5].map(i => parseInt(backgroundRemoval.background.slice(i, i + 2), 16));
        backgroundRemoval.resolvedBackground = `#${rgb.map(c => c.toString(16).padStart(2, "0")).join("")}`;
      }
      const matted = matteVideoFrame(data, nativeWidth, nativeHeight, { ...backgroundRemoval, background: backgroundRemoval.resolvedBackground }).data;
      // Resize RGBA only after matting so the key cannot bleed into new edge pixels.
      const output = await sharp(Buffer.from(matted), { raw: { width: nativeWidth, height: nativeHeight, channels: 4 } }).resize(width, height, { kernel: options.resampling === "nearest" ? "nearest" : "linear" }).raw().toBuffer();
      let visible = 0, transparent = 0;
      for (let p = 3; p < output.length; p += 4) { if (output[p] > 0) visible++; if (output[p] < 255) transparent++; }
      if (transparent) transparentFrames++;
      if (!visible) emptyFrames++;
      await fsp.writeFile(framePath, await sharp(Buffer.from(output), { raw: { width, height, channels: 4 } }).png().toBuffer());
      if ((index + 1) % 8 === 0 || index + 1 === rawFrames.length) onProgress({ phase: "matting", processedFrames: index + 1 });
    }
    if (emptyFrames === rawFrames.length) throw new Error("剔除后动画为空，请降低颜色容差或重新选择背景色");
  }
  const warnings = backgroundRemoval.removeBackground && transparentFrames === 0 ? ["未检测到透明区域，请调整背景色或颜色容差。"] : [];
  const manifest = { schema: "drawpaint.animation.v1", name, fps, frameCount: rawFrames.length, duration: rawFrames.length / fps,
    sourceDuration, loop: options.loop, width, height, format, resampling: options.resampling || "smooth", alphaMode: "straight", backgroundRemoval, transparentFrames, emptyFrames, warnings, source, sheets: [], frames: [] };
  const columns = Math.min(Math.floor(4096 / width), Math.ceil(Math.sqrt(rawFrames.length * height / width)));
  const rowsPerSheet = Math.floor(4096 / height), capacity = columns * rowsPerSheet;
  const filenames = [];
  await fsp.mkdir(path.join(directory, "sheets"), { recursive: true });
  for (let start = 0; start < rawFrames.length; start += capacity) {
    const count = Math.min(capacity, rawFrames.length - start), sheetIndex = manifest.sheets.length;
    const rows = Math.ceil(count / columns), sheetWidth = Math.min(columns, count) * width, sheetHeight = rows * height;
    // Blending onto transparent black can round straight-alpha RGB. Atlas
    // rectangles must contain the exact decoded frame bytes, even at alpha 1.
    const atlas = Buffer.alloc(sheetWidth * sheetHeight * 4);
    for (let local = 0; local < count; local++) {
      const index = start + local, rawFile = path.join(directory, "frames", rawFrames[index]);
      const file = `frames/frame-${String(index).padStart(6, "0")}.${format}`;
      if (format === "webp") {
        await sharp(await fsp.readFile(rawFile)).webp({ lossless: true }).toFile(path.join(directory, file));
      }
      const x = local % columns * width, y = Math.floor(local / columns) * height;
      const pixels = await sharp(await fsp.readFile(path.join(directory, file))).ensureAlpha().raw().toBuffer();
      for (let row = 0; row < height; row++) pixels.copy(atlas, ((y + row) * sheetWidth + x) * 4, row * width * 4, (row + 1) * width * 4);
      manifest.frames.push({ file, time: index / fps, duration: 1 / fps, sheet: sheetIndex, x, y, w: width, h: height });
      filenames.push(file);
    }
    const file = `sheets/sheet-${String(sheetIndex).padStart(3, "0")}.${format}`;
    let sheet = sharp(atlas, { raw: { width: sheetWidth, height: sheetHeight, channels: 4 } });
    sheet = format === "webp" ? sheet.webp({ lossless: true }) : sheet.png();
    await sheet.toFile(path.join(directory, file));
    manifest.sheets.push({ file, width: sheetWidth, height: sheetHeight, columns, rows, firstFrame: start, frameCount: count });
    filenames.push(file);
    onProgress({ phase: "packing", processedFrames: start + count });
  }
  await fsp.writeFile(path.join(directory, "animation.json"), JSON.stringify(manifest, null, 2));
  // A self-contained player makes the exported frame sequence reviewable without a game engine.
  const preview = sequencePreviewHtml(manifest);
  await fsp.writeFile(path.join(directory, "preview.html"), preview);
  await fsp.writeFile(path.join(directory, "README.txt"), `解压后用浏览器打开 preview.html，点击画面播放/暂停，可逐帧查看并切换棋盘、白色和深色背景。\nframes 内为按 0 起始编号排序的序列帧，sheets 内为精灵图集（最大 4096×4096）。animation.json 记录帧率、循环设置、背景剔除参数、每帧文件和图集矩形；坐标原点在左上角，x 向右、y 向下。\n${backgroundRemoval.removeBackground ? "逐帧图片和图集带真实 RGBA 透明通道，使用非预乘（straight）alpha；自动背景色固定为首帧检测值，避免逐帧变色。" : "图片保留原视频背景及已有透明通道。"}所有帧保持相同画幅与对齐，不单独裁边，避免动画抖动。\n使用方法：可将 frames 中的 PNG / WebP 按文件名顺序载入游戏引擎，以 ${fps} fps 播放；或按 animation.json 的矩形切分 sheets 图集。Unity 中将 PNG 设为 Sprite (2D and UI)，勾选 Alpha Is Transparency，像素风使用 Point 过滤；图集坐标转换为 Unity 左下角原点时使用 y = sheet.height - frame.y - frame.h。\n棋盘格只用于预览，没有写入图片。导出不包含音频，循环播放不会自动修复首尾衔接。\n`);
  filenames.push("animation.json", "preview.html", "README.txt");
  onProgress({ phase: "archiving", processedFrames: rawFrames.length });
  await writeSequenceZip(directory, filenames, outputFile);
  return manifest;
}
