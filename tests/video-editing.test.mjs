import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { unzipSync, strFromU8 } from "fflate";
import { newDraft, patchClip, splitAt, durationOf, endOf, sourceTime, arrangeNodes, editHistory } from "../shared/video-editing.js";
import { normalizeProject, createVideoEditor } from "../server/video-editor.mjs";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", otherId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const clip = { ...newDraft(id, []), source: { type: "asset", id: otherId }, status: "completed", in: .25, out: 1.75, mediaDuration: 2, position: 1, track: 0, playbackRate: 2, startFrame: .5, endFrame: 1.5 };

test("draft creation gives a saved editable node after existing clips and enforces the clip limit", () => {
  const draft = newDraft(otherId, [clip], { x: -36, y: 170 }, { enabled: true, background: "#ff00ff" });
  assert.equal(draft.source, null); assert.equal(draft.status, "draft");
  assert.equal(draft.position, endOf(clip)); assert.equal(draft.nodeX, -36); assert.equal(draft.frameAnimation.enabled, true);
  assert.throws(() => newDraft(id, Array(100).fill(clip)), /100/);
  assert.equal(normalizeProject({ clips: [draft], view: { selectedIds: [otherId, id] } }).view.selectedIds.length, 1);
});

test("property edits retain untouched timing, bound trim markers, and respect locks", () => {
  const odd = { ...clip, out: 1.753, endFrame: 1.701 };
  const renamed = patchClip(odd, { name: "镜头 A", nodeWidth: 999, volume: 2 });
  assert.equal(renamed.out, odd.out); assert.equal(renamed.endFrame, odd.endFrame);
  assert.equal(renamed.nodeWidth, 600); assert.equal(renamed.volume, 1);
  const trimmed = patchClip(clip, { in: 1.25, out: 1.5 });
  assert.equal(trimmed.startFrame, 1.25); assert.ok(trimmed.endFrame < trimmed.out);
  assert.strictEqual(patchClip({ ...clip, locked: true }, { name: "bad" }).name, clip.name);
  assert.equal(patchClip({ ...clip, locked: true }, { locked: false }).locked, false);
  assert.equal(patchClip({ ...clip, locked: true }, { hidden: true }).hidden, true);
});

test("splitting a speed-adjusted clip conserves source coverage, duration and valid frame markers", () => {
  const [left, right] = splitAt(clip, 1.375, otherId);
  assert.equal(left.out, right.in); assert.equal(endOf(left), right.position);
  assert.equal(durationOf(left) + durationOf(right), durationOf(clip));
  assert.equal(sourceTime(clip, right.position), right.in);
  assert.equal(left.endFrame, null); assert.equal(right.startFrame, null);
  assert.throws(() => splitAt(clip, clip.position, otherId), /内部/);
  assert.throws(() => splitAt({ ...clip, locked: true }, 1.375, otherId), /可编辑/);
});

test("node arrangement keeps locked nodes and unselected nodes unchanged", () => {
  const locked = { ...clip, id: otherId, locked: true, nodeX: -100, nodeY: -100 };
  const arranged = arrangeNodes([clip, locked], [id, otherId]);
  assert.strictEqual(arranged[1], locked); assert.notStrictEqual(arranged[0], clip);
  assert.strictEqual(arrangeNodes([clip], [otherId])[0], clip);
});

test("a drag is one undo step and asynchronous media completion survives undo and redo", () => {
  let history = editHistory({}, { type: "reset", document: { clips: [clip], outputSize: "640x640" } });
  const move = x => document => ({ ...document, clips: document.clips.map(item => ({ ...item, nodeX: x })) });
  history = editHistory(history, { type: "edit", group: "drag", update: move(120) });
  history = editHistory(history, { type: "edit", group: "drag", update: move(240) });
  assert.equal(history.past.length, 1);
  history = editHistory(history, { type: "system", update: document => ({ ...document, clips: document.clips.map(item => ({ ...item, mediaWidth: 64 })) }) });
  history = editHistory(history, { type: "undo" });
  assert.equal(history.present.clips[0].nodeX, clip.nodeX); assert.equal(history.present.clips[0].mediaWidth, 64);
  history = editHistory(history, { type: "redo" });
  assert.equal(history.present.clips[0].nodeX, 240); assert.equal(history.present.clips[0].mediaWidth, 64);
});

test("saved keyframes and draft settings survive restart without accepting missing images", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drawpaint-draft-edit-")); let server;
  try {
    const config = { canvasDir: root, jobIds: new Set(), generatedStore: { resolve: async () => ({ file: null }) } };
    let handler = createVideoEditor(config);
    server = createServer(async (req, res) => { if (!await handler(req, res, new URL(req.url, "http://localhost"))) { res.writeHead(404); res.end(); } });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}/api/video`;
    const call = async (url, method = "GET", body) => { const response = await fetch(base + url, { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) }); return { status: response.status, value: await response.json() }; };
    const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 80, g: 120, b: 200, alpha: .5 } } }).png().toBuffer();
    const reference = await call("/reference-images", "POST", { image: `data:image/png;base64,${png.toString("base64")}` });
    assert.equal(reference.status, 201);
    const canvas = (await call("/canvases", "POST", { name: "草稿" })).value;
    const draft = { ...newDraft(id, []), firstImageId: reference.value.id, prompt: "角色挥手", locked: true, muted: true, nodeWidth: 320, modelId: "minimax-h3", frameAnimation: { enabled: true, background: "#ff00ff" } };
    const saved = await call(`/project?canvasId=${canvas.id}`, "PUT", { clips: [draft], baseRevision: canvas.revision, view: { selectedIds: [id] } });
    assert.equal(saved.status, 200);
    handler = createVideoEditor(config);
    const restored = (await call(`/project?canvasId=${canvas.id}`)).value;
    assert.deepEqual(restored.clips[0], saved.value.clips[0]); assert.deepEqual(restored.view.selectedIds, [id]);
    const imageResponse = await fetch(base + `/reference-images/${reference.value.id}.png`);
    assert.equal(imageResponse.status, 200);
    const pixel = await sharp(Buffer.from(await imageResponse.arrayBuffer())).raw().toBuffer(); assert.ok(pixel[3] > 120 && pixel[3] < 135);
    assert.equal((await call("/reference-images", "POST", { image: "data:image/svg+xml;base64,AA==" })).status, 400);
    assert.equal((await call(`/project?canvasId=${canvas.id}`, "PUT", { clips: [{ ...draft, firstImageId: otherId }], baseRevision: restored.revision })).status, 400);
    assert.equal((await call(`/project?canvasId=${canvas.id}`)).value.revision, restored.revision);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

let ffmpegAvailable = true;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore", windowsHide: true }); } catch { ffmpegAvailable = false; }
test("real exports honor speed, mute, hidden clips and reusable imported media", { skip: !ffmpegAvailable && "FFmpeg unavailable", timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drawpaint-editor-exports-")); let server;
  try {
    const source = path.join(root, "source.mp4");
    execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=64x48:r=24:d=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source], { windowsHide: true });
    const config = { canvasDir: path.join(root, "canvas"), jobIds: new Set(), generatedStore: { resolve: async () => ({ file: null }) } }; let handler = createVideoEditor(config);
    server = createServer(async (req, res) => { if (!await handler(req, res, new URL(req.url, "http://localhost"))) { res.writeHead(404); res.end(); } });
    server.listen(0, "127.0.0.1"); await once(server, "listening"); const base = `http://127.0.0.1:${server.address().port}/api/video`;
    const call = async (url, method = "GET", body) => { const response = await fetch(base + url, { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) }); const value = await response.json(); assert.equal(response.status < 300, true, JSON.stringify(value)); return value; };
    const imported = await call("/import", "POST", { name: "复用镜头", video: `data:video/mp4;base64,${fs.readFileSync(source).toString("base64")}` });
    assert.equal(imported.width, 64); assert.equal(imported.height, 48); assert.equal(imported.fps, 24); assert.ok(imported.duration >= 2);
    handler = createVideoEditor(config); assert.equal((await call("/assets")).assets[0].name, "复用镜头");
    const edited = { ...clip, source: { type: "asset", id: imported.id }, in: 0, out: 2, position: 0, track: 7, muted: true, playbackRate: 2 };
    const hidden = { ...edited, id: otherId, position: 10, hidden: true };
    await call("/project", "PUT", { clips: [edited, hidden, newDraft("dddddddd-dddd-4ddd-8ddd-dddddddddddd", [])] });
    const exportJob = async body => {
      let job = await call("/exports", "POST", body), deadline = Date.now() + 12000;
      while (job.status === "running" && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 100)); job = await call(`/exports/${job.id}`); }
      assert.equal(job.status, "completed", job.error); return job;
    };
    const probe = file => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", file], { windowsHide: true, encoding: "utf8" }));
    const timeline = await exportJob({}); const timelineProbe = probe(path.join(config.canvasDir, "video-exports", `${timeline.id}.mp4`));
    assert.ok(Math.abs(Number(timelineProbe.format.duration) - 1) < .1); assert.ok(timelineProbe.streams.every(stream => stream.codec_type !== "audio"));
    const single = await exportJob({ clipId: id }); assert.ok(Math.abs(Number(probe(path.join(config.canvasDir, "video-exports", `${single.id}.mp4`)).format.duration) - 1) < .1);
    const sequence = await exportJob({ format: "sequence", clipId: id, fps: 8 });
    const files = unzipSync(new Uint8Array(await (await fetch(base.replace(/\/api\/video$/, "") + sequence.url)).arrayBuffer()));
    const manifest = JSON.parse(strFromU8(files["animation.json"]));
    assert.equal(manifest.frameCount, 8); assert.equal(manifest.duration, 1); assert.equal(manifest.source.clips[0].playbackRate, 2);
    const saved = await call("/project"); await call("/project", "PUT", { ...saved, baseRevision: saved.revision, clips: [{ ...edited, muted: false, playbackRate: .5, volume: .25 }] });
    const slow = await exportJob({ clipId: id }); const slowProbe = probe(path.join(config.canvasDir, "video-exports", `${slow.id}.mp4`));
    assert.ok(Math.abs(Number(slowProbe.format.duration) - 4) < .15); assert.ok(slowProbe.streams.some(stream => stream.codec_type === "audio"));
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
