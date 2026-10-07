import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { prepareAnimationReferences } from "../server/video-animation-input.mjs";
import { frameAnimationPrompt, normalizeFrameAnimation } from "../shared/frame-animation.js";
import { normalizeProject } from "../server/video-editor.mjs";
import { VIDEO_MODELS } from "../server/video-models.mjs";

async function sprite({ foreground = [240, 180, 20, 255], background = [20, 30, 50, 255], x = 12, y = 10, w = 8, h = 12 } = {}) {
  const data = Buffer.alloc(32 * 32 * 4);
  for (let p = 0; p < 32 * 32; p++) data.set(background, p * 4);
  for (let row = y; row < y + h; row++) for (let column = x; column < x + w; column++) data.set(foreground, (row * 32 + column) * 4);
  return sharp(data, { raw: { width: 32, height: 32, channels: 4 } }).png().toBuffer();
}
const pixels = async buffer => sharp(buffer).ensureAlpha().raw().toBuffer();

test("ordinary video preserves both source images and omits animation constraints", async () => {
  const image = await sprite(), last = await sprite({ x: 14 });
  const result = await prepareAnimationReferences(image, last, { enabled: false, background: "#00ff00" });
  assert.strictEqual(result.image, image); assert.strictEqual(result.lastImage, last);
  assert.equal(result.settings.enabled, false); assert.equal(result.preparation, undefined);
  assert.equal(normalizeFrameAnimation(null).enabled, false);
  assert.throws(() => normalizeFrameAnimation({ enabled: "true" }), /设置/);
  assert.throws(() => normalizeFrameAnimation({ enabled: true, background: "#132035" }), /底色/);
});

test("animation references share a solid absent key while preserving the foreground", async () => {
  const image = await sprite(), lastImage = await sprite({ x: 14 });
  const result = await prepareAnimationReferences(image, lastImage, { enabled: true, background: "auto" });
  assert.equal(result.settings.background, "#ff00ff");
  assert.equal(result.preparation.padded, false);
  for (const [buffer, x] of [[result.image, 14], [result.lastImage, 16]]) {
    const data = await pixels(buffer);
    assert.deepEqual(Array.from(data.subarray(0, 4)), [255, 0, 255, 255]);
    assert.deepEqual(Array.from(data.subarray((15 * 32 + x) * 4, (15 * 32 + x) * 4 + 4)), [240, 180, 20, 255]);
  }
  assert.deepEqual(Array.from((await pixels(image)).subarray(0, 4)), [20, 30, 50, 255]);
  const prompt = frameAnimationPrompt("在深蓝背景上挥剑", result.settings.background);
  assert.match(prompt, /在深蓝背景上挥剑/); assert.match(prompt, /#FF00FF/);
  assert.match(prompt, /不要恢复/); assert.match(prompt, /固定镜头/); assert.match(prompt, /4%/);
});

test("key choice considers both frames and transparent source colours", async () => {
  const first = await sprite({ background: [0, 0, 0, 0] });
  const last = await sprite({ background: [0, 0, 0, 0], foreground: [235, 20, 225, 255] });
  const result = await prepareAnimationReferences(first, last, { enabled: true, background: "auto" });
  assert.equal(result.settings.background, "#00ff00");
  assert.deepEqual(Array.from((await pixels(result.image)).subarray(0, 4)), [0, 255, 0, 255]);
  assert.deepEqual(Array.from((await pixels(result.lastImage)).subarray((15 * 32 + 14) * 4, (15 * 32 + 14) * 4 + 4)), [235, 20, 225, 255]);
  await assert.rejects(prepareAnimationReferences(first, last, { enabled: true, background: "#ff00ff" }), /主体含有/);
});

test("shared padding keeps both references aligned and complex backgrounds require prepared artwork", async () => {
  const first = await sprite({ background: [0, 0, 0, 0], x: 0, w: 14 }), last = await sprite({ background: [0, 0, 0, 0], x: 1, w: 14 });
  const result = await prepareAnimationReferences(first, last, { enabled: true });
  assert.equal(result.preparation.padded, true);
  for (const buffer of [result.image, result.lastImage]) {
    const data = await pixels(buffer);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 2; x++) assert.deepEqual(Array.from(data.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)), [255, 0, 255, 255]);
  }
  const mixed = Buffer.alloc(32 * 32 * 4);
  for (let p = 0; p < 32 * 32; p++) mixed.set(p % 32 < 16 ? [0, 0, 255, 255] : [255, 255, 0, 255], p * 4);
  const image = await sharp(mixed, { raw: { width: 32, height: 32, channels: 4 } }).png().toBuffer();
  await assert.rejects(prepareAnimationReferences(image, null, { enabled: true }), /素材工坊/);
  await assert.rejects(prepareAnimationReferences(await sprite({ foreground: [20, 30, 50, 255] }), null, { enabled: true }), /为空/);
});

test("generation API submits distinct ordinary and animation graphs and persists their purpose", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drawpaint-animation-api-"));
  const projectDir = path.join(root, "DrawPaint"), originalFetch = globalThis.fetch, previousProject = process.env.DRAWPAINT_PROJECT_DIR;
  const uploads = [], graphs = [];
  let server;
  try {
    fs.mkdirSync(projectDir);
    for (const [folder, file] of VIDEO_MODELS[0].files) {
      const directory = path.join(root, "ComfyUI", "models", folder);
      fs.mkdirSync(directory, { recursive: true });
      const filename = path.join(directory, file); fs.writeFileSync(filename, ""); fs.truncateSync(filename, 1024 * 1024);
    }
    process.env.DRAWPAINT_PROJECT_DIR = projectDir;
    globalThis.fetch = async (url, options) => {
      if (!String(url).startsWith("http://127.0.0.1:8188/")) return originalFetch(url, options);
      const route = new URL(url).pathname;
      if (route === "/system_stats") return Response.json({});
      if (route === "/object_info") return Response.json(Object.fromEntries(VIDEO_MODELS[0].nodes.map(name => [name, {}])));
      if (route === "/upload/image") {
        const file = options.body.get("image"); uploads.push(Buffer.from(await file.arrayBuffer()));
        return Response.json({ name: file.name });
      }
      if (route === "/prompt") { graphs.push(JSON.parse(options.body).prompt); return Response.json({ prompt_id: randomUUID() }); }
      if (route.startsWith("/history/")) return Response.json({});
      throw new Error(`Unexpected ComfyUI request: ${route}`);
    };
    const { handleVideo } = await import("../server/video.mjs");
    server = createServer(async (req, res) => { if (!await handleVideo(req, res, new URL(req.url, "http://localhost"))) { res.writeHead(404); res.end(); } });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const first = await sprite(), last = await sprite({ x: 14 });
    const input = { image: `data:image/png;base64,${first.toString("base64")}`, lastImage: `data:image/png;base64,${last.toString("base64")}`, prompt: "深蓝背景，原地挥剑", modelId: "minimax-h3", seconds: 2 };
    const post = async value => {
      const response = await originalFetch(base + "/api/video/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, ...value }) });
      const body = await response.json(); assert.equal(response.status, 200, body.error); return body;
    };
    const ordinary = await post({ frameAnimation: { enabled: false } });
    assert.equal(graphs[0]["105:104"].inputs.prompt, input.prompt);
    assert.deepEqual(uploads[0], first); assert.deepEqual(uploads[1], last);
    const animation = await post({ frameAnimation: { enabled: true, background: "auto" } });
    assert.match(graphs[1]["105:104"].inputs.prompt, /#FF00FF/);
    assert.deepEqual(Array.from((await pixels(uploads[2])).subarray(0, 4)), [255, 0, 255, 255]);
    assert.deepEqual(Array.from((await pixels(uploads[3])).subarray(0, 4)), [255, 0, 255, 255]);
    const stored = JSON.parse(fs.readFileSync(path.join(projectDir, "canvas", "video-job-options.json")));
    assert.equal(stored[ordinary.id].frameAnimation.enabled, false);
    assert.equal(stored[animation.id].frameAnimation.background, "#ff00ff");
    assert.equal(stored[animation.id].lockBackground, true);
    assert.equal(stored[ordinary.id].lockBackground, false);
    const jobs = await (await originalFetch(base + "/api/video/jobs")).json();
    assert.equal(jobs.jobs.find(job => job.id === animation.id).frameAnimation.enabled, true);
    const clip = { id: randomUUID(), source: { type: "job", id: animation.id }, in: 0, out: 2, position: 0, track: 0, status: "completed", frameAnimation: animation.frameAnimation };
    assert.deepEqual(normalizeProject({ clips: [clip] }).clips[0].frameAnimation, animation.frameAnimation);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousProject === undefined) delete process.env.DRAWPAINT_PROJECT_DIR; else process.env.DRAWPAINT_PROJECT_DIR = previousProject;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
