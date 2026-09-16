// Start from the current Codex task after the user authorizes the desktop MCP connection.
// Each UI job gets a fresh projectless task; the owner only supplies desktop access.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { agentRequestPath, initCanvasLayout, readJson, resolveProjectDir } from "../server/storage.mjs";
import { uiRequest } from "../server/ui-studio/client.mjs";
import { AgentThreads } from "../server/ui-studio/agent-threads.mjs";

const threadId = process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID;
if (!/^[a-f0-9-]{36}$/.test(threadId || "") || !process.env.CODEX_APP_TOOLS_PIPE_PATH) {
  throw new Error("请从 Codex 桌面任务启动此连接器；素材任务将创建独立新对话。");
}
const project = resolveProjectDir(process.env.DRAWPAINT_PROJECT_DIR);
const root = path.join(initCanvasLayout(project), "ui-studio");
const connectionFile = path.join(root, "agent-connection.local.json");
function findAppTools() {
  if (process.env.DRAWPAINT_APP_TOOLS_SERVER) return path.resolve(process.env.DRAWPAINT_APP_TOOLS_SERVER);
  const directory = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "plugins/cache/openai-bundled/codex-app-tools");
  const versions = fs.readdirSync(directory).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const entry = versions.map(v => path.join(directory, v, "server.mjs")).find(file => fs.existsSync(file));
  if (!entry) throw new Error("未找到 Codex 自带的 app-tools MCP 插件。");
  return entry;
}
const client = new Client({ name: "drawpaint-ui-agent-bridge", version: "0.1.0" });
const token = randomBytes(32).toString("hex");
const authorization = Buffer.from(`Bearer ${token}`);
let connected = false;
let statusTimer;
const transport = new StdioClientTransport({
  command: process.env.CODEX_MCP_NODE_PATH || process.execPath,
  args: [findAppTools()], cwd: project,
  env: Object.fromEntries(Object.entries(process.env).filter(([name]) => ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_MCP_NODE_PATH", "PATH", "USERPROFILE", "LOCALAPPDATA", "SYSTEMROOT", "TEMP", "TMP", "HOME"].includes(name.toUpperCase()))),
  stderr: "pipe",
});
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args, _meta: { "openai/threadId": threadId } }, undefined, { timeout: 30000 });
  if (result.isError) throw new Error("桌面 Agent 未接受请求，请检查 Codex 中的任务或权限提示。");
  return result;
}
function taskMessageFor(job) {
  if (job.kind === "canvas") return [
    `Execute ordinary DrawPaint canvas request ${job.id}.`,
    `Run node scripts/drawpaint.mjs request ${job.id} and inspect every screenshot and reference path returned.`,
    "Use the built-in image generation/editing tool to produce the requested final bitmap. For annotation edits, the screenshot defines WHERE and elementRefs/referencePaths define WHAT; return a clean image without annotation marks.",
    `Submit exactly once with node scripts/drawpaint.mjs complete ${job.id} <absolute-image-path>. On failure run node scripts/drawpaint.mjs fail ${job.id} \"brief reason\".`,
  ].join("\n");
  if(job.reviewBeforePublish && job.operation === "decompose") return [
    `Execute candidate generation for job ${job.id}, attempt ${job.attempt || 0}. First run node scripts/ui-studio.mjs claim ${job.id}; stop if claiming fails.`,
    "Follow the returned candidate review contract. Generate only requested retryRegionIds when present; the server retains other layers. Submit candidates despite visual differences or insufficient resolution, so the user can inspect them. Do not reject the entire batch for minor style differences. Never approve, publish or archive on behalf of the user.",
    `Submit via node scripts/ui-studio.mjs ${job.method === "hybrid" ? "complete-repairs" : "complete-layers"} ${job.id} <absolute-manifest-path>. Successful candidate delivery ends in review_repairs, not ready. Report that candidates await user review; do not call fail merely because they are not on the canvas yet.`,
  ].join("\n");
  if (job.autoContinue && job.method === "hybrid") return [
    `Execute DrawPaint split job ${job.id}. First run node scripts/ui-studio.mjs claim ${job.id}; stop if claiming fails.`,
    "Follow generationPrompt, instructions and splitOptions returned by claim exactly. Open matching reusableComponents and compare them with the source. Reuse assets that meet appearance, aspect ratio and resolution requirements; generate only missing parts. Submit sheets + repairs for sheet mode and sourcePixels for source pixel mode. Masks are boundary references only.",
    `Inspect every layer, its transparency and the reconstructed composition before running node scripts/ui-studio.mjs complete-repairs ${job.id} <absolute-JSON-path>. After server validation the status should be ready, meaning assets are prepared, not proof of canvas delivery. Run node scripts/ui-studio.mjs diagnose ${job.id} and report the actual asset and saved-canvas counts separately. Do not resubmit, regenerate or call approve-repairs just because canvas delivery is pending. Report failures using fail.`,
  ].join("\n");
  if (job.method === "hybrid" && job.maskPurpose === "reference") return [
    `Execute DrawPaint mask-guided full-layer generation job ${job.id}. First run node scripts/ui-studio.mjs claim ${job.id}; stop if claiming fails.`,
    "Inspect reusableComponents returned by claim. Open potential matches and compare patterns, colors, exact text, state and sharpness with the source. Reference matching layers using reuse:{jobId,revision,sliceId}; never regenerate them. For missing or mismatched layers only, inspect the source referencePaths, numbered annotations and corresponding imagePath and guidePath. Pass the source and annotations together as references to built-in image_gen to generate complete high-resolution PNGs. Masks guide boundaries only and do not constrain output transparency. All-reuse and mixed reuse/generation results are allowed.",
    `Follow generationPrompt and save {repairs:[{regionId,reuse?,imagePath?,background?,allowOpaque?,generatedRect?}]}, choosing either reuse or a new image for each layer. Run node scripts/ui-studio.mjs complete-repairs ${job.id} <absolute-JSON-path>. Once the status is review_repairs, end this turn so the user can inspect individual layers and reconstruction. Do not call approve-repairs on their behalf. Report failures using fail.`,
  ].join("\n");
  if (job.method === "hybrid") return [
    `Execute DrawPaint local repair job ${job.id} after source segmentation. First run node scripts/ui-studio.mjs claim ${job.id}; stop if claiming fails.`,
    "Inspect each imagePath and maskPath in repairRequests. Use built-in image_gen to repair only white mask regions. If output dimensions change or padding is added, inspect the generated result and provide generatedRect alignment according to generationPrompt; do not guess. Source assets have already been segmented; the server accepts repaired pixels only inside the mask.",
    `Follow generationPrompt and save {repairs:[{regionId,imagePath,generatedRect?}]}. Run node scripts/ui-studio.mjs complete-repairs ${job.id} <absolute-JSON-path>. Once the status is review_repairs, end this turn for the user to inspect and approve on the canvas. Do not call approve-repairs on their behalf. Report failure reasons using fail.`,
  ].join("\n");
  if (job.operation === "plan" || job.workflow === "mockup" && !job.operation) return [
    `Execute DrawPaint ${job.operation === "plan" ? "mockup decomposition analysis" : "complete interface mockup generation"} job ${job.id}.`,
    `First run node scripts/ui-studio.mjs claim ${job.id}; stop immediately if claiming fails. Read generationPrompt, referencePaths and instructions, and inspect reference images first.`,
    job.operation === "plan"
      ? `Analyze component bounds, types and stacking order only; do not generate images. Save {regions:[...]} as JSON and run node scripts/ui-studio.mjs complete-plan ${job.id} <absolute-JSON-path>.`
      : `Use built-in image_gen according to generationPrompt to generate a complete interface mockup. Preserve the full background and assembled interface; do not generate an asset atlas. Run node scripts/ui-studio.mjs complete ${job.id} <absolute-image-path> and wait for ready. Do not classify or further split the mockup; the user will review it and initiate analysis.`,
    `On failure run node scripts/ui-studio.mjs fail ${job.id} "reason". Do not modify ordinary canvas pending requests.`,
  ].join("\n");
  if (job.operation === "classify") return [
    `Execute DrawPaint component classification job ${job.id}. Project directory: ${project}`,
    `First run node scripts/ui-studio.mjs claim ${job.id}; stop immediately if claiming fails. Read generationPrompt, referencePaths, slicePaths and instructions.`,
    "Inspect the atlas and any necessary slice images to identify component types, names, text and font information. Classify existing images only; do not call image_gen, redraw or move assets.",
    `Save classification JSON and run node scripts/ui-studio.mjs complete-classification ${job.id} <absolute-JSON-path>. If unable to complete, run node scripts/ui-studio.mjs fail ${job.id} "reason".`,
  ].join("\n");
  if (job.operation === "decompose") return [
    `Execute AI decomposition job ${job.id} submitted from the DrawPaint layers panel. Project directory: ${project}`,
    `First run node scripts/ui-studio.mjs claim ${job.id} and read generationPrompt, referencePaths and instructions. Stop if claiming fails; do not generate duplicates.`,
    "Inspect the parent component reference and reusableComponents returned by claim. Open potential matches and compare semantic layers such as bases, icons, text and borders. When patterns, colors, text and state match, use reuse:{jobId,revision,sliceId}; never regenerate matching layers. Use built-in image_gen only for missing layers, preferably with a uniform magenta background declared as background:'#ff00ff'. Validate against generationPrompt. Do not simulate transparency with checkerboards or substitute whole-image copies or rectangular crops for layer separation. No API key is needed.",
    `Save each layer's absolute imagePath or reuse reference, name, layerType, x/y/w/h and zIndex in {layers:[...]} JSON, then run node scripts/ui-studio.mjs complete-layers ${job.id} <absolute-JSON-path>.`,
    "The server imports the layer manifest and preserves parent-child nodes. Do not submit an atlas using complete or modify ordinary canvas pending requests.",
    `If decomposition or generation fails, run node scripts/ui-studio.mjs fail ${job.id} "brief reason" and report the failure accurately.`,
  ].join("\n");
  return [
    `Execute image generation job ${job.id} submitted from the DrawPaint UI asset canvas.`,
    `Project directory: ${project}`,
    `First run node scripts/ui-studio.mjs claim ${job.id} to claim the job and read generationPrompt and referencePaths.`,
    "If the job is already claimed, cancelled or finished, stop; do not generate duplicates.",
    "Use the current Agent's built-in image_gen tool to generate the final UI atlas according to generationPrompt. Inspect reference images first, if any. Do not use an image generation API or substitute code drawing for actual image generation. No API key is needed.",
    `After generation run node scripts/ui-studio.mjs complete ${job.id} "absolute-generated-image-path".`,
    `After slicing, run node scripts/ui-studio.mjs request ${job.id}. Inspect atlasFile and the slice images. Identify each component's name and layerType (button/text/icon/texture/background/border/decoration/component), include text for text content, and leave unconfirmed fonts empty. Save {revision,metadataRevision:0,presetName,source:"ai",slices:[{id,name,layerType,text?}]} as JSON, then run node scripts/ui-studio.mjs metadata ${job.id} <absolute-JSON-path>. Do not use only numbered names such as ui_001 as final classifications.`,
    "The server automatically returns the result, removes the background, slices assets and places them on the independent UI canvas. Do not modify ordinary canvas pending requests.",
    `If the built-in image generation tool is unavailable or fails, run node scripts/ui-studio.mjs fail ${job.id} "brief failure reason" and report it accurately. Do not repeatedly retry or silently switch to an API.`,
  ].join("\n");
}
function messageFor(job) {
  if (job.kind === "canvas") {
    const command = `node "${path.join(project, "scripts", "drawpaint.mjs")}"`;
    return taskMessageFor(job).replaceAll("node scripts/drawpaint.mjs", command);
  }
  const command = `node "${path.join(project, "scripts", "ui-studio.mjs")}"`;
  return [
    "This is an independent asset job submitted by the user from DrawPaint. Execute only this job; do not read or continue other conversation histories or create additional conversations. The working directory is dedicated to this output. Access existing references and components only through paths explicitly provided for this request. Write model-facing instructions and image-generation prompts in English. Preserve exact user-requested in-image text in its original language; user-facing summaries and UI labels should remain Chinese.",
    `The local DrawPaint API port is ${Number(process.env.DRAWPAINT_API_PORT || 43218)}. Set the DRAWPAINT_API_PORT environment variable to this port before running the CLI below. Commands use an absolute script path; changing to the project directory is not required.`,
    taskMessageFor(job).replaceAll("node scripts/ui-studio.mjs", command),
    `After submitting results, wait for server processing to finish, then run ${command} diagnose ${job.id}. Report the job ID, actual stage/status, generated layer count, missing files, and saved-canvas present/expected count in Chinese. For plan jobs, analysis completion is not image completion; report continuationId and any downstream failure. ready only means server assets are prepared; only a complete saved-canvas count is evidence of saved delivery, not visual acceptance. If the browser has not saved/imported yet, explicitly say so and do not regenerate. Atlas jobs must also complete classification. Keep this conversation open for the user's inspection: never archive it or call set_thread_archived. If execution failed or needs permission/input, report the actual error instead of saying the split completed.`,
  ].join("\n\n");
}
async function requestForThread(route, record) {
  if (record?.kind !== "canvas") return uiRequest(route);
  const request = readJson(agentRequestPath(initCanvasLayout(project), record.jobId), null);
  if (!request || request.status === "completed") return { status: "ready" };
  return { status: request.status === "failed" ? "failed" : "dispatched", error: request.error || null };
}
const agentThreads = new AgentThreads(root, { call, request: requestForThread, ownerThreadId: threadId, messageFor });
async function monitorStatus() {
  if (!connected) return;
  try { await agentThreads.poll(); }
  catch (error) { console.error(`独立对话状态检查失败，将稍后重试：${error.message}`); }
  if (connected) statusTimer = setTimeout(monitorStatus, 15000);
}
function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
const server = http.createServer(async (req, res) => {
  const provided = Buffer.from(req.headers.authorization || "");
  if (req.headers.origin || provided.length !== authorization.length || !timingSafeEqual(provided, authorization)) {
    json(res, 403, { error: "Forbidden" }); return;
  }
  try {
    if (req.method === "GET" && req.url === "/health") { json(res, 200, { connected, dispatchMode: "new-thread", autoArchive: false }); return; }
    if (req.method !== "POST" || !["/dispatch","/dispatch-canvas","/open-thread"].includes(req.url)) { json(res, 404, { error: "Not found" }); return; }
    if (!connected) throw new Error("Agent 已断开，请重新连接。");
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 4096) throw new Error("请求过大"); chunks.push(chunk); }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const jobId = input.jobId || input.requestId;
    if (!/^[a-f0-9-]{36}$/.test(jobId || "")) throw new Error("Invalid UI task ID");
    if (req.url === "/open-thread") {
      const record=[...agentThreads.jobs.values()].filter(r=>r.jobId===jobId).at(-1);
      if(!record?.threadId || record.threadId===threadId) throw new Error("该素材任务没有可打开的独立执行对话");
      // Explicit user click; restore historical archived tasks only on request.
      await call("set_thread_archived", {threadId:record.threadId,hostId:record.hostId,archived:false});
      if(record.state === "archived") {record.state="retained";record.restoredAt=new Date().toISOString();agentThreads.save();}
      await call("navigate_to_codex_page", {threadId:record.threadId});
      json(res,200,{opened:true});return;
    }
    if (req.url === "/dispatch-canvas") {
      const request = readJson(agentRequestPath(initCanvasLayout(project), jobId), null);
      if (!request || request.id !== jobId) throw new Error("普通画布待办不存在或已变化");
      const result = await agentThreads.dispatch({ ...request, id: jobId, kind: "canvas", operation: "canvas" });
      json(res, 200, result); return;
    }
    const job = await uiRequest(`jobs/${jobId}/agent-request`);
    if (job.provider !== "agent" || job.status !== "agent_dispatching") throw new Error("任务当前不可提交。");
    const result = await agentThreads.dispatch(job);
    json(res, 200, result);
  } catch (error) {
    json(res, 400, { error: error.message });
  }
});
client.onclose = () => { connected = false; };
async function close() {
  connected = false;
  clearTimeout(statusTimer);
  try {
    if (JSON.parse(fs.readFileSync(connectionFile, "utf8")).token === token) fs.unlinkSync(connectionFile);
  } catch { /* Another connector may have replaced this record. */ }
  server.close(); await client.close();
}
process.on("SIGINT", () => close().finally(() => process.exit(0)));
process.on("SIGTERM", () => close().finally(() => process.exit(0)));
try {
  await client.connect(transport);
  const catalog = await client.listTools();
  if (!["read_thread", "create_thread", "wait_threads"].every(name => catalog.tools.some(tool => tool.name === name))) throw new Error("Codex 未提供独立任务创建和状态查询工具。");
  await call("read_thread", { threadId, turnLimit: 1, includeOutputs: false });
  connected = true;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(connectionFile, JSON.stringify({ port: server.address().port, token, threadId, dispatchMode: "new-thread", autoArchive: false }, null, 2), { mode: 0o600 });
  console.log("DrawPaint UI 已连接：每次素材任务创建新对话，执行结束后保留，等待检查。");
  statusTimer = setTimeout(monitorStatus, 15000);
} catch (error) {
  console.error("无法连接 Codex 桌面 MCP 通道。请检查应用是否运行，以及本机连接权限是否已获批准。");
  console.error(`连接诊断：${String(error.message).replaceAll(token, "[redacted]").slice(0, 500)}`);
  await close(); process.exitCode = 1;
}
