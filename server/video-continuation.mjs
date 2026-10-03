import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function continuationFrameTime(time, duration, fps = 24) {
  if (!Number.isFinite(time) || time < 0 || !Number.isFinite(duration) || duration <= 0 || duration > 3600 || time > duration) {
    throw new Error("续接画面时间须位于已生成视频的时长范围内。");
  }
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 24;
  const selectedTime = Math.max(0, Math.min(time, duration - 1 / safeFps));
  // A paused player displays the frame at or before currentTime. Align the seek
  // to that frame instead of letting FFmpeg advance to the following frame.
  return Math.floor(selectedTime * safeFps + 1e-6) / safeFps;
}

export async function extractVideoContinuationFrame({ file, outputRoot, time }) {
  if (!Number.isFinite(time) || time < 0 || time > 3600) throw new Error("续接画面时间无效。");
  try {
    const metadata = await execFileAsync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "format=duration:stream=avg_frame_rate", "-of", "json", file],
      { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
    const info = JSON.parse(metadata.stdout);
    const [numerator, denominator] = String(info.streams?.[0]?.avg_frame_rate || "24/1").split("/").map(Number);
    const duration = Number(info.format?.duration);
    const frameTime = continuationFrameTime(time, duration, numerator / denominator);
    const { stdout } = await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", frameTime.toFixed(6), "-i", file,
      "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
      { windowsHide: true, timeout: 30000, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
    if (!stdout?.length) throw new Error("该位置没有可用画面，请稍微向前选择一帧。");
    const filename = `continuation_${randomUUID()}.png`;
    const subfolder = "DrawPaintVideo";
    const directory = path.join(outputRoot, subfolder);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, filename), stdout, { flag: "wx" });
    return { image: { filename, subfolder, type: "output" }, time: frameTime, duration };
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("无法启动本机 FFmpeg/FFprobe，请检查视频编辑运行环境。");
    throw error;
  }
}
