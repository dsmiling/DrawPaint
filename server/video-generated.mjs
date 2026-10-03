import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function createGeneratedVideoStore({ canvasDir, comfyJson, videoOutput }) {
  const directory = path.join(canvasDir, "video-generated");
  const outputRoot = path.resolve(canvasDir, "..", "..", "ComfyUI", "output");
  const pending = new Map();
  fs.mkdirSync(directory, { recursive: true });

  function cachedFile(id) {
    const file = path.join(directory, `${id}.mp4`);
    return fs.existsSync(file) ? file : null;
  }

  async function cacheOutput(id, output) {
    const existing = cachedFile(id);
    if (existing) return existing;
    if (pending.has(id)) return pending.get(id);
    const work = (async () => {
      const source = path.resolve(outputRoot, output.subfolder || "", path.basename(output.filename));
      if (!source.startsWith(outputRoot + path.sep) || !fs.existsSync(source)) throw new Error("生成视频文件不存在");
      const target = path.join(directory, `${id}.mp4`);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await fs.promises.copyFile(source, temporary);
        await fs.promises.rename(temporary, target);
      } finally {
        await fs.promises.rm(temporary, { force: true });
      }
      return target;
    })();
    pending.set(id, work);
    try { return await work; }
    finally { pending.delete(id); }
  }

  async function resolve(id) {
    const file = cachedFile(id);
    if (file) return { file, history: null };
    const history = (await comfyJson(`/history/${id}`))[id];
    const output = videoOutput(history);
    return { file: output ? await cacheOutput(id, output) : null, history };
  }

  return { cachedFile, resolve };
}
