import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { createVideoLibrary } from "../server/video-library.mjs";
import { createVideoEditor } from "../server/video-editor.mjs";

const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", c = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drawpaint-video-library-"));
  fs.mkdirSync(path.join(root, "video-assets")); fs.mkdirSync(path.join(root, "video-generated"));
  fs.writeFileSync(path.join(root, "video-assets", `${c}.mp4`), "original-import");
  fs.writeFileSync(path.join(root, "video-generated", `${a}.mp4`), "original-generated");
  fs.writeFileSync(path.join(root, "video-project.json"), JSON.stringify({ clips: [{ source: { type: "job", id: a } }] }));
  const jobs = [{ source: { type: "job", id: a }, frameAnimation: { enabled: false } }, { source: { type: "job", id: b }, frameAnimation: { enabled: true } }];
  const open = () => createVideoLibrary({ canvasDir: root, getJobs: () => jobs });
  return { root, jobs, open, library: open(), close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("migration groups legacy videos and preserves sources and canvas files", () => {
  const f = fixture();
  try {
    const before = fs.readFileSync(path.join(f.root, "video-project.json"), "utf8"), state = f.library.read();
    assert.equal(state.items[`job:${a}`].folderId, "normal"); assert.equal(state.items[`job:${b}`].folderId, "animation"); assert.equal(state.items[`asset:${c}`].folderId, "imported");
    assert.equal(f.library.read().revision, state.revision, "reading an unchanged catalog must not rewrite it");
    assert.equal(fs.readFileSync(path.join(f.root, "video-generated", `${a}.mp4`), "utf8"), "original-generated");
    assert.equal(fs.readFileSync(path.join(f.root, "video-assets", `${c}.mp4`), "utf8"), "original-import");
    assert.equal(fs.readFileSync(path.join(f.root, "video-project.json"), "utf8"), before);
  } finally { f.close(); }
});
test("nested folders, batch moves and display names survive restart and independent clients", () => {
  const f = fixture();
  try {
    const first = f.library.change({ action: "create-folder", parentId: null, name: "角色" }).affectedFolderId;
    const child = f.library.change({ action: "create-folder", parentId: first, name: "待机" }).affectedFolderId;
    f.library.change({ action: "move-assets", keys: [`job:${a}`, `asset:${c}`], folderId: child });
    f.open().change({ action: "rename-folder", id: first, name: "鸭嘴骑士" });
    f.library.change({ action: "rename-asset", key: `asset:${c}`, name: "待机循环" });
    const state = f.open().read();
    assert.equal(state.folders.find(folder => folder.id === first).name, "鸭嘴骑士");
    assert.equal(state.folders.find(folder => folder.id === child).parentId, first);
    assert.equal(state.items[`job:${a}`].folderId, child); assert.deepEqual(state.items[`asset:${c}`], { folderId: child, name: "待机循环" });
  } finally { f.close(); }
});
test("invalid names, duplicate siblings, folder cycles and unknown sources do not overwrite the index", () => {
  const f = fixture();
  try {
    const parent = f.library.change({ action: "create-folder", parentId: null, name: "角色" }).affectedFolderId;
    const child = f.library.change({ action: "create-folder", parentId: parent, name: "待机" }).affectedFolderId;
    const before = fs.readFileSync(f.library.indexFile, "utf8");
    for (const action of [
      { action: "create-folder", parentId: null, name: "角色" }, { action: "create-folder", parentId: null, name: "../outside" },
      { action: "move-folder", id: parent, parentId: child }, { action: "move-folder", id: child, parentId: child },
      { action: "rename-folder", id: child, name: "CON" }, { action: "move-assets", keys: [`job:${a}`, `asset:${b}`], folderId: child },
      { action: "move-assets", keys: [`job:${a}`], folderId: "missing" }, { action: "rename-asset", key: "../../file", name: "video" },
    ]) { assert.throws(() => f.library.change(action)); assert.equal(fs.readFileSync(f.library.indexFile, "utf8"), before); }
  } finally { f.close(); }
});
test("only empty folders can be removed and automatic registration respects moved folders", () => {
  const f = fixture();
  try {
    const folder = f.library.change({ action: "create-folder", parentId: null, name: "动作" }).affectedFolderId;
    f.library.change({ action: "move-assets", keys: [`job:${a}`], folderId: folder });
    assert.throws(() => f.library.change({ action: "delete-folder", id: folder }), /还有素材/);
    f.library.register({ type: "job", id: a }); assert.equal(f.library.read().items[`job:${a}`].folderId, folder);
    f.library.change({ action: "move-assets", keys: [`job:${a}`], folderId: null });
    f.library.change({ action: "delete-folder", id: folder });
    f.jobs.push({ source: { type: "job", id: c }, frameAnimation: { enabled: true } });
    assert.equal(f.library.read().items[`job:${c}`].folderId, "animation");
    f.library.register({ type: "job", id: c }, folder);
    assert.equal(f.library.read().items[`job:${c}`].folderId, null, "a folder removed during generation falls back to the library root");
  } finally { f.close(); }
});
test("corrupt catalogs are reported without replacing their contents", () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.library.indexFile, "broken JSON");
    assert.throws(() => f.library.read(), error => error.status === 500);
    assert.throws(() => f.library.change({ action: "create-folder", parentId: null, name: "folder" }));
    assert.equal(fs.readFileSync(f.library.indexFile, "utf8"), "broken JSON");
  } finally { f.close(); }
});
test("folder depth is bounded and root and ancestor moves remain safe", () => {
  const f = fixture();
  try {
    let id = null;
    for (let i = 0; i < 12; i++) id = f.library.change({ action: "create-folder", parentId: id, name: `level-${i}` }).affectedFolderId;
    assert.throws(() => f.library.change({ action: "create-folder", parentId: id, name: "too-deep" }), /12/);
    const result = f.library.change({ action: "move-folder", id, parentId: null });
    assert.equal(result.folders.find(folder => folder.id === id).parentId, null);
  } finally { f.close(); }
});
test("library HTTP endpoints persist commands and leave video URLs usable", async () => {
  const f = fixture(); let server;
  try {
    const handler = createVideoEditor({ canvasDir: f.root, jobIds: new Set([a, b]), jobOptions: { [b]: { frameAnimation: { enabled: true } } }, generatedStore: { resolve: async () => ({ file: path.join(f.root, "video-generated", `${a}.mp4`) }) } });
    server = createServer(async (req, res) => { if (!await handler(req, res, new URL(req.url, "http://localhost"))) { res.writeHead(404); res.end(); } });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}/api/video`;
    const create = await fetch(`${base}/library`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create-folder", parentId: null, name: "项目 A" }) });
    assert.equal(create.status, 200); const folder = (await create.json()).affectedFolderId;
    const moved = await fetch(`${base}/library`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "move-assets", keys: [`asset:${c}`], folderId: folder }) });
    assert.equal(moved.status, 200);
    assert.equal((await (await fetch(`${base}/library`)).json()).items[`asset:${c}`].folderId, folder);
    assert.equal(await (await fetch(`${base}/assets/${c}.mp4`)).text(), "original-import");
    assert.equal((await (await fetch(`${base}/assets`)).json()).assets[0].id, c);
    const invalid = await fetch(`${base}/library`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete-folder", id: folder }) });
    assert.equal(invalid.status, 409);
  } finally { if (server) await new Promise(resolve => server.close(resolve)); f.close(); }
});
