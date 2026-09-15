import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import sharp from "sharp";
import { unzipSync } from "fflate";
import { normalizeOptions, removeBackground, findComponents, makeSlices, validateSlices, cropSlice } from "../server/ui-studio/segmentation.mjs";
import { UiStudioService } from "../server/ui-studio/service.mjs";
import { createUiStudioHandler } from "../server/ui-studio/http.mjs";
import { buildAtlasPrompt } from "../server/ui-studio/provider.mjs";
import { jobImageLayout, redundantAtlasIds, besideSourceLayout } from "../src/ui-studio/canvas-layout.js";
import { validateLayers, prepareLayerImage, writeLayers } from "../server/ui-studio/layers.mjs";
import { readSnapshot, saveSnapshot } from "../server/ui-studio/snapshot.mjs";
import { replaceFile } from "../server/ui-studio/atomic.mjs";
import { buildLayerTree, flattenLayerTree, layerTreeForShapes, nodeKey, copyLayerBranch } from "../src/ui-studio/layer-tree.js";
import { sliceForShape } from "../src/ui-studio/layer-tree.js";
import { buildPreset } from "../server/ui-studio/preset.mjs";
import { readPsd, initializeCanvas } from "ag-psd";
import { Store, StoreSchema, createRecordType } from "@tldraw/store";
import { HistoryManager } from "../node_modules/@tldraw/editor/dist-esm/lib/editor/managers/HistoryManager/HistoryManager.mjs";
import { updateLayerDocument } from "../src/ui-studio/document-edits.js";
import { writeComponentImage } from "../server/ui-studio/component-images.mjs";
import { isolatePanelKey, blurCanvasForPanel } from "../src/ui-studio/panel-events.js";

test("panel shortcuts cannot bubble into tldraw; canvas keys remain available", () => {
  let stopped=0,blurred=0;
  const editor={blur(){blurred++;}};
  for(const selector of [null,".tl-container"]){
    const event={target:{closest:()=>selector},stopPropagation(){stopped++;}};
    isolatePanelKey(event);blurCanvasForPanel(event,editor);
  }
  assert.equal(stopped,1);assert.equal(blurred,1);
});

fs.mkdirSync("tmp", { recursive: true });
test("layer tree follows page images while retaining ancestry, hidden layers and copy identity", () => {
  const jobs = [
    { id: "a", revision: "r", slices: [{ id: "one", name: "One", x: 1, y: 2, w: 3, h: 4 }, { id: "two", name: "Two" }] },
    { id: "b", revision: "r", operation: "decompose", parent: { jobId: "a", revision: "r", sliceId: "one", name: "One" }, slices: [{ id: "child", name: "Child" }] },
    { id: "absent", revision: "r", slices: [{ id: "absent" }] },
  ];
  const roots = buildLayerTree(jobs, {}, { copies: { "copy:one": { sourceKey: "a/r/one", parent: null, name: "Copy" } } });
  const before = JSON.stringify(roots);
  const image = (job, slice, extra = {}) => ({ type: "image", meta: { uiJobId: job, uiRevision: "r", uiSliceId: slice, ...extra } });
  const keys = shapes => flattenLayerTree(layerTreeForShapes(roots, shapes)).map(({ node }) => nodeKey(node));
  const firstPage = [image("b", "child"), { ...image("a", "two"), opacity: 0 }];
  assert.deepEqual(keys(firstPage), ["a/r/root", "a/r/one", "b/r/root", "b/r/child", "a/r/two"]);
  assert.deepEqual(keys([image("a", "one", { uiNodeKey: "copy:one" })]), ["copy:one"]);
  assert.deepEqual(keys([]), []);
  assert.deepEqual(keys([image("a", "one", { uiRevision: "old" })]), []);
  assert.deepEqual(keys([{ ...image("a", "one"), type: "group" }]), []);
  assert.deepEqual(keys([image("a", undefined, { uiRole: "slice", sourceRect: { x: 1, y: 2, w: 3, h: 4 }, uiName: "Old name" })]), ["a/r/root", "a/r/one"]);
  assert.deepEqual(keys([image("a", undefined, { uiRole: "slice", uiName: "Two" })]), ["a/r/root", "a/r/two"]);
  assert.deepEqual(keys(firstPage.slice(1)), ["a/r/root", "a/r/two"]);
  assert.deepEqual(keys(firstPage), ["a/r/root", "a/r/one", "b/r/root", "b/r/child", "a/r/two"]);
  assert.equal(JSON.stringify(roots), before, "Filtering must not change the document hierarchy");
});

test("component storage deduplicates concurrent pixel matches but preserves color, alpha and dimensions", async () => {
  const root = temporary(), cache = path.join(root, "cache");
  const outputs = [path.join(root, "a"), path.join(root, "b")];
  outputs.forEach(out => fs.mkdirSync(out));
  const data = pixels(4, 4, [30, 60, 90, 255]); data[3] = 0;
  const other = Buffer.from(data); other[0] = 200; // Invisible RGB is irrelevant.
  const images = [await png(data, 4, 4), await png(other, 4, 4)];
  const matches = await Promise.all(outputs.map((out, i) => writeComponentImage(out, cache, images[i])));
  assert.equal(matches[0].contentHash, matches[1].contentHash);
  assert.equal(matches.filter(m => m.reused).length, 1);
  assert.equal(fs.readdirSync(cache).length, 1);
  assert.deepEqual(fs.readFileSync(path.join(outputs[0], matches[0].file)), fs.readFileSync(path.join(outputs[1], matches[1].file)));
  assert.ok(fs.statSync(path.join(cache, matches[0].file)).nlink >= 3);
  for (const channel of [4, 7]) {
    const changed = Buffer.from(data); changed[channel]--;
    const result = await writeComponentImage(outputs[0], cache, await png(changed, 4, 4));
    assert.notEqual(result.contentHash, matches[0].contentHash);
  }
  const reshaped = await writeComponentImage(outputs[0], cache, await png(data, 8, 2));
  assert.notEqual(reshaped.contentHash, matches[0].contentHash);
});

test("AI decomposition reuses legacy components without uploads and keeps placement, exports and provenance", async () => {
  const service = new UiStudioService(temporary());
  const original = await service.create({ kind: "extract", dataUrl: `data:image/png;base64,${(await fixture()).toString("base64")}`, options });
  const parent = await waitReady(service, original.id);
  // Old tasks without hashes remain valid candidates.
  parent.slices = parent.slices.map(({ contentHash, ...slice }) => slice);
  service.save(parent);
  const child = await service.refine(parent.id, { revision: parent.revision, dispatch: false });
  const request = service.claimAgent(child.id);
  const candidate = request.reusableComponents.find(c => c.jobId === parent.id);
  assert.ok(candidate && fs.existsSync(candidate.imagePath));
  assert.match(request.generationPrompt, /Before generating any images/);
  const reuse = { jobId: candidate.jobId, revision: candidate.revision, sliceId: candidate.sliceId };
  const layer = { name: "复用图标", layerType: "icon", x: 0, y: 0, w: candidate.w, h: candidate.h, zIndex: 0, reuse };
  const sourceBytes = fs.readFileSync(candidate.imagePath);
  service.upload = () => { throw new Error("Reused layers must not upload or generate images"); };
  const result = await service.completeLayers(child.id, { layers: [layer, { ...layer, x: 1, zIndex: 1 }] });
  assert.equal(result.reusedLayers, 2);
  assert.equal(result.slices[0].file, result.slices[1].file);
  assert.deepEqual(result.slices[0].reuse, reuse);
  assert.equal(result.slices[1].x, 1);
  const zip = unzipSync(fs.readFileSync(service.asset(child.id, result.exportFile)));
  assert.equal(Object.keys(zip).filter(key => key.startsWith("layers/")).length, 1);
  const manifest = JSON.parse(Buffer.from(zip["manifest.json"]).toString());
  assert.equal(manifest.layers.length, 2);
  assert.equal(manifest.layers[0].file, manifest.layers[1].file);
  assert.deepEqual(await sharp(service.asset(child.id, result.slices[0].file)).raw().toBuffer(), await sharp(sourceBytes).raw().toBuffer());
  const exported = await service.exportPreset(child.id, { revision: result.revision, format: "unity", variant: "source" });
  const unityZip = unzipSync(fs.readFileSync(service.asset(child.id, exported.file)));
  assert.equal(Object.keys(unityZip).filter(key => key.includes("/Sprites/")).length, 1);
  const preset = JSON.parse(Buffer.from(Object.entries(unityZip).find(([key]) => key.endsWith("/preset.json"))[1]).toString());
  assert.equal(preset.root.children.length, 2);
  assert.equal(preset.root.children[0].sprite, preset.root.children[1].sprite);
  assert.deepEqual(new UiStudioService(path.dirname(service.root)).get(child.id).slices[0].reuse, reuse);
  await assert.rejects(service.reuseLayerImage(child, { ...layer, reuse: { ...reuse, revision: "old" } }), /版本已变化/);
  await assert.rejects(service.reuseLayerImage(child, { ...layer, reuse: { ...reuse, sliceId: "slice-999" } }), /不存在/);
  await assert.rejects(service.reuseLayerImage(child, { ...layer, w: layer.w * 2 }), /宽高比/);
  const selected = await service.refine(parent.id, { revision: parent.revision, sliceId: candidate.sliceId, dispatch: false });
  assert.ok(!service.agentRequest(selected.id).reusableComponents.some(c => c.jobId === parent.id && c.sliceId === candidate.sliceId));
  await assert.rejects(service.reuseLayerImage(selected, layer), /父组件整图/);
  const current = service.get(parent.id);
  Object.assign(current.slices.find(s => s.id === candidate.sliceId), { layerType: "text", text: "开始" }); service.save(current);
  await assert.rejects(service.reuseLayerImage(child, { ...layer, layerType: "text", text: "结束" }), /文字不同/);
  assert.throws(() => validateLayers([layer, { ...layer, dataUrl: "bad" }], parent.width, parent.height), /不能同时/);
  service.cancel(selected.id);
});

test("repeated atlas extraction shares existing pixels across jobs and revisions", async () => {
  const service = new UiStudioService(temporary());
  const input = { kind: "extract", dataUrl: `data:image/png;base64,${(await fixture()).toString("base64")}`, options };
  const first = await waitReady(service, (await service.create(input)).id);
  const second = await waitReady(service, (await service.create(input)).id);
  assert.equal(second.slices.length, first.slices.length);
  assert.equal(second.reusedImages, second.slices.length);
  assert.deepEqual(second.slices.map(s => s.contentHash), first.slices.map(s => s.contentHash));
  service.reprocess(first.id, { options });
  const revised = await waitReady(service, first.id);
  assert.notEqual(revised.revision, first.revision);
  assert.equal(revised.reusedImages, revised.slices.length);
  for (const slice of first.slices) assert.ok(fs.existsSync(service.asset(first.id, slice.file)));
});
test("layer document edits and image deletion undo and redo as one history action", () => {
  const record = createRecordType('test', { scope: 'document' });
  const store = new Store({ schema: StoreSchema.create({ test: record }), props: null });
  const documentId = record.createId('document'), shapeId = record.createId('image');
  store.put([record.create({ id: documentId, meta: { uiLayerEdits: { copies: { c: { name: 'Copy' } } } } }), record.create({ id: shapeId, meta: {} })]);
  const history = new HistoryManager({ store });
  const editor = { store, getDocumentSettings: () => store.get(documentId) };
  history._mark('delete');
  history.batch(() => {
    store.remove([shapeId]);
    updateLayerDocument(editor, { ...editor.getDocumentSettings().meta, uiLayerEdits: { copies: { c: { name: 'Copy' } }, deleted: ['c'] } });
  });
  assert.equal(store.has(shapeId), false);
  history.undo();
  assert.equal(store.has(shapeId), true);
  assert.equal(editor.getDocumentSettings().meta.uiLayerEdits.deleted, undefined);
  history.redo();
  assert.equal(store.has(shapeId), false);
  assert.deepEqual(editor.getDocumentSettings().meta.uiLayerEdits.deleted, ['c']);
  history.dispose(); store.dispose();
});
test("copied layer branches preserve hierarchy, isolate metadata, survive source deletion and serialize", () => {
  const jobs = [{ id: "a", revision: "r", prompt: "Preset", slices: [{ id: "one", name: "Button", layerType: "button" }] },
    { id: "b", revision: "r", operation: "decompose", parent: { jobId: "a", revision: "r", sliceId: "one", name: "Button" }, slices: [{ id: "text", name: "Label", text: "Play", layerType: "text" }] }];
  const original = JSON.stringify(jobs), roots = buildLayerTree(jobs);
  let id = 0;
  const plan = copyLayerBranch(roots, "a/r/one", {}, () => `copy:${++id}`);
  plan.edits.copies['copy:3'].slice.text = "Start";
  const edits = JSON.parse(JSON.stringify(plan.edits));
  let tree = buildLayerTree(jobs, {}, edits), nodes = flattenLayerTree(tree).map(r => r.node);
  const copy = nodes.find(n => nodeKey(n) === plan.key);
  assert.equal(copy.name, 'Button 副本');
  assert.equal(copy.children[0].children[0].slice.text, 'Start');
  assert.equal(nodes.find(n => nodeKey(n) === 'b/r/text').slice.text, 'Play');
  assert.equal(JSON.stringify(jobs), original);
  edits.deleted = ['a/r/one'];
  nodes = flattenLayerTree(buildLayerTree(jobs, {}, edits)).map(r => r.node);
  assert.equal(nodes.some(n => nodeKey(n) === 'b/r/text'), false);
  assert.equal(nodes.some(n => nodeKey(n) === 'copy:3'), true);
  edits.deleted = ['copy:1'];
  nodes = flattenLayerTree(buildLayerTree(jobs, {}, edits)).map(r => r.node);
  assert.equal(nodes.some(n => n.instanceKey), false);
  assert.equal(nodes.some(n => nodeKey(n) === 'b/r/text'), true);
  const again = copyLayerBranch(tree, plan.key, plan.edits, () => `copy:${++id}`);
  assert.equal(again.edits.copies[again.key].sourceKey, 'a/r/one');
  assert.equal(flattenLayerTree(buildLayerTree(jobs, {}, again.edits)).length, 10);
});
test("semantic layer validation rejects fake single-layer results, invalid geometry/types and unbounded output", () => {
  const layer = { name: "底图", layerType: "background", x: 0, y: 0, w: 10, h: 10, zIndex: 0 };
  assert.throws(() => validateLayers([layer], 10, 10), /2–64/);
  for (const invalid of [{ x: -1 }, { w: 11 }, { layerType: "unknown" }, { zIndex: NaN }]) {
    assert.throws(() => validateLayers([layer, { ...layer, ...invalid }], 10, 10));
  }
  assert.throws(() => validateLayers(Array(64).fill({ ...layer, w: 1024, h: 1024 }), 1024, 1024), /1600/);
});

test("refine -> independent RGBA layers -> nested refinement persists and exports geometry and semantics", async () => {
  let calls = 0;
  const root = temporary();
  const service = new UiStudioService(root, { agentConnection: { status: async () => ({ connected: true }), dispatch: async () => { calls++; } } });
  const original = await service.create({ kind: "extract", dataUrl: `data:image/png;base64,${(await fixture()).toString("base64")}`, options });
  const parent = await waitReady(service, original.id), slice = parent.slices[0];
  const request = { revision: parent.revision, sliceId: slice.id, prompt: "拆出底图和文字" };
  const attempts = await Promise.allSettled([service.refine(parent.id, request), service.refine(parent.id, request)]);
  assert.equal(attempts.filter(a => a.status === "fulfilled").length, 1);
  const child = attempts.find(a => a.status === "fulfilled").value;
  assert.equal(calls, 1); assert.equal(child.width, slice.w); assert.equal(child.parent.revision, parent.revision);
  assert.deepEqual(fs.readFileSync(service.agentRequest(child.id).referencePaths[0]), fs.readFileSync(service.asset(parent.id, slice.file)));
  const claimed = service.claimAgent(child.id);
  assert.match(claimed.generationPrompt, /PSD layer stack/);
  assert.match(claimed.instructions, /complete-layers/);
  await assert.rejects(() => service.completeAgent(child.id, Buffer.alloc(0)), /complete-layers/);
  const base = pixels(slice.w, slice.h, [10, 20, 30, 255]);
  const textImage = pixels(4, 4, [0, 0, 0, 0]); box(textImage, 4, 1, 0, 2, 4, [250, 240, 230, 255]); box(textImage, 4, 0, 1, 4, 2, [250, 240, 230, 255]);
  const layers = [
    { name: "底图", layerType: "background", allowOpaque: true, x: 0, y: 0, w: slice.w, h: slice.h, zIndex: 0, dataUrl: `data:image/png;base64,${(await png(base, slice.w, slice.h)).toString("base64")}` },
    { name: "文字", layerType: "text", text: "开始", x: 3, y: 4, w: 4, h: 4, zIndex: 1, dataUrl: `data:image/png;base64,${(await png(textImage, 4, 4)).toString("base64")}` },
  ];
  const result = await service.completeLayers(child.id, { layers });
  assert.equal(result.status, "ready"); assert.equal(result.slices[1].text, "开始");
  const alpha = await sharp(service.asset(child.id, result.slices[1].file)).ensureAlpha().raw().toBuffer();
  assert.equal(alpha[3], 0); assert.equal(alpha[(1 * 4 + 1) * 4 + 3], 255);
  const composite = await sharp(service.asset(child.id, result.atlasFile)).ensureAlpha().raw().toBuffer();
  assert.deepEqual([...composite.subarray((5 * slice.w + 4) * 4, (5 * slice.w + 4) * 4 + 4)], [250, 240, 230, 255]);
  const zip = unzipSync(fs.readFileSync(service.asset(child.id, result.exportFile)));
  const manifest = JSON.parse(Buffer.from(zip["manifest.json"]).toString());
  assert.equal(manifest.parent.sliceId, slice.id); assert.equal(manifest.layers[1].layerType, "text"); assert.equal(manifest.layers[1].x, 3);
  await assert.rejects(() => service.completeLayers(child.id, { layers }), /不等待/);
  assert.throws(() => service.reprocess(child.id, {}), /不能重新/);
  const next = await service.refine(child.id, { revision: result.revision, sliceId: result.slices[1].id, dispatch: false });
  assert.equal(next.depth, 2); assert.equal(next.width, 4);
  const tree = buildLayerTree(service.list());
  assert.equal(tree.length, 1);
  const parentNode = tree[0].children.find(n => n.sliceId === slice.id);
  assert.equal(parentNode.children[0].jobId, child.id);
  assert.ok(flattenLayerTree(tree).some(r => r.node.jobId === next.id && r.depth === 4));
  assert.equal(flattenLayerTree(tree, new Set([nodeKey(parentNode)])).filter(r => r.node.jobId === child.id).length, 0);
  const restarted = new UiStudioService(root);
  assert.deepEqual(restarted.get(child.id).parent, result.parent);
  service.cancel(next.id);
  await assert.rejects(() => service.completeLayers(next.id, { layers }), /不等待/);
  await assert.rejects(() => service.refine(parent.id, { ...request, revision: "old" }), /版本已变化/);
  await assert.rejects(() => service.refine(parent.id, { ...request, sliceId: "missing" }), /不存在/);
  service.reprocess(parent.id, { slices: [{ name: "merged", x: 0, y: 0, w: 128, h: 96 }] });
  await waitReady(service, parent.id);
  const historical = buildLayerTree(service.list()).find(n => n.jobId === child.id);
  assert.equal(historical.historical, true, "old children never attach to a reused slice ID");
});

test("malformed and cancelled layer completion cannot overwrite ready/cancelled jobs", async () => {
  const service = new UiStudioService(temporary());
  const original = await service.create({ kind: "extract", dataUrl: `data:image/png;base64,${(await fixture()).toString("base64")}`, options });
  const parent = await waitReady(service, original.id);
  const child = await service.refine(parent.id, { revision: parent.revision, dispatch: false });
  const layer = { name: "层", layerType: "icon", x: 0, y: 0, w: 4, h: 4, zIndex: 1, dataUrl: "bad" };
  await assert.rejects(() => service.completeLayers(child.id, { layers: [layer, layer] }), /请选择/);
  assert.equal(service.get(child.id).status, "failed");
  assert.equal(service.running.size, 0);
  const retry = await service.refine(parent.id, { revision: parent.revision, dispatch: false });
  let release;
  service.upload = () => new Promise(resolve => { release = resolve; });
  const pending = service.completeLayers(retry.id, { layers: [layer, layer] });
  service.cancel(retry.id); release(await fixture());
  await assert.rejects(() => pending, /取消/);
  assert.equal(service.get(retry.id).status, "cancelled");
});
test("canvas displays processed results once and only removes paired source previews", () => {
  const job = { sourceFile: "source.png", width: 100, height: 100, slices: [{ name: "atlas", file: "result.png", x: 0, y: 0, w: 100, h: 100 }] };
  const layout = jobImageLayout(job, { x: 200, y: 10 });
  assert.equal(layout.length, 1); assert.equal(layout[0].file, "result.png");
  assert.equal(layout[0].x, 200); assert.equal(layout[0].y, 10); assert.equal(layout[0].sourceX, 0);
  const shape = (id, page, role, revision = "r1") => ({ id, parentId: page, meta: { uiJobId: "job", uiRole: role, uiRevision: revision } });
  const shapes = [shape("source", "page1", "atlas"), shape("result", "page1", "slice"),
    shape("unpaired", "page2", "atlas"), shape("older", "page1", "atlas", "r0"), { id: "user-image", meta: {} }];
  assert.deepEqual(redundantAtlasIds(shapes), ["source"]);
});

test('split placement follows current source page bounds and scales all layers uniformly',()=>{
  const job={width:200,height:100,slices:[{x:20,y:10,w:80,h:40}]};
  const origin=besideSourceLayout(job,{x:5000,y:-700,w:400,h:200});
  assert.deepEqual(origin,{x:5460,y:-700,scale:2});
  const [image]=jobImageLayout(job,origin);
  assert.deepEqual([image.x,image.y,image.w,image.h],[5500,-680,160,80]);
  assert.deepEqual([image.sourceX,image.sourceY,image.sourceW,image.sourceH],[20,10,80,40]);
  assert.equal(besideSourceLayout(job,{x:10,y:20,w:100,h:100}).scale,.5,'rotated/nonmatching bounds do not stretch layers');
});
const temporary = () => fs.mkdtempSync(path.resolve("tmp/ui-studio-test-"));
const options = normalizeOptions({ background: "#ff00ff", removalMode: "color", minArea: 1, padding: 0 });
function pixels(width, height, background = [255, 0, 255, 255]) {
  const result = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) result.set(background, p * 4);
  return result;
}
function box(data, width, x, y, w, h, color) {
  for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) data.set(color, (py * width + px) * 4);
}
const png = async (data, width, height) => sharp(Buffer.from(data), { raw: { width, height, channels: 4 } }).png().toBuffer();
async function fixture() {
  const data = pixels(128, 96);
  box(data, 128, 8, 8, 28, 22, [20, 90, 130, 255]);
  box(data, 128, 70, 10, 32, 24, [30, 120, 150, 255]);
  box(data, 128, 15, 52, 40, 30, [30, 160, 100, 255]);
  box(data, 128, 20, 57, 30, 20, [255, 0, 255, 255]);
  return png(data, 128, 96);
}
async function waitReady(service, id) {
  const running = service.running.get(id);
  assert.ok(running, "the task should have a live execution handle");
  await running.promise;
  const result = service.get(id);
  assert.equal(result.status, "ready", result.error);
  return result;
}

test("chromakey removes hollow-frame interiors and retains pale foreground", () => {
  const data = pixels(30, 30);
  box(data, 30, 5, 5, 20, 20, [255, 255, 240, 255]);
  box(data, 30, 8, 8, 14, 14, [255, 0, 255, 255]);
  const clean = removeBackground(data, 30, 30, options).data;
  assert.equal(clean[3], 0);
  assert.equal(clean[(10 * 30 + 10) * 4 + 3], 0);
  assert.equal(clean[(5 * 30 + 5) * 4 + 3], 255);
  assert.deepEqual([...data.slice(0, 4)], [255, 0, 255, 255], "source is immutable");
});
test("edge removal preserves enclosed white artwork and real source alpha", () => {
  const data = pixels(20, 20, [255, 255, 255, 255]);
  box(data, 20, 4, 4, 12, 12, [10, 10, 10, 255]);
  box(data, 20, 6, 6, 8, 8, [255, 255, 255, 255]);
  const clean = removeBackground(data, 20, 20, normalizeOptions({ background: "auto" })).data;
  assert.equal(clean[3], 0); assert.equal(clean[(7 * 20 + 7) * 4 + 3], 255);
  const rgba = pixels(20, 20, [0, 0, 0, 0]); box(rgba, 20, 4, 4, 10, 10, [255, 0, 255, 170]);
  assert.deepEqual(removeBackground(rgba, 20, 20, options).data, rgba);
});
test("saturated chromakey edge pixels are decontaminated, not exported with magenta fringes", () => {
  const data = pixels(12, 12);
  box(data, 12, 3, 3, 6, 6, [100, 140, 20, 255]);
  // A 50% foreground / magenta antialias pixel.
  box(data, 12, 2, 4, 1, 1, [178, 70, 138, 255]);
  const clean = removeBackground(data, 12, 12, options).data;
  const i = (4 * 12 + 2) * 4;
  assert.ok(clean[i + 3] < 255);
  assert.ok(clean[i + 2] < 138, "remove blue/magenta spill");
});
test("wide cyan glow is decontaminated across its full gradient on magenta and green keys", () => {
  for (const bg of [[255,0,255],[0,255,0]]) {
    const foreground=bg[0] ? [0,255,255] : [255,255,255];
    const data=pixels(64,64,[...bg,255]);
    for(let y=8;y<56;y++) for(let x=8;x<56;x++) {
      const alpha=Math.min(1,(Math.min(x-7,56-x,y-7,56-y))/20);
      box(data,64,x,y,1,1,[...foreground.map((v,c)=>Math.round(v*alpha+bg[c]*(1-alpha))),255]);
    }
    const clean=removeBackground(data,64,64,normalizeOptions({background:bg[0]?'#ff00ff':'#00ff00',removalMode:'color'})).data;
    for(const x of [12,18,24]) {
      const i=(32*64+x)*4,expected=Math.round((x-7)/20*255);
      assert.ok(Math.abs(clean[i+3]-expected)<=1,'wide glow retains fractional alpha');
      for(let c=0;c<3;c++) assert.ok(Math.abs(clean[i+c]-foreground[c])<=2,'remove mixed key colour');
    }
    assert.deepEqual([...clean.slice((32*64+32)*4,(32*64+32)*4+4)],[...foreground,255]);
  }
});

test("despill does not cross a solid foreground boundary to recolor interior purple", () => {
  const data=pixels(30,30);
  box(data,30,4,4,22,22,[20,180,200,255]);
  box(data,30,10,10,10,10,[160,70,180,255]);
  const clean=removeBackground(data,30,30,options).data;
  const i=(15*30+15)*4;
  assert.deepEqual([...clean.slice(i,i+4)],[160,70,180,255]);
});

test("split pipelines export clean fractional alpha for atlas, layer and sheet glows", async () => {
  const {processAtlas}=await import('../server/ui-studio/worker.mjs');
  const {expandSheets}=await import('../server/ui-studio/sheets.mjs');
  const directory=temporary(),data=pixels(64,64);
  for(let y=8;y<56;y++) for(let x=8;x<56;x++) {
    const alpha=Math.min(1,Math.min(x-7,56-x,y-7,56-y)/20);
    box(data,64,x,y,1,1,[Math.round(255*(1-alpha)),Math.round(255*alpha),255,255]);
  }
  const source=await png(data,64,64);
  fs.writeFileSync(path.join(directory,'source.png'),source);
  const assertGlow=async image=>{
    const {data:rgba,info}=await sharp(image).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    let soft=0,faint=0;
    for(let i=0;i<rgba.length;i+=4) if(rgba[i+3]>0 && rgba[i+3]<255) {
      soft++; if(rgba[i+3]<24) faint++;
      assert.ok(rgba[i]*rgba[i+3]/255<=1.5 && rgba[i+1]>252,'no visible purple spill after compositing (allow source rounding)');
    }
    assert.ok(soft>100 && faint>0,'retain wide glow and weak outer transition');
    assert.equal(info.channels,4);
  };
  for(const removalMode of ['edge','color']) {
    const result=await processAtlas({directory,source:'source.png',revision:removalMode,options:{background:'#ff00ff',removalMode,autoSplit:true}});
    await assertGlow(path.join(directory,result.slices[0].file));
  }
  const layer={id:'slice-1',name:'glow',layerType:'icon',x:0,y:0,w:64,h:64,zIndex:0,background:'#ff00ff'};
  const direct=await writeLayers(directory,{width:64,height:64},[layer],[source],'direct');
  await assertGlow(path.join(directory,direct.slices[0].file));
  const expanded=await expandSheets({upload:async url=>Buffer.from(url.split(',')[1],'base64')},{},
    [{...layer,background:undefined,sheetIndex:0,sheetRect:{x:0,y:0,w:64,h:64}}],
    [{dataUrl:`data:image/png;base64,${source.toString('base64')}`,background:'#ff00ff'}]);
  const prepared=await prepareLayerImage(Buffer.from(expanded[0].dataUrl.split(',')[1],'base64'),expanded[0],{preserveResolution:true,preserveFrame:true});
  const sheet=await writeLayers(directory,{width:64,height:64},[layer],[prepared],'sheet',undefined,{prepared:true});
  await assertGlow(path.join(directory,sheet.slices[0].file));
  const native=await sharp(prepared).ensureAlpha().raw().toBuffer();
  assert.deepEqual(Buffer.from(removeBackground(native,64,64,normalizeOptions({background:'#ff00ff',removalMode:'color'})).data),native,'existing true alpha is preserved');
});

test("diagonal strokes stay connected and nested independent sprites do not leak into crops", () => {
  const data = pixels(40, 40, [0, 0, 0, 0]);
  for (let i = 2; i < 8; i++) box(data, 40, i, i, 1, 1, [1, 2, 3, 255]);
  box(data, 40, 12, 12, 25, 25, [1, 2, 3, 255]); box(data, 40, 14, 14, 21, 21, [0, 0, 0, 0]);
  box(data, 40, 17, 20, 16, 2, [10, 20, 30, 255]);
  const { components, labels } = findComponents(data, 40, 40);
  assert.equal(components.length, 3);
  const slices = makeSlices(components, 40, 40, options);
  assert.equal(slices.length, 3);
  const frame = slices.find(s => s.w === 25);
  const crop = cropSlice(data, 40, frame, labels);
  assert.equal(crop[((20 - frame.y) * frame.w + 17 - frame.x) * 4 + 3], 0);
});
test("detached small details inside a frame are grouped with the frame", () => {
  const data = pixels(30, 30, [0, 0, 0, 0]);
  box(data, 30, 2, 2, 25, 25, [1, 2, 3, 255]); box(data, 30, 4, 4, 21, 21, [0, 0, 0, 0]);
  box(data, 30, 10, 10, 3, 3, [255, 255, 255, 255]);
  const { components } = findComponents(data, 30, 30);
  const slices = makeSlices(components, 30, 30, options);
  assert.equal(slices.length, 1); assert.equal(slices[0].componentIds.length, 2);
});
test("validates geometry and unique safe export names", () => {
  assert.throws(() => validateSlices([{ x: -1, y: 0, w: 10, h: 10 }], 20, 20));
  assert.throws(() => validateSlices([{ x: 0, y: 0, w: 30, h: 10 }], 20, 20));
  const slices = validateSlices(["../button", "../button", "按钮"].map(name => ({ name, x: 0, y: 0, w: 10, h: 10 })), 20, 20);
  assert.equal(new Set(slices.map(s => s.name)).size, 3);
  assert.ok(slices.every(s => !/[./\\]/.test(s.name)));
  assert.throws(() => normalizeOptions({ minArea: -1 }));
});
test("extract -> PNG/ZIP -> corrected revision persists without touching ordinary canvas", async () => {
  const root = temporary();
  fs.writeFileSync(path.join(root, "pending-request.json"), '{"original":"pending"}');
  const service = new UiStudioService(root);
  const source = await fixture();
  const created = await service.create({ kind: "extract", dataUrl: `data:image/png;base64,${source.toString("base64")}`, options });
  const job = await waitReady(service, created.id);
  assert.equal(job.slices.length, 3); assert.equal(job.width, 128);
  const unpacked = unzipSync(fs.readFileSync(service.asset(job.id, job.exportFile)));
  assert.equal(Object.keys(unpacked).filter(n => n.endsWith(".png")).length, 3);
  const manifest = JSON.parse(Buffer.from(unpacked["manifest.json"]).toString());
  assert.equal(manifest.origin, "top-left"); assert.equal(manifest.slices[0].x, 8);
  const sliced = await sharp(unpacked[manifest.slices[0].file]).metadata(); assert.equal(sliced.width, 28);
  service.reprocess(job.id, { slices: [{ name: "merged", x: 0, y: 0, w: 128, h: 96 }] });
  const updated = await waitReady(service, job.id);
  assert.notEqual(updated.revision, job.revision); assert.equal(updated.slices.length, 1);
  assert.ok(fs.existsSync(service.asset(job.id, job.exportFile)), "old exports stay immutable");
  service.snapshot({ document: { store: {}, hello: "UI" }, importedRevisions: [job.revision] });
  const restarted = new UiStudioService(root);
  assert.equal(restarted.get(job.id).status, "ready"); assert.equal(restarted.snapshot().document.hello, "UI");
  assert.deepEqual(restarted.snapshot().importedRevisions, [job.revision]);
  assert.equal(fs.readFileSync(path.join(root, "pending-request.json"), "utf8"), '{"original":"pending"}');
});
test("independent Agent completion automatically processes and rejects duplicate/cancelled completion", async () => {
  const service = new UiStudioService(temporary());
  const job = await service.create({ kind: "generate", provider: "agent", prompt: "three UI components", options });
  assert.equal(job.status, "awaiting_agent");
  assert.match(service.agentRequest(job.id).generationPrompt, /three UI components/);
  await service.completeAgent(job.id, await fixture());
  const completed = await waitReady(service, job.id); assert.equal(completed.slices.length, 3);
  await assert.rejects(() => service.completeAgent(job.id, Buffer.alloc(0)), /不等待/);
  const cancelled = await service.create({ provider: "agent", prompt: "cancel", options }); service.cancel(cancelled.id);
  await assert.rejects(() => service.completeAgent(cancelled.id, Buffer.alloc(0)), /不等待/);
});
test("auto-slicing detects components while retaining an opaque source background", async () => {
  const service = new UiStudioService(temporary());
  const source = await fixture();
  const created = await service.create({ kind: "extract", dataUrl: `data:image/png;base64,${source.toString("base64")}`,
    options: { ...options, removeBackground: false, padding: 2 } });
  const job = await waitReady(service, created.id);
  assert.equal(job.slices.length, 3);
  const atlas = await sharp(service.asset(job.id, job.atlasFile)).ensureAlpha().raw().toBuffer();
  const original = await sharp(source).ensureAlpha().raw().toBuffer();
  assert.deepEqual(atlas, original, "preserve every original pixel in the retained atlas");
  const slice = await sharp(service.asset(job.id, job.slices[0].file)).ensureAlpha().raw().toBuffer();
  assert.deepEqual([...slice.subarray(0, 4)], [255, 0, 255, 255], "keep opaque magenta padding in the exported crop");
});
test("API generation and reference editing both enter the same automatic local pipeline", async t => {
  const image = await fixture(); const requests = [];
  const mock = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    requests.push({ url: req.url, type: req.headers["content-type"], body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: [{ b64_json: image.toString("base64") }] }));
  });
  mock.listen(0, "127.0.0.1"); await once(mock, "listening"); t.after(() => mock.close());
  const service = new UiStudioService(temporary()); service.setConfig({ baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, model: "test-model", apiKey: "test-secret" });
  const generated = await service.create({ provider: "api", prompt: "three components", options });
  assert.equal(generated.provider, "api"); assert.equal(generated.status, "generating");
  await waitReady(service, generated.id);
  assert.equal(requests[0].url, "/v1/images/generations"); assert.equal(JSON.parse(requests[0].body).model, "test-model");
  assert.ok(!JSON.stringify(service.get(generated.id)).includes("test-secret"));
  const referenced = await service.create({ provider: "api", prompt: "reference", options, references: [`data:image/png;base64,${image.toString("base64")}`] });
  await waitReady(service, referenced.id);
  assert.equal(requests[1].url, "/v1/images/edits"); assert.match(requests[1].type, /multipart/); assert.match(requests[1].body, /image\[\]/);
  assert.ok(!JSON.stringify(service.config()).includes("test-secret"));
  const pending = await service.create({ provider: "agent", prompt: "legacy pending", options, references: [`data:image/png;base64,${image.toString("base64")}`] });
  const started = service.startGeneration(pending.id);
  assert.equal(started.id, pending.id); assert.equal(started.provider, "api"); assert.equal(started.status, "generating");
  assert.throws(() => service.startGeneration(pending.id), /重复生图/);
  await assert.rejects(() => service.completeAgent(pending.id, image), /不等待/);
  const completed = await waitReady(service, pending.id);
  assert.equal(completed.slices.length, 3); assert.equal(requests[2].url, "/v1/images/edits");
  assert.match(requests[2].body, /legacy pending/);
  assert.throws(() => service.startGeneration(pending.id), /重复生图/);
  assert.equal(requests.length, 3);
  service.setConfig({ baseUrl: "https://example.com/v1", model: "other" }); assert.equal(service.config().hasKey, false);
  const unconfigured = await service.create({ provider: "agent", prompt: "needs configuration" });
  assert.throws(() => service.startGeneration(unconfigured.id), /连接 UI 生图服务/);
  assert.equal(service.get(unconfigured.id).status, "awaiting_agent");
  await assert.rejects(() => service.create({ provider: "api", prompt: "needs configuration" }), /连接 UI 生图服务/);
});
test("Agent dispatch needs no image API, delivers once, claims once, and auto-processes completion", async () => {
  let calls = 0;
  const service = new UiStudioService(temporary(), { agentConnection: {
    status: async () => ({ connected: true }), dispatch: async () => { calls++; },
  } });
  const job = await service.create({ prompt: "agent UI components", dispatch: true, options });
  assert.equal(job.provider, "agent"); assert.equal(job.status, "agent_queued"); assert.equal(calls, 1);
  await assert.rejects(() => service.dispatchAgent(job.id), /重复触发/);
  const claimed = service.claimAgent(job.id); assert.equal(claimed.status, "agent_generating");
  assert.match(claimed.generationPrompt, /agent UI components/);
  assert.throws(() => service.claimAgent(job.id), /重复生图/);
  await service.completeAgent(job.id, await fixture());
  assert.equal((await waitReady(service, job.id)).slices.length, 3);
  assert.equal(calls, 1);
});
test("disconnected Agent preserves pending jobs; uncertain delivery never silently resends", async () => {
  let connected = false, calls = 0;
  const service = new UiStudioService(temporary(), { agentConnection: {
    status: async () => ({ connected }), dispatch: async () => { calls++; throw new Error("disconnected after write"); },
  } });
  await assert.rejects(() => service.create({ prompt: "new", dispatch: true }), /Agent 尚未连接/);
  assert.equal(service.list().length, 0);
  const pending = await service.create({ prompt: "old" });
  await assert.rejects(() => service.dispatchAgent(pending.id), /Agent 尚未连接/);
  assert.equal(service.get(pending.id).status, "awaiting_agent");
  connected = true;
  await service.dispatchAgent(pending.id);
  assert.equal(service.get(pending.id).status, "agent_unknown");
  await assert.rejects(() => service.dispatchAgent(pending.id), /重复触发/);
  service.claimAgent(pending.id); service.cancel(pending.id);
  const image = await fixture();
  await assert.rejects(() => service.completeAgent(pending.id, image), /不等待/);
  assert.equal(calls, 1);
});
test("Agent completion racing dispatch acknowledgement is not overwritten", async () => {
  let service;
  service = new UiStudioService(temporary(), { agentConnection: {
    status: async () => ({ connected: true }),
    dispatch: async id => { service.claimAgent(id); service.failAgent(id, "generation failed"); },
  } });
  const pending = await service.create({ prompt: "race", dispatch: true });
  assert.equal(pending.status, "failed"); assert.equal(pending.error, "generation failed");
});
test("HTTP isolation, traversal rejection, restart recovery and canvas uploads", async t => {
  const root = temporary(); const handler = createUiStudioHandler(root);
  const server = http.createServer(async (req, res) => { if (!await handler(req, res, new URL(req.url, "http://127.0.0.1"))) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/ui-studio`;
  const forbidden = await fetch(`${base}/config`, { headers: { Origin: "https://evil.example" } }); assert.equal(forbidden.status, 403);
  const config = await fetch(`${base}/config`); assert.equal(config.status, 200); assert.equal(config.headers.get("access-control-allow-origin"), null);
  const image = await fixture();
  const upload = await fetch(`${base}/uploads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dataUrl: `data:image/png;base64,${image.toString("base64")}` }) });
  assert.equal(upload.status, 201); const asset = await upload.json();
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}${asset.src}`)).status, 200);
  const save = value => fetch(`${base}/snapshot`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  const saved = await save({ document: { store: {} }, baseRevision: 0 });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).revision, 1);
  const stale = await save({ document: { store: {} }, baseRevision: 0 });
  assert.equal(stale.status, 409); assert.match((await stale.json()).error, /暂停/);
  const service = new UiStudioService(root);
  assert.throws(() => service.asset("12345678-1234-1234-1234-123456789012", "../provider.local.json"));
  const pending = await service.create({ provider: "agent", prompt: "pending" });
  service.save({ ...pending, status: "generating" });
  const restart = new UiStudioService(root); assert.equal(restart.get(pending.id).status, "failed");
  assert.match(buildAtlasPrompt(pending), /separate reusable UI components/);
});

test('snapshot rejects stale tabs and null saves, preserves recovery copies, and refuses corrupt data', () => {
  const root = temporary();
  const document = { store: { shape1: { id: 'shape1', typeName: 'shape' } } };
  assert.equal(saveSnapshot(root, { document }).revision, 1);
  const tabA = readSnapshot(root), tabB = readSnapshot(root);
  saveSnapshot(root, { document: { ...document, marker: 'newer' }, baseRevision: tabA.revision });
  assert.throws(() => saveSnapshot(root, { document: { store: {} }, baseRevision: tabB.revision }), e => e.status === 409);
  assert.throws(() => saveSnapshot(root, { document: { store: {} } }), e => e.status === 409, 'old clients cannot overwrite newer snapshots');
  assert.equal(readSnapshot(root).document.marker, 'newer');
  assert.throws(() => saveSnapshot(root, { document: null, baseRevision: 2 }), /不完整/);
  assert.throws(() => saveSnapshot(root, { document: {}, baseRevision: 2 }), /不完整/);
  saveSnapshot(root, { document: { store: {} }, baseRevision: 2 });
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'snapshot.before-empty.json'))).document.store.shape1);
  fs.writeFileSync(path.join(root, 'snapshot.json'), '{damaged');
  assert.throws(() => readSnapshot(root));
  assert.throws(() => saveSnapshot(root, { document }));
});

test('atomic replacement retries transient Windows locks without deleting the prior file', () => {
  const root = temporary(), target = path.join(root, 'saved.json'), source = path.join(root, 'pending.json');
  fs.writeFileSync(target, 'old'); fs.writeFileSync(source, 'new');
  let attempts = 0;
  replaceFile(source, target, (from, to) => {
    if (++attempts < 3) { assert.equal(fs.readFileSync(to, 'utf8'), 'old'); throw Object.assign(new Error('locked'), { code: 'EPERM' }); }
    fs.renameSync(from, to);
  }, () => {});
  assert.equal(attempts, 3); assert.equal(fs.readFileSync(target, 'utf8'), 'new');
  fs.writeFileSync(source, 'next');
  assert.throws(() => replaceFile(source, target, () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); }, () => {}), /locked/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
});

test('split output fits native aspect ratio and publishes the same layout in its manifest and preview', async () => {
  const directory = temporary();
  const image = await sharp({create:{width:585,height:130,channels:4,background:'#123456'}}).png().toBuffer();
  for (const prepared of [false, true]) {
    const job = {width:300,height:100};
    // Prepared inputs also cover reference-guided reconstruction and reuse.
    const result = await writeLayers(directory, job,
      [{id:'slice-1',name:'button',x:10,y:20,w:250,h:59,zIndex:0,allowOpaque:true}], [image], String(prepared),
      path.join(directory,'cache'), {prepared});
    const slice = result.slices[0];
    assert.deepEqual([slice.x,slice.y,slice.w,slice.h], [10,21,250,56]);
    assert.deepEqual(slice.plannedRect,{x:10,y:20,w:250,h:59});
    assert.deepEqual([slice.imageWidth,slice.imageHeight],[585,130]);
    const manifest=JSON.parse(fs.readFileSync(path.join(directory,result.manifestFile),'utf8'));
    assert.equal(manifest.layers[0].h,56);
    const atlas=await sharp(path.join(directory,result.atlasFile)).ensureAlpha().raw().toBuffer();
    assert.equal(atlas[(20*300+10)*4+3],0);
    assert.ok(atlas[(23*300+11)*4+3]>0);
  }
});

test('semantic matting produces true alpha and hollow interiors; opaque checkerboards and empty layers fail', async () => {
  const input = pixels(30, 20);
  box(input, 30, 3, 3, 24, 14, [230, 190, 50, 255]);
  box(input, 30, 5, 5, 20, 10, [255, 0, 255, 255]);
  const image = await png(input, 30, 20);
  const layer = { name: '边框', layerType: 'border', w: 24, h: 14, background: '#ff00ff' };
  const result = await prepareLayerImage(image, layer);
  const meta = await sharp(result).metadata(); assert.equal(meta.hasAlpha, true); assert.equal(meta.width, 24);
  const raw = await sharp(result).raw().toBuffer();
  assert.equal(raw[(7 * 24 + 12) * 4 + 3], 0, 'hollow center is transparent');
  assert.equal(raw[3], 255, 'gold frame retained');
  const checker = pixels(30, 20, [180, 180, 180, 255]);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 30; x++) if ((Math.floor(x / 2) + Math.floor(y / 2)) % 2) box(checker, 30, x, y, 1, 1, [230, 230, 230, 255]);
  const rgb = await sharp(await png(checker, 30, 20)).removeAlpha().png().toBuffer();
  await assert.rejects(() => prepareLayerImage(rgb, layer), /均匀纯色/);
  await assert.rejects(() => prepareLayerImage(rgb, { ...layer, background: undefined }), /真实透明/);
  await assert.rejects(() => prepareLayerImage(image, { ...layer, w: 100 }), /宽高比/);
  const empty = await png(pixels(30, 20, [0, 0, 0, 0]), 30, 20);
  await assert.rejects(() => prepareLayerImage(empty, { ...layer, background: undefined }), /没有可见/);
});

test('rejected layer set leaves original component, snapshot, and source files intact; a new attempt can succeed', async () => {
  const service = new UiStudioService(temporary());
  const original = await service.create({ kind: 'extract', dataUrl: `data:image/png;base64,${(await fixture()).toString('base64')}`, options });
  const parent = await waitReady(service, original.id), slice = parent.slices[0];
  service.snapshot({ document: { store: { source: { typeName: 'shape', id: 'source' } } }, session: { currentPageId: 'Test2' } });
  const before = service.snapshot();
  const sourceBytes = fs.readFileSync(service.asset(parent.id, slice.file));
  const request = { revision: parent.revision, sliceId: slice.id, dispatch: false };
  const child = await service.refine(parent.id, request);
  const opaque = await png(pixels(8, 8, [90, 90, 90, 255]), 8, 8);
  const bad = { name: 'bad', layerType: 'icon', x: 0, y: 0, w: 8, h: 8, zIndex: 1, dataUrl: `data:image/png;base64,${opaque.toString('base64')}` };
  await assert.rejects(() => service.completeLayers(child.id, { layers: [bad, bad] }), /真实透明/);
  assert.equal(service.get(child.id).status, 'failed');
  assert.equal(service.get(child.id).revision, undefined);
  assert.deepEqual(service.snapshot(), before);
  assert.deepEqual(service.get(parent.id), parent);
  assert.deepEqual(fs.readFileSync(service.asset(parent.id, slice.file)), sourceBytes);
  assert.ok(fs.existsSync(service.asset(child.id, service.get(child.id).sourceFile)));
  const retry = await service.refine(parent.id, request);
  const color = pixels(12, 12); box(color, 12, 2, 2, 8, 8, [20, 80, 160, 255]);
  const good = { ...bad, background: '#ff00ff', dataUrl: `data:image/png;base64,${(await png(color, 12, 12)).toString('base64')}` };
  const result = await service.completeLayers(retry.id, { layers: [good, { ...good, x: 10, name: 'second' }] });
  assert.equal(result.status, 'ready'); assert.equal(result.slices.length, 2);
  assert.deepEqual(service.snapshot(), before, 'completion never rewrites the source canvas snapshot');
});

test('semantic classification preserves image identity, enforces revisions, and keeps font metadata through slicing', async () => {
  const service = new UiStudioService(temporary());
  const original = await service.create({ kind: 'extract', dataUrl: `data:image/png;base64,${(await fixture()).toString('base64')}`, options });
  const job = await waitReady(service, original.id), first = job.slices[0];
  const bytes = fs.readFileSync(service.asset(job.id, first.file));
  const updated = service.metadata(job.id, { revision: job.revision, presetName: '测试预设', slices: [{ id: first.id, name: '开始文字', layerType: 'text', text: '开始', fontFamily: 'MyFont SDF', fontSize: 30, textRender: 'editable' }] });
  assert.equal(updated.revision, job.revision); assert.equal(updated.slices[0].file, first.file);
  assert.deepEqual(fs.readFileSync(service.asset(job.id, first.file)), bytes);
  assert.equal(validateSlices(updated.slices, job.width, job.height)[0].fontFamily, 'MyFont SDF');
  assert.equal(sliceForShape(updated, { uiRole: 'slice', uiName: first.name, sourceRect: first }).id, first.id);
  assert.throws(() => service.metadata(job.id, { revision: job.revision, metadataRevision: 0, presetName: 'stale' }), /其他窗口/);
  assert.throws(() => service.metadata(job.id, { revision: 'stale' }), /版本/);
  assert.throws(() => service.metadata(job.id, { revision: job.revision, metadataRevision: 1, slices: [{ id: first.id, layerType: 'bad' }] }), /类型/);
  const classify = await service.classify(job.id, { revision: job.revision, dispatch: false });
  const request = service.claimAgent(classify.id); assert.match(request.generationPrompt, /do not generate/);
  service.metadata(job.id, { revision: job.revision, metadataRevision: 1, presetName: '人工新名称' });
  assert.throws(() => service.completeClassification(classify.id, { slices: job.slices.map(s => ({ id: s.id, layerType: 'icon' })) }), /其他窗口/);
  assert.equal(service.get(job.id).presetName, '人工新名称');
  const retry = await service.classify(job.id, { revision: job.revision, dispatch: false });
  service.claimAgent(retry.id);
  service.completeClassification(retry.id, { presetName: '图标预设', slices: job.slices.map(s => ({ id: s.id, name: s.name, layerType: 'icon' })) });
  assert.equal(service.get(job.id).slices[0].semanticSource, 'ai');
  assert.equal(buildLayerTree(service.list()).length, 1, 'classification tasks are not renderable layers');
});

test('PSD and Unity exports preserve component hierarchy, pixel positions, types and raster transparency', async () => {
  initializeCanvas(() => { throw new Error('No canvas required'); }, (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }));
  const service = new UiStudioService(temporary());
  const initial = await service.create({ kind: 'extract', dataUrl: `data:image/png;base64,${(await fixture()).toString('base64')}`, options });
  const job = await waitReady(service, initial.id), slice = job.slices[0];
  service.metadata(job.id, { revision: job.revision, presetName: '主界面', slices: [{ id: slice.id, layerType: 'button', name: '开始按钮' }] });
  const child = await service.refine(job.id, { revision: job.revision, sliceId: slice.id, dispatch: false });
  const data = pixels(6, 6, [0, 0, 0, 0]); box(data, 6, 0, 1, 6, 4, [255, 255, 255, 255]); box(data, 6, 1, 0, 4, 6, [255, 255, 255, 255]);
  const image = `data:image/png;base64,${(await png(data, 6, 6)).toString('base64')}`;
  await service.completeLayers(child.id, { layers: [
    { name: '底图', layerType: 'background', x: 0, y: 0, w: 6, h: 6, zIndex: 0, dataUrl: image },
    { name: '开始', layerType: 'text', text: '开始', fontFamily: 'Example SDF', fontSize: 18, textRender: 'editable', x: 8, y: 2, w: 6, h: 6, zIndex: 1, dataUrl: image },
  ] });
  const input = { revision: job.revision, sliceId: slice.id };
  const tree = buildPreset(service, job.id, input);
  assert.equal(tree.root.layerType, 'button'); assert.equal(tree.root.children.length, 2);
  assert.equal(buildPreset(service, job.id, { ...input, variant: 'source' }).root.children.length, 0);
  const psd = await service.exportPreset(job.id, { ...input, format: 'psd' });
  const parsed = readPsd(fs.readFileSync(service.asset(job.id, psd.file)), { useImageData: true, skipThumbnail: true });
  assert.equal(parsed.width, slice.w); assert.equal(parsed.children[0].children.length, 2);
  const label = parsed.children[0].children.find(s => s.name.includes('[text]'));
  assert.equal(label.left, 8); assert.equal(label.top, 2); assert.equal(label.imageData.data[3], 0);
  const output = await service.exportPreset(job.id, { ...input, format: 'unity' });
  const zip = unzipSync(fs.readFileSync(service.asset(job.id, output.file)));
  const manifest = JSON.parse(Buffer.from(zip[Object.keys(zip).find(k => k.endsWith('/preset.json'))]));
  assert.equal(manifest.root.children[1].fontFamily, 'Example SDF'); assert.equal(manifest.root.children[1].text, '开始');
  assert.equal(Object.keys(zip).filter(k => k.includes('/Sprites/')).length, 1, 'identical image pixels share one sprite while both semantic nodes remain');
  assert.equal(manifest.root.children.length, 2);
  assert.equal(manifest.root.children[0].sprite, manifest.root.children[1].sprite);
  assert.match(Buffer.from(zip['Assets/DrawPaint/Editor/DrawPaintPresetImporter.cs']).toString(), /SaveAsPrefabAsset/);
  assert.match(Buffer.from(zip['Assets/DrawPaint/Editor/DrawPaintPresetImporter.cs']).toString(), /UnityEngine.UI.Button/);
  assert.equal(service.get(job.id).revision, job.revision);
});

test('editable hierarchy reparents and orders without changing source provenance, and survives reload', async () => {
  const { moveLayerNode } = await import('../src/ui-studio/layer-tree.js');
  const jobs = [{ id: 'a', revision: 'r', slices: [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }, { id: 'three', name: 'Three' }] },
    { id: 'b', revision: 's', operation: 'decompose', parent: { jobId: 'a', revision: 'r', sliceId: 'one', name: 'One' }, slices: [{ id: 'child', name: 'Child' }] }];
  const original = JSON.stringify(jobs), roots = buildLayerTree(jobs);
  const one = 'a/r/one', two = 'a/r/two', three = 'a/r/three', child = 'b/s/root';
  const layout = moveLayerNode(roots, child, two, 'inside');
  let tree = buildLayerTree(jobs, JSON.parse(JSON.stringify(layout)));
  assert.equal(tree[0].children[1].children[0].jobId, 'b');
  assert.equal(tree[0].children[0].children.length, 0);
  assert.equal(JSON.stringify(jobs), original);
  assert.throws(() => moveLayerNode(tree, two, 'b/s/child', 'inside'), /子节点/);
  assert.throws(() => moveLayerNode(tree, two, two, 'after'), /自身/);
  tree = buildLayerTree(jobs, moveLayerNode(tree, three, one, 'before'));
  assert.deepEqual(tree[0].children.map(n => n.sliceId), ['three', 'one', 'two']);
  tree = buildLayerTree(jobs, moveLayerNode(tree, one, three, 'after'));
  assert.deepEqual(tree[0].children.map(n => n.sliceId), ['three', 'one', 'two']);
  tree = buildLayerTree(jobs, moveLayerNode(tree, child, null));
  assert.equal(tree.at(-1).jobId, 'b');
  // A former child can become its old parent's parent, once detached.
  tree = buildLayerTree(jobs, moveLayerNode(tree, 'a/r/root', child));
  assert.equal(tree[0].jobId, 'b');
  assert.equal(tree[0].children.at(-1).jobId, 'a');
  const stale = buildLayerTree(jobs, { [one]: { parent: 'missing', order: 0 }, [two]: { parent: three }, [three]: { parent: two } });
  assert.equal(flattenLayerTree(stale).length, 6, 'corrupt cycles do not lose nodes or recurse forever');
});

test('nested visibility restores original opacity and reparenting clears former ancestors only', async () => {
  const { visibilityChange, hierarchyVisibility } = await import('../src/ui-studio/visibility.js');
  let shape = { id: 'shape:one', type: 'image', opacity: .6, meta: {} };
  shape = visibilityChange(shape, 'child', false);
  shape = visibilityChange(shape, 'parent', false);
  shape = visibilityChange(shape, 'parent', true);
  assert.equal(shape.opacity, 0, 'revealing parent preserves individually hidden child');
  shape = visibilityChange(shape, 'child', true);
  assert.equal(shape.opacity, .6);
  shape = visibilityChange(shape, 'old-parent', false);
  shape = hierarchyVisibility(shape, 'child', { child: { parent: 'new-parent' }, 'new-parent': { parent: null } }, new Set(['old-parent']));
  assert.equal(shape.opacity, .6, 'moving out of hidden parent restores the image');
  shape = hierarchyVisibility(shape, 'child', { child: { parent: 'new-parent' }, 'new-parent': { parent: null } }, new Set(['new-parent', 'child']));
  assert.equal(shape.opacity, 0);
  assert.deepEqual(shape.meta.uiHiddenBy, ['new-parent', 'child']);
});

test('world and local coordinates round-trip, follow parent motion, and remain stable outside parent bounds', async () => {
  const { worldToLocal, localToWorld, commonTranslation } = await import('../src/ui-studio/coordinate-math.js');
  const parent = { x: 300, y: -100 }, child = { x: 280, y: -125 };
  assert.deepEqual(worldToLocal(child, parent), { x: -20, y: -25 });
  assert.deepEqual(localToWorld(worldToLocal(child, parent), parent), child);
  assert.deepEqual(worldToLocal(child), child, 'root uses the world origin');
  assert.deepEqual(worldToLocal({ x: 330, y: -95 }, { x: 350, y: -70 }), { x: -20, y: -25 });
  const before = [{ id: 'a', page: 'p', x: 300, y: -100 }, { id: 'b', page: 'p', x: 280, y: -125 }];
  const moved = before.map(p => ({ ...p, x: p.x + 50, y: p.y + 30 }));
  assert.deepEqual(commonTranslation(before, moved), { x: 50, y: 30 });
  assert.deepEqual(commonTranslation(moved, before), { x: -50, y: -30 }, 'undo restores the fixed origin');
  assert.equal(commonTranslation(before, [before[0], { ...before[1], x: 200 }]), null, 'moving a child past the parent does not shift the parent origin');
  assert.equal(commonTranslation(before, [moved[0]]), null, 'reparenting does not move the origin');
  assert.equal(commonTranslation(before, moved.map(p => ({ ...p, page: 'another' }))), null);
  assert.equal(commonTranslation([before[0]], [moved[0]]), null, 'one child can move independently');
  assert.deepEqual(commonTranslation([before[0]], [moved[0]], true), { x: 50, y: 30 });
  assert.deepEqual(worldToLocal(child, { x: 200, y: 0 }), { x: 80, y: -125 }, 'reparenting changes local coordinates without changing world coordinates');
});
