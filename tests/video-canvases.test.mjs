import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { createVideoEditor } from "../server/video-editor.mjs";
import { createVideoCanvases } from "../server/video-canvases.mjs";
import { createProjectSaver } from "../src/video-project-save.js";
import { mergeVideoProjectSnapshots, videoProjectSnapshot } from "../shared/video-project-sync.js";

test("saved video canvases isolate projects, preserve legacy data and survive restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drawpaint-video-canvases-"));
  let server;
  try {
    const sourceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const clip = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", source: { type: "job", id: sourceId }, name: "原片段", in: .25, out: 2, position: 1, track: 2, fps: 24, startFrame: .5, endFrame: 1.5, nodeX: -45, nodeY: 76, prompt: "挥手", frameAnimation: { enabled: true, background: "#ff00ff" }, status: "completed" };
    const original = JSON.stringify({ clips: [clip], width: 960, height: 540, revision: "legacy-revision" });
    const legacyFile = path.join(root, "video-project.json"); fs.writeFileSync(legacyFile, original);
    const config = { canvasDir: root, jobIds: new Set([sourceId]), generatedStore: { resolve: async () => ({ file: null }) } };
    let handler = createVideoEditor(config);
    server = createServer(async (req, res) => { if (!await handler(req, res, new URL(req.url, "http://localhost"))) { res.writeHead(404); res.end(); } });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}/api/video`;
    const call = async (url, method = "GET", body) => {
      const response = await fetch(base + url, { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
      return { status: response.status, value: await response.json() };
    };
    assert.equal((await call("/project")).value.clips[0].name, "原片段");
    assert.deepEqual((await call("/canvases")).value.canvases.map(p => p.name), ["默认画布"]);
    assert.equal(fs.readFileSync(legacyFile, "utf8"), original, "opening and listing must not rewrite the original project");
    const a = (await call("/canvases", "POST", { name: "帧动画" })).value;
    const b = (await call("/canvases", "POST", { name: "正常视频" })).value;
    assert.equal(a.clips.length, 0);
    const projectUrl = `/project?canvasId=${a.id}`;
    const saved = await call(projectUrl, "PUT", { clips: [clip], width: 540, height: 960, baseRevision: a.revision, view: { graphPan: { x: 25, y: -50 }, graphZoom: 75, timelineZoom: 95 } });
    assert.equal(saved.status, 200);
    assert.equal(saved.value.clips[0].startFrame, .5);
    assert.equal(saved.value.clips[0].frameAnimation.enabled, true);
    assert.equal(saved.value.view.timelineZoom, 95);
    assert.equal((await call(`/project?canvasId=${b.id}`)).value.clips.length, 0);
    assert.equal(fs.readFileSync(legacyFile, "utf8"), original);
    const stale = await call(projectUrl, "PUT", { clips: [], baseRevision: a.revision });
    assert.equal(stale.status, 409, "a stale tab must not overwrite this canvas");
    const renamed = await call(`/canvases/${a.id}`, "PATCH", { name: "鸭骑士动画" });
    assert.equal(renamed.value.revision, saved.value.revision, "a rename must not invalidate the content revision");
    const resaved = await call(projectUrl, "PUT", { ...saved.value, baseRevision: saved.value.revision });
    assert.equal(resaved.status, 200);
    assert.equal(resaved.value.name, "鸭骑士动画", "a content save must retain the latest name");
    handler = createVideoEditor(config);
    assert.equal((await call(projectUrl)).value.name, "鸭骑士动画");
    assert.equal((await call("/canvases")).value.canvases.length, 3);
    const missingId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    assert.equal((await call(`/project?canvasId=${missingId}`)).status, 404);
    assert.equal((await call("/project?canvasId=..%2Fvideo-project")).status, 400);
    assert.equal((await call(`/project?canvasId=${missingId}`, "PUT", { clips: [] })).status, 404);
    assert.equal((await call("/exports", "POST", { canvasId: missingId })).status, 404);
    assert.match((await call("/exports", "POST", { canvasId: b.id })).value.error, /没有已完成/);
    assert.equal((await call("/canvases", "POST", { name: "  " })).status, 400);
    const corruptFile = path.join(root, "video-canvases", `${b.id}.json`);
    fs.writeFileSync(corruptFile, "broken JSON");
    assert.equal((await call(`/project?canvasId=${b.id}`, "PUT", { clips: [] })).status, 500);
    assert.equal(fs.readFileSync(corruptFile, "utf8"), "broken JSON", "corrupt data must not be replaced with an empty project");
    assert.equal(fs.readFileSync(legacyFile, "utf8"), original);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("renaming the absent default canvas keeps a usable empty project", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drawpaint-empty-video-"));
  try {
    const store = createVideoCanvases(root);
    assert.equal(store.rename("default", "第一个镜头").clips.length, 0);
    assert.equal(createVideoCanvases(root).read().name, "第一个镜头");
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("remote generated clips merge with a local node move and recover a stale-tab save", async () => {
  const base = videoProjectSnapshot({ clips: [{ id: "attack", name: "锤击", nodeX: 0, source: { type: "job", id: "original" } }] });
  let snapshot = JSON.stringify(base), latest = { ...base, clips: [...base.clips, { id: "idle", name: "待机", source: { type: "job", id: "new" } }] }, received;
  const saver = createProjectSaver({ getSnapshot: () => snapshot, onStatus() {}, onSaved() {}, send: async (project, revision) => {
    if (revision === "r0") throw Object.assign(new Error("stale"), { status: 409 });
    received = project; return { ...project, revision: "r2" };
  } });
  saver.seed(snapshot, "r0");
  snapshot = JSON.stringify({ ...base, clips: [{ ...base.clips[0], nodeX: 80 }] });
  await assert.rejects(saver.flush(), /stale/);
  assert.equal(await saver.receive(JSON.stringify(latest), "r1", "r0", merged => { snapshot = JSON.stringify(merged); }), true);
  await saver.flush();
  assert.deepEqual(received.clips.map(clip => clip.id), ["attack", "idle"]);
  assert.equal(received.clips[0].nodeX, 80);
  assert.equal(saver.dirty(), false);
});

test("remote camera updates retain the local view without triggering another save", async () => {
  const base = videoProjectSnapshot({ clips: [{ id: "a" }] });
  let snapshot = JSON.stringify(base), calls = 0;
  const saver = createProjectSaver({ getSnapshot: () => snapshot, onStatus() {}, onSaved() {}, send: async () => { calls++; return { revision: "r2" }; } });
  saver.seed(snapshot, "r0");
  const remote = { ...base, view: { ...base.view, graphZoom: 30 } };
  assert.equal(await saver.receive(JSON.stringify(remote), "r1", "r0", merged => { snapshot = JSON.stringify(merged); }), true);
  assert.equal(JSON.parse(snapshot).view.graphZoom, 100);
  await saver.flush(); assert.equal(calls, 0);
});

test("a remote read made before an in-flight save cannot revert that save", async () => {
  const base = videoProjectSnapshot({ clips: [{ id: "a", name: "old" }] });
  let snapshot = JSON.stringify(base), finish;
  const saver = createProjectSaver({ getSnapshot: () => snapshot, onStatus() {}, onSaved() {}, send: async () => {
    await new Promise(resolve => { finish = resolve; }); return { revision: "r2" };
  } });
  saver.seed(snapshot, "r0"); snapshot = JSON.stringify({ ...base, clips: [{ id: "a", name: "new" }] });
  const saving = saver.flush(); await Promise.resolve(); await Promise.resolve();
  const syncing = saver.receive(JSON.stringify(base), "r1", "r0", () => assert.fail("stale read applied"));
  finish(); await saving; assert.equal(await syncing, false);
  assert.equal(saver.revision(), "r2"); assert.equal(JSON.parse(snapshot).clips[0].name, "new");
});

test("competing source changes and changed deletions keep local work instead of overwriting", () => {
  const base = videoProjectSnapshot({ clips: [{ id: "a", source: { type: "job", id: "original" } }] });
  const local = { ...base, clips: [{ id: "a", source: { type: "job", id: "local" } }] };
  const remote = { ...base, clips: [{ id: "a", source: { type: "job", id: "remote" } }] };
  assert.equal(mergeVideoProjectSnapshots(base, local, remote), null);
  assert.equal(mergeVideoProjectSnapshots(base, { ...base, clips: [] }, remote), null);
  assert.equal(mergeVideoProjectSnapshots(base, local, { ...base, clips: [] }), null);
  assert.deepEqual(mergeVideoProjectSnapshots(base, { ...base, clips: [] }, base).clips, []);
});

test("cancelled canvas synchronization cannot advance its revision or clear local edits", async () => {
  const base = videoProjectSnapshot({ clips: [] }); let snapshot = JSON.stringify(base);
  const saver = createProjectSaver({ getSnapshot: () => snapshot, onStatus() {}, onSaved() {}, send() {} });
  saver.seed(snapshot, "r0");
  const remote = JSON.stringify({ ...base, clips: [{ id: "new" }] });
  assert.equal(await saver.receive(remote, "r1", "r0", () => false), false);
  assert.equal(saver.revision(), "r0"); assert.equal(snapshot, JSON.stringify(base));
});

test("switch flush drains edits made during an in-flight save and serializes revisions", async () => {
  let snapshot = JSON.stringify({ clips: [] }), finishFirst;
  const requests = [], statuses = [];
  const saver = createProjectSaver({ getSnapshot: () => snapshot, onStatus: value => statuses.push(value), onSaved: () => {}, send: async (project, revision) => {
    requests.push({ project, revision });
    if (requests.length === 1) await new Promise(resolve => { finishFirst = resolve; });
    return { revision: `r${requests.length}` };
  } });
  saver.seed(snapshot, "r0");
  snapshot = JSON.stringify({ clips: ["first"] });
  const autosave = saver.flush();
  await Promise.resolve(); await Promise.resolve();
  snapshot = JSON.stringify({ clips: ["first", "last edit before switch"] });
  const switchFlush = saver.flush();
  finishFirst(); await Promise.all([autosave, switchFlush]);
  assert.deepEqual(requests.map(item => item.revision), ["r0", "r1"]);
  assert.equal(requests[1].project.clips.length, 2);
  assert.equal(saver.dirty(), false);
  assert.equal(statuses.at(-1), "saved");
});

test("a conflicting save blocks further writes until the canvas is reloaded", async () => {
  let snapshot = "{}", calls = 0;
  const saver = createProjectSaver({ getSnapshot: () => snapshot, onStatus: () => {}, onSaved: () => {}, send: async () => { calls++; throw Object.assign(new Error("conflict"), { status: 409 }); } });
  saver.seed(snapshot, "r0"); snapshot = '{"changed":true}';
  await assert.rejects(saver.flush(), /conflict/);
  await assert.rejects(saver.flush(), /conflict/);
  assert.equal(calls, 1);
  assert.equal(saver.dirty(), true);
});
