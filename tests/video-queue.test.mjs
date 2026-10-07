import test from "node:test";
import assert from "node:assert/strict";
import { createVideoQueueReader, indexVideoQueue } from "../server/video-queue.mjs";
import { enqueueVideoDrafts, sortVideoQueue, videoQueueLabel } from "../shared/video-queue.js";

const entry = (order, id) => [order, id, {}, {}, []];
function reader(ids, queue, resolve) {
  return createVideoQueueReader({ jobIds: new Set(ids), jobOptions: Object.fromEntries(ids.map(id => [id, { name: id }])), generatedStore: { resolve }, comfyJson: async route => { assert.equal(route, "/queue"); return queue; } });
}

test("pending prompts follow execution priority, including work from other tools", async () => {
  const queue = { queue_running: [entry(10, "first")], queue_pending: [entry(14, "third"), entry(12, "external-image"), entry(13, "second")] };
  const service = reader(["first", "second", "third"], queue, async () => { throw new Error("queued prompts must not request history"); });
  const { jobs } = await service.read();
  assert.equal(jobs.find(job => job.id === "first").queueState, "running");
  assert.equal(jobs.find(job => job.id === "second").queuePosition, 2);
  assert.equal(jobs.find(job => job.id === "third").queuePosition, 3);
  assert.deepEqual(sortVideoQueue(jobs).map(job => job.id), ["first", "second", "third"]);
  assert.equal(videoQueueLabel(jobs.find(job => job.id === "second")), "等待中 · 第 2 位");
  assert.throws(() => indexVideoQueue({ queue_pending: [] }), /格式无效/);
});

test("completion advances the next job from waiting to generating without changing job ids", async () => {
  const queue = { queue_running: [entry(1, "first")], queue_pending: [entry(2, "second")] };
  const service = reader(["first", "second"], queue, async id => ({ file: `${id}.mp4`, history: null }));
  assert.equal((await service.get("second")).queueState, "queued");
  queue.queue_running = [entry(2, "second")]; queue.queue_pending = [];
  assert.equal((await service.get("first")).status, "completed");
  const next = await service.get("second");
  assert.equal(next.id, "second"); assert.equal(next.queueState, "running"); assert.equal(next.queuePosition, null);
  queue.queue_running = [];
  assert.equal((await service.get("second")).url, "/api/video/jobs/second/file");
});

test("a failed generation reports its error while the next queued prompt runs", async () => {
  const service = reader(["failed", "next"], { queue_running: [entry(2, "next")], queue_pending: [] }, async () => ({ file: null, history: { status: { status_str: "error", messages: [["execution_error", { exception_message: "out of memory" }]] } } }));
  const jobs = (await service.read()).jobs;
  assert.equal(jobs.find(job => job.id === "failed").error, "out of memory");
  assert.equal(jobs.find(job => job.id === "failed").status, "failed");
  assert.equal(jobs.find(job => job.id === "next").queueState, "running");
});

test("the queue includes older active tasks beyond its recent history limit", async () => {
  const service = reader(["old", "recent1", "recent2"], { queue_running: [], queue_pending: [entry(1, "old")] }, async id => ({ file: `${id}.mp4` }));
  assert.equal((await service.read(1)).jobs.length, 1);
  const snapshot = await service.read(1, true);
  assert.deepEqual(snapshot.jobs.map(job => job.id), ["recent2", "old"]);
});

test("disconnects preserve finished videos and keep unfinished clips polling", async () => {
  const service = createVideoQueueReader({ jobIds: new Set(["done", "pending"]), jobOptions: {}, comfyJson: async () => { throw new Error("offline"); }, generatedStore: { resolve: async id => { if (id === "done") return { file: "cached.mp4" }; throw new Error("offline"); } } });
  const snapshot = await service.read();
  assert.equal(snapshot.connected, false);
  assert.equal(snapshot.jobs.find(job => job.id === "done").status, "completed");
  const pending = snapshot.jobs.find(job => job.id === "pending");
  assert.equal(pending.status, "running"); assert.equal(pending.queueState, "unknown");
  assert.match(pending.error, /自动更新/);
});

test("background processing is polled before reporting a completed animation", async () => {
  let state = { file: null, processing: true, processedFrames: 8 };
  const service = reader(["sprite"], { queue_running: [], queue_pending: [] }, async (_id, options) => { assert.equal(options.wait, false); return state; });
  const processing = await service.get("sprite");
  assert.equal(processing.status, "running"); assert.equal(processing.url, null);
  assert.equal(videoQueueLabel(processing), "固定底色中");
  state = { file: null, processingError: "background is not uniform" };
  assert.equal((await service.get("sprite")).status, "failed");
  state = { file: "fixed.mp4" };
  assert.equal((await service.get("sprite")).status, "completed");
});

test("batch submissions remain serial and a rejection does not stop later clips", async () => {
  const clips = ["first", "bad", "last"].map(id => ({ id, name: id }));
  let concurrent = 0, peak = 0;
  const starts = [], finishes = [];
  const result = await enqueueVideoDrafts(clips, async clip => {
    concurrent++; peak = Math.max(peak, concurrent); starts.push(clip.id);
    await new Promise(resolve => setTimeout(resolve, 5));
    concurrent--; finishes.push(clip.id);
    if (clip.id === "bad") throw new Error("invalid image");
  });
  assert.equal(peak, 1);
  assert.deepEqual(starts, ["first", "bad", "last"]); assert.deepEqual(finishes, starts);
  assert.equal(result.added, 2); assert.deepEqual(result.failures, [{ id: "bad", name: "bad", error: "invalid image" }]);
});
