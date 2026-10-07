import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeVideoBackground, VIDEO_BACKGROUND_VERSION } from "./video-background.mjs";

export function createGeneratedVideoStore({ canvasDir, comfyJson, videoOutput, jobOptions = {}, normalizeBackground = normalizeVideoBackground }) {
  const directory = path.join(canvasDir, "video-generated");
  const outputRoot = path.resolve(canvasDir, "..", "..", "ComfyUI", "output");
  const pending = new Map();
  const backgroundJobs = new Map();
  let backgroundTail = Promise.resolve();
  fs.mkdirSync(directory, { recursive: true });

  function cachedFile(id) {
    const locked = lockedFile(id);
    if (locked) return locked;
    const file = path.join(directory, `${id}.mp4`);
    return fs.existsSync(file) ? file : null;
  }

  function lockedFile(id) {
    const file = path.join(directory, `${id}.background.mp4`);
    try {
      const report = JSON.parse(fs.readFileSync(path.join(directory, `${id}.background.json`), "utf8"));
      if (report.version === VIDEO_BACKGROUND_VERSION && (!jobOptions[id]?.frameAnimation?.background || report.background === jobOptions[id].frameAnimation.background) && fs.existsSync(file) && (!report.alphaFile || report.alphaFile === `${id}.background.alpha.mkv` && fs.existsSync(path.join(directory, report.alphaFile)))) return file;
    } catch { /* Incomplete work is retried after restart using the untouched source. */ }
    return null;
  }

  async function cacheOutput(id, output) {
    const existing = path.join(directory, `${id}.mp4`);
    if (fs.existsSync(existing)) return existing;
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

  async function resolveRaw(id) {
    const file = path.join(directory, `${id}.mp4`);
    if (fs.existsSync(file)) return { file, history: null };
    const history = (await comfyJson(`/history/${id}`))[id];
    const output = videoOutput(history);
    return { file: output ? await cacheOutput(id, output) : null, history };
  }

  async function resolve(id, { wait = true, retry = false } = {}) {
    const locked = lockedFile(id);
    if (locked) return { file: locked, history: null };
    const result = await resolveRaw(id);
    const options = jobOptions[id];
    if (!result.file || !options?.lockBackground || !options.frameAnimation?.enabled) return result;
    let job = backgroundJobs.get(id);
    if (job?.status === "failed" && retry) { backgroundJobs.delete(id); job = null; }
    if (!job) {
      job = { status: "queued", frames: 0 }; backgroundJobs.set(id, job);
      const output = path.join(directory, `${id}.background.mp4`);
      job.work = backgroundTail.then(async () => {
        job.status = "processing";
        const report = await normalizeBackground({ input: result.file, output, background: options.frameAnimation.background, onProgress: progress => Object.assign(job, progress) });
        const reportFile = path.join(directory, `${id}.background.json`), temporary = `${reportFile}.${randomUUID()}.tmp`;
        try { await fs.promises.writeFile(temporary, JSON.stringify(report, null, 2)); await fs.promises.rename(temporary, reportFile); }
        finally { await fs.promises.rm(temporary, { force: true }); }
        job.status = "completed";
        return { file: output, history: result.history };
      }).catch(error => { job.status = "failed"; job.error = error.message; throw error; });
      backgroundTail = job.work.catch(() => {});
    }
    if (wait) return job.work;
    return { file: null, history: result.history, processing: job.status !== "failed", processingError: job.error || null, processedFrames: job.frames };
  }

  async function resolveForFrames(id) {
    const result = await resolve(id);
    if (lockedFile(id)) {
      const report = JSON.parse(await fs.promises.readFile(path.join(directory, `${id}.background.json`), "utf8"));
      if (report.alphaFile === `${id}.background.alpha.mkv`) return { ...result, file: path.join(directory, report.alphaFile), preservedAlpha: true };
    }
    return result;
  }

  return { cachedFile, resolve, resolveRaw, resolveForFrames };
}
