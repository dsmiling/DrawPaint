import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const project = fileURLToPath(new URL("../../", import.meta.url));
const runtime = path.join(project, ".cache/ui-vision");
const worker = fileURLToPath(new URL("../../scripts/ui-vision/worker.py", import.meta.url));
let queue = Promise.resolve(), cachedHealth, healthPromise;
export function visionPaths() {
  return { python: process.env.DRAWPAINT_VISION_PYTHON || path.join(runtime, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
    checkpoint: process.env.DRAWPAINT_SAM_CHECKPOINT || path.join(runtime, "sam_vit_b_01ec64.pth") };
}
export function runVision(command, params = {}, signal) {
  const execute = () => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("任务已取消"));
    const { python, checkpoint } = visionPaths();
    if (!fs.existsSync(python)) return reject(new Error("本地视觉环境未安装，请运行 scripts/setup-ui-vision.ps1"));
    if (!["ocr", "segment", "repair", "health"].includes(command)) return reject(new Error("无效的视觉操作"));
    const args = [worker, command, "--checkpoint", checkpoint];
    for (const [key, value] of Object.entries(params)) {
      if (!["source", "output", "plan", "mask", "device"].includes(key)) return reject(new Error("无效的视觉参数"));
      args.push(`--${key}`, String(value));
    }
    const child = spawn(python, args, { windowsHide: true, cwd: project, env: { ...process.env, PYTHONUTF8: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "", timedOut = false;
    const abort = () => child.kill();
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, command === "health" ? 60000 : 10 * 60 * 1000);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { output = (output + chunk).slice(-2 * 1024 * 1024); });
    child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-2000); });
    const clear = () => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); };
    child.once("error", error => { clear(); reject(error); });
    child.once("close", code => {
      clear();
      if (signal?.aborted) return reject(new Error("任务已取消"));
      if (timedOut) return reject(new Error("本地视觉处理超时，请减少组件或图像尺寸"));
      if (code !== 0) return reject(new Error(`本地视觉处理失败：${errors.trim() || `exit ${code}`}`));
      try { resolve(JSON.parse(output.trim().split(/\r?\n/).at(-1))); } catch { reject(new Error("本地视觉处理没有返回有效结果")); }
    });
  });
  // One encoder at a time across all service instances: avoid exhausting VRAM.
  const result = queue.then(execute, execute);
  queue = result.catch(() => {});
  return result;
}
export async function visionHealth() {
  if (cachedHealth && Date.now() - cachedHealth.time < 30000) return cachedHealth.value;
  if (healthPromise) return healthPromise;
  healthPromise = checkHealth().finally(() => { healthPromise = null; });
  return healthPromise;
}
async function checkHealth() {
  const paths = visionPaths();
  let value;
  if (!fs.existsSync(paths.python) || !fs.existsSync(paths.checkpoint)) value = { ready: false, reason: "本地 OCR / SAM 尚未安装" };
  else try { value = await runVision("health"); } catch (e) { value = { ready: false, reason: e.message }; }
  cachedHealth = { time: Date.now(), value };
  return value;
}
