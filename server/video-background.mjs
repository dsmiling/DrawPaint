import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { matteVideoFrame, foregroundColorSupport } from "../shared/video-matting.mjs";
import { detectBackground } from "../shared/background-removal.mjs";
import { stabilizeVideoMatte } from "../shared/video-matte-stability.mjs";

const exec = promisify(execFile);
export const VIDEO_BACKGROUND_VERSION = 17;

function processResult(child) {
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `固定视频底色失败（${code}）`)));
  });
}

// A text prompt cannot lock generated pixels. Key each frame against its actual
// border colour and composite the character onto the one chosen reference key.
export async function normalizeVideoBackground({ input, output, background, onProgress = () => {} }) {
  if (!["#ff00ff", "#00ff00"].includes(background)) throw new Error("固定底色须为品红或绿色");
  const { stdout } = await exec("ffprobe", ["-v", "error", "-show_streams", "-of", "json", input], { windowsHide: true });
  const streams = JSON.parse(stdout).streams, video = streams.find(stream => stream.codec_type === "video");
  const { width, height } = video || {}, rate = video?.avg_frame_rate;
  const [num, den] = (rate || "0/1").split("/").map(Number), fps = num / den;
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 2048 && n % 2 === 0) || !Number.isFinite(fps) || fps <= 0 || fps > 120) throw new Error("固定底色视频尺寸或帧率无效");
  const rgb = [1, 3, 5].map(i => parseInt(background.slice(i, i + 2), 16));
  const temporary = path.join(path.dirname(output), `${path.basename(output)}.${randomUUID()}.tmp.mp4`);
  const alphaOutput = output.replace(/\.mp4$/i, ".alpha.mkv");
  const alphaTemporary = `${alphaOutput}.${randomUUID()}.tmp.mkv`;
  await fs.mkdir(path.dirname(output), { recursive: true });
  const decoder = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", input, "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { windowsHide: true });
  const encoder = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${width}x${height}`, "-framerate", rate, "-i", "pipe:0", "-i", input, "-map", "0:v:0", "-map", "1:a?", "-c:v", "libx264", "-crf", "12", "-preset", "fast", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", temporary], { windowsHide: true });
  // Keep the recovered RGBA before compositing/encoding MP4. FFV1 stores alpha
  // losslessly; sequence exports must never try to reconstruct it from H.264.
  const alphaEncoder = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${width}x${height}`, "-framerate", rate, "-i", "pipe:0", "-an", "-c:v", "ffv1", "-level", "3", "-pix_fmt", "bgra", alphaTemporary], { windowsHide: true });
  const decoded = processResult(decoder), encoded = processResult(encoder), alphaEncoded = processResult(alphaEncoder);
  // Attach handlers immediately; stream/process failures must not become
  // unhandled rejections while the other process is still draining.
  decoded.catch(() => {}); encoded.catch(() => {}); alphaEncoded.catch(() => {});
  let inputError;
  encoder.stdin.on("error", error => { inputError = error; });
  alphaEncoder.stdin.on("error", error => { inputError = error; });
  const bytesPerFrame = width * height * 4;
  let pending = Buffer.alloc(0), frames = 0, changedFrames = 0, maximumInputDeviation = 0, partialAlphaPixels = 0, restoredInteriorPixels = 0, removedSpecklePixels = 0, removedSpeckleComponents = 0, temporalStabilizedPixels = 0, removedReferenceKeyPixels = 0, smoothedEffectPixels = 0;
  let recoveredPaleContourPixels = 0;
  let previousFrame = null, currentFrame = null, foregroundSupport = null, foregroundAnchors = [];
  const writeFrame = async nextFrame => {
    if (!currentFrame) return;
    const stable = stabilizeVideoMatte(previousFrame, currentFrame, nextFrame);
    temporalStabilizedPixels += stable.stabilizedPixels;
    if (!alphaEncoder.stdin.write(Buffer.from(stable.data))) await once(alphaEncoder.stdin, "drain");
    // Carry the corrected past forward, while the look-ahead stays original.
    // Three unfiltered frames can merely invert an alternating matte error
    // (0/128/0/128), rather than stop the flicker. Keep this RGBA separate from
    // the opaque MP4 composite below and retain the current decoded source.
    const stableFrame = { ...currentFrame, data: stable.data.slice() };
    let foreground = 0;
    for (let p = 0; p < bytesPerFrame; p += 4) {
      const alpha = stable.data[p + 3] / 255;
      if (alpha) foreground++;
      if (alpha > 0 && alpha < 1) partialAlphaPixels++;
      for (let c = 0; c < 3; c++) stable.data[p + c] = Math.round(stable.data[p + c] * alpha + rgb[c] * (1 - alpha));
      stable.data[p + 3] = 255;
    }
    if (!foreground) throw new Error(`第 ${frames + 1} 帧主体为空，未替换原视频`);
    if (!encoder.stdin.write(Buffer.from(stable.data))) await once(encoder.stdin, "drain");
    frames++;
    if (frames % 8 === 0) onProgress({ frames, fps });
    return stableFrame;
  };
  try {
    for await (const chunk of decoder.stdout) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= bytesPerFrame) {
        if (inputError) throw inputError;
        const original = pending.subarray(0, bytesPerFrame);
        const key = detectBackground(original, width, height);
        const keyHex = `#${key.map(c => c.toString(16).padStart(2, "0")).join("")}`;
        const deviation = Math.max(...key.map((c, i) => Math.abs(c - rgb[i])));
        const matteOptions = { removeBackground: true, background: keyHex, referenceBackground: background, removalMode: Math.max(...key) - Math.min(...key) > 60 ? "color" : "edge", tolerance: 55, feather: 8, edgeDecontaminate: true, edgeTrim: 0, hardAlpha: false, protectInterior: deviation > 24, foregroundSupport, foregroundAnchors };
        let matte = matteVideoFrame(original, width, height, matteOptions);
        if (!foregroundSupport) {
          foregroundSupport = foregroundColorSupport(original, matte.data, width, height, background);
          matte = matteVideoFrame(original, width, height, { ...matteOptions, foregroundSupport });
        }
        foregroundAnchors = [...foregroundAnchors, ...(matte.foregroundAnchors || [])].slice(-128);
        restoredInteriorPixels += matte.restoredInteriorPixels || 0;
        removedSpecklePixels += matte.removedSpecklePixels || 0;
        removedSpeckleComponents += matte.removedSpeckleComponents || 0;
        removedReferenceKeyPixels += matte.removedReferenceKeyPixels || 0;
        smoothedEffectPixels += matte.smoothedEffectPixels || 0;
        recoveredPaleContourPixels += matte.recoveredPaleContourPixels || 0;
        let borderPixels = 0, removedBorder = 0;
        const border = (x, y) => { borderPixels++; if (matte.data[(y * width + x) * 4 + 3] < 128) removedBorder++; };
        for (let x = 0; x < width; x++) { border(x, 0); border(x, height - 1); }
        for (let y = 1; y < height - 1; y++) { border(0, y); border(width - 1, y); }
        // A sword trail may touch an edge; do not mistake the effect for a
        // failed background. The majority of the perimeter must still key out.
        if (removedBorder / borderPixels < .5) throw new Error(`第 ${frames + 1} 帧无法可靠识别背景，请重生成`);
        maximumInputDeviation = Math.max(maximumInputDeviation, deviation);
        if (deviation > 24) changedFrames++;
        const nextFrame = { input: Buffer.from(original), data: matte.data, background: key };
        previousFrame = await writeFrame(nextFrame); currentFrame = nextFrame;
        pending = pending.subarray(bytesPerFrame);
      }
    }
    await writeFrame(null);
    if (pending.length || !frames) throw new Error("固定底色时读取的视频帧不完整");
    encoder.stdin.end(); alphaEncoder.stdin.end();
    await Promise.all([decoded, encoded, alphaEncoded]);
    await fs.rename(alphaTemporary, alphaOutput);
    await fs.rename(temporary, output);
    return { version: VIDEO_BACKGROUND_VERSION, background, frames, fps, width, height, changedFrames, maximumInputDeviation, restoredInteriorPixels, removedSpecklePixels, removedSpeckleComponents, temporalStabilizedPixels, removedReferenceKeyPixels, smoothedEffectPixels, recoveredPaleContourPixels, alphaFile: path.basename(alphaOutput), alphaMode: "straight", partialAlphaPixels, completedAt: new Date().toISOString() };
  } finally {
    decoder.kill(); encoder.kill(); alphaEncoder.kill();
    await Promise.allSettled([decoded, encoded, alphaEncoded]);
    await fs.rm(temporary, { force: true });
    await fs.rm(alphaTemporary, { force: true });
  }
}
