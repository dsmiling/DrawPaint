import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { inspectVideoModels } from "./video-models.mjs";

export function createVideoRuntime({ projectDir, canvasDir, comfyUrl = "http://127.0.0.1:8188" }) {
  const studyDir = path.resolve(projectDir, "..");
  const comfyDir = path.join(studyDir, "ComfyUI");
  const startScript = path.join(studyDir, "start_comfy.ps1");
  const logFile = path.join(canvasDir, "video-comfy.log");
  let startedAt = 0;
  let startingChild = null;
  let launchError = "";

  async function status() {
    let connected = false, objectInfo = null, connectionError = "";
    try {
      const response = await fetch(`${comfyUrl}/system_stats`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error(`ComfyUI HTTP ${response.status}`);
      connected = true;
      try {
        const nodes = await fetch(`${comfyUrl}/object_info`, { signal: AbortSignal.timeout(8000) });
        if (nodes.ok) objectInfo = await nodes.json();
      } catch { /* Node checks can be retried without hiding the service state. */ }
    } catch (error) { connectionError = error.message; }
    const models = inspectVideoModels(comfyDir, connected, objectInfo);
    const starting = !connected && Boolean(startingChild) && Date.now() - startedAt < 5 * 60_000;
    return { connected, starting, endpoint: comfyUrl, startAvailable: process.platform === "win32" && fs.existsSync(startScript),
      models, error: connected ? "" : starting ? "ComfyUI 正在启动，模型首次加载可能需要一些时间" : launchError || `无法连接 ComfyUI：${connectionError || "服务未启动"}` };
  }

  async function start() {
    const current = await status();
    if (current.connected || current.starting) return current;
    if (!current.startAvailable) throw new Error(`未找到本机启动脚本：${startScript}`);
    if (!current.models.some(model => model.installed)) throw new Error("没有检测到完整的视频模型权重，请先安装模型文件");
    launchError = "";
    const log = fs.openSync(logFile, "a");
    try {
      const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", startScript], {
        cwd: studyDir, windowsHide: true, stdio: ["ignore", log, log],
      });
      startingChild = child;
      child.on("error", error => { startedAt = 0; startingChild = null; launchError = `ComfyUI 启动失败：${error.message}`; fs.appendFileSync(logFile, `\n[DrawPaint] ${launchError}\n`); });
      child.on("exit", (code, signal) => { startedAt = 0; startingChild = null; launchError = `ComfyUI 启动进程已退出（${code ?? signal}），请检查日志 ${logFile}`; fs.appendFileSync(logFile, `\n[DrawPaint] ${launchError}\n`); });
      child.unref();
      startedAt = Date.now();
    } finally { fs.closeSync(log); }
    return status();
  }

  return { status, start, comfyDir, logFile };
}
