import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import { QWEN_MODELS, createQwenImageClient, qwenCanvasSize } from "../server/qwen-images.mjs";
import { createQwenCanvas } from "../server/qwen-canvas.mjs";
import { UiStudioService } from "../server/ui-studio/service.mjs";
import { initCanvasLayout, agentRequestPath, readJson, writeJson, snapshotPath, pendingRequestPath, pendingInsertsPath } from "../server/storage.mjs";

function workspace(t) {
  const base = path.resolve("tmp"); fs.mkdirSync(base, { recursive: true });
  const project = fs.mkdtempSync(path.join(base, "qwen-test-"));
  assert.ok(project.startsWith(`${base}${path.sep}`));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  return { project, canvas: initCanvasLayout(project) };
}
const png = () => sharp({ create: { width: 64, height: 64, channels: 4, background: "#443399" } }).png().toBuffer();
function nodeInfo() {
  const info = Object.fromEntries(["UNETLoader", "CLIPLoader", "VAELoader", "TextEncodeQwenImage21", "QwenImage21Cache", "EmptyLatentImage", "KSampler", "VAEDecode", "SaveImage", "LoadImage"].map(name => [name, {}]));
  info.UNETLoader.input = { required: { unet_name: [[QWEN_MODELS.diffusion]] } };
  info.CLIPLoader.input = { required: { clip_name: [[QWEN_MODELS.encoder]] } };
  info.VAELoader.input = { required: { vae_name: [[QWEN_MODELS.vae]] } };
  return info;
}
async function eventually(condition) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await delay(10); }
  assert.fail("Task did not finish");
}

test("local client detects missing models and uploads all editing references before submitting", async () => {
  const calls = [], id = randomUUID(), image = await png(), info = nodeInfo();
  const client = createQwenImageClient({ pollMs: 1, fetchImpl: async (url, options) => {
    const route = new URL(url).pathname; calls.push({ route, options });
    if (route === "/object_info") return Response.json(info);
    if (route === "/upload/image") return Response.json({ name: `ref-${calls.length}.png`, subfolder: "refs" });
    if (route === "/prompt") return Response.json({ prompt_id: id });
    if (route === `/history/${id}`) return Response.json({ [id]: { status: { completed: true }, outputs: { "9": { images: [{ filename: "result.png", subfolder: "DrawPaintQwen", type: "output" }] } } } });
    if (route === "/view") return new Response(image);
    throw new Error(route);
  } });
  info.VAELoader.input.required.vae_name[0] = [];
  const setup = await client.health(); assert.equal(setup.ready, false); assert.deepEqual(setup.missingModels, [QWEN_MODELS.vae]);
  await assert.rejects(client.submit({ prompt: "edit", references: [image] }), /缺少 Qwen 模型/);
  assert.equal(calls.filter(call => call.route === "/prompt").length, 0);
  info.VAELoader.input.required.vae_name[0] = [QWEN_MODELS.vae];
  const queued = await client.submit({ prompt: "Make a matching button", width: 1344, height: 768, references: [image, image], quality: "low" });
  assert.equal(queued, id);
  const graph = JSON.parse(calls.find(call => call.route === "/prompt").options.body).prompt;
  assert.equal(graph["10"].inputs.image.startsWith("refs/"), true);
  assert.ok(graph["4"].inputs["images.image_2"]);
  assert.deepEqual(await client.wait(id), image);
});

test("execution failures, interrupted waits, malformed output and nonlocal services cannot be mistaken for completion", async () => {
  assert.throws(() => createQwenImageClient({ baseUrl: "http://example.com:8188" }), /本机/);
  const id = randomUUID();
  let history = { status: { status_str: "error", messages: [["execution_error", { exception_message: "out of memory" }]] } };
  const client = createQwenImageClient({ fetchImpl: async () => Response.json({ [id]: history }) });
  await assert.rejects(client.result(id), /out of memory/);
  history = { outputs: { "9": { images: [{ filename: "../secret.png", type: "output" }] } } };
  await assert.rejects(client.result(id), /引用无效/);
  await assert.rejects(client.wait(id, AbortSignal.abort(new Error("cancelled"))), /cancelled/);
  const sized = qwenCanvasSize(4096, 2304);
  assert.ok(sized.width * sized.height < 1100000); assert.ok(sized.width > sized.height);
  assert.deepEqual(qwenCanvasSize(512, 512), { width: 512, height: 512 });
});

function saveHolder(canvas) {
  writeJson(snapshotPath(canvas), { document: { store: {
    "page:p": { id: "page:p", typeName: "page" },
    "shape:holder": { id: "shape:holder", typeName: "shape", type: "frame", parentId: "page:p", index: "a1", x: 10, y: 20,
      rotation: 0, props: { w: 320, h: 180 }, meta: { drawpaintAiImageHolder: true } },
  } } });
}
test("canvas rejects duplicate submissions, replaces the correct holder and recovers accepted tasks without resubmission", async t => {
  const { canvas } = workspace(t); saveHolder(canvas);
  const image = await png(), id = randomUUID(), promptId = randomUUID();
  let submitted = 0, finish;
  const client = { submit: async () => { submitted++; return promptId; }, wait: () => new Promise(resolve => { finish = resolve; }) };
  const runner = createQwenCanvas(canvas, client);
  const request = { id, provider: "qwen", status: "pending", prompt: "button", generationPrompt: "blue button", type: "ai_image_generate", anchorShapeId: "shape:holder" };
  writeJson(agentRequestPath(canvas, id), request); writeJson(pendingRequestPath(canvas), request);
  await runner.dispatch(request);
  await assert.rejects(runner.dispatch(request), /重复/); assert.equal(submitted, 1);
  finish(image); await eventually(() => readJson(agentRequestPath(canvas, id)).status === "completed");
  const store = readJson(snapshotPath(canvas)).document.store;
  assert.equal(store["shape:holder"], undefined);
  const shape = Object.values(store).find(record => record.type === "image" && record.typeName === "shape");
  assert.deepEqual([shape.x, shape.y, shape.props.w, shape.props.h], [10, 20, 320, 180]);
  assert.equal(readJson(pendingInsertsPath(canvas)).length, 1);
  assert.equal(readJson(pendingRequestPath(canvas)), null);
  writeJson(agentRequestPath(canvas, id), { ...request, status: "qwen_queued", qwenPromptId: promptId });
  createQwenCanvas(canvas, { wait: () => assert.fail("Already inserted image must not be inserted twice") });
  assert.equal(readJson(agentRequestPath(canvas, id)).status, "completed");
  assert.equal(readJson(pendingInsertsPath(canvas)).length, 1);
  const recoveredId = randomUUID();
  writeJson(agentRequestPath(canvas, recoveredId), { ...request, id: recoveredId, type: "generate", status: "qwen_queued", qwenPromptId: promptId });
  createQwenCanvas(canvas, { submit: () => assert.fail("Must not resubmit"), wait: async value => { assert.equal(value, promptId); return image; } });
  await eventually(() => readJson(agentRequestPath(canvas, recoveredId)).status === "completed");
});

test("annotation edits send the original, location guide and content reference, and keep the source in place", async t => {
  const { canvas } = workspace(t); const image = await png();
  const assetDir = path.join(canvas, "pages", "default", "assets");
  for (const name of ["original", "guide", "element"]) fs.writeFileSync(path.join(assetDir, `${name}.png`), image);
  writeJson(snapshotPath(canvas), { document: { store: {
    "page:p": { id: "page:p", typeName: "page" },
    "asset:original": { id: "asset:original", typeName: "asset", props: { src: "/api/assets/original.png" } },
    "shape:original": { id: "shape:original", typeName: "shape", type: "image", parentId: "page:p", index: "a1", x: 10, y: 20, props: { w: 320, h: 180, assetId: "asset:original" } },
  } } });
  let options;
  const runner = createQwenCanvas(canvas, { submit: async input => { options = input; return randomUUID(); }, wait: async () => image });
  const request = { id: randomUUID(), provider: "qwen", status: "pending", type: "annotate_edit", prompt: "internal instructions", anchorShapeId: "shape:original",
    screenshotAbsolutePath: path.join(assetDir, "guide.png"), referencePaths: [path.join(assetDir, "element.png")],
    selection: { shapes: [{ props: { text: "Replace the icon" } }] }, targetWidth: 320, targetHeight: 180 };
  writeJson(agentRequestPath(canvas, request.id), request);
  await runner.dispatch(request); await eventually(() => readJson(agentRequestPath(canvas, request.id)).status === "completed");
  assert.equal(options.references.length, 3); assert.match(options.prompt, /Replace the icon/); assert.doesNotMatch(options.prompt, /internal instructions/);
  const store = readJson(snapshotPath(canvas)).document.store;
  assert.ok(store["shape:original"]);
  const edited = Object.values(store).find(record => record.meta?.drawpaintRequestId === request.id);
  assert.equal(edited.x, 370); assert.equal(edited.props.w, 320);
});

test("cancelling a Qwen canvas task removes only its queue item and prevents late insertion", async t => {
  const { canvas } = workspace(t); saveHolder(canvas);
  const promptId = randomUUID(), cancelled = []; let finish;
  const runner = createQwenCanvas(canvas, { submit: async () => promptId, wait: () => new Promise(resolve => { finish = resolve; }), cancel: async id => cancelled.push(id) });
  const request = { id: randomUUID(), provider: "qwen", status: "pending", prompt: "button", type: "ai_image_generate", anchorShapeId: "shape:holder" };
  writeJson(agentRequestPath(canvas, request.id), request);
  await runner.dispatch(request); await runner.cancel(request.id); finish(await png()); await delay(10);
  assert.deepEqual(cancelled, [promptId]); assert.equal(readJson(agentRequestPath(canvas, request.id)).status, "cancelled");
  assert.ok(readJson(snapshotPath(canvas)).document.store["shape:holder"]);
  assert.equal(readJson(pendingInsertsPath(canvas)).length, 0);
});

test("UI Qwen generation works without an Agent or API key and enters the existing cutting/export workflow", async t => {
  const { canvas } = workspace(t), image = await png(), id = randomUUID();
  const calls = [];
  const service = new UiStudioService(canvas, {
    agentConnection: { status: () => assert.fail("Local generation must not check Agent") },
    qwenClient: { health: async () => ({ ready: true }), submit: async options => { calls.push(options); return id; }, wait: async () => image },
  });
  const job = await service.create({ kind: "generate", provider: "qwen", workflow: "mockup", prompt: "A game menu", size: "1344x768" });
  await service.running.get(job.id).promise;
  const done = service.get(job.id);
  assert.equal(done.status, "ready", done.error); assert.equal(done.qwenPromptId, id);
  assert.equal(done.slices.length, 1); assert.ok(fs.existsSync(path.join(service.directory(job.id), done.sourceFile)));
  assert.equal(calls[0].width, 1344);
  const exported = await service.exportPreset(done.id, { revision: done.revision, format: "unity" });
  assert.ok(fs.existsSync(service.asset(done.id, exported.file)));
});

test("UI service restart waits for an accepted Qwen prompt instead of generating again", async t => {
  const { canvas } = workspace(t), image = await png(), id = randomUUID(), promptId = randomUUID();
  const jobDir = path.join(canvas, "ui-studio", "jobs", id); fs.mkdirSync(jobDir, { recursive: true });
  writeJson(path.join(jobDir, "job.json"), { id, provider: "qwen", kind: "generate", workflow: "mockup", prompt: "menu", size: "1024x1024", status: "generating", qwenPromptId: promptId,
    references: [], options: { removeBackground: false, autoSplit: false, padding: 0 }, createdAt: new Date().toISOString() });
  const service = new UiStudioService(canvas, { qwenClient: { submit: () => assert.fail("Must not resubmit"), wait: async value => { assert.equal(value, promptId); return image; } } });
  await delay(0); await service.running.get(id).promise;
  assert.equal(service.get(id).status, "ready", service.get(id).error);
});
