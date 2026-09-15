import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AgentThreads, toolPayload } from "../server/ui-studio/agent-threads.mjs";

const result = value => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
function harness(t) {
  fs.mkdirSync("tmp", { recursive: true });
  const root = fs.mkdtempSync(path.resolve("tmp", "agent-threads-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [], state = { jobStatus: "ready", turnStatus: "completed", threadStatus: "idle", archiveFails: false };
  const deps = {
    ownerThreadId: "owner", messageFor: job => `Only job ${job.id}`,
    request: async () => ({ status: state.jobStatus }),
    call: async (name, args) => {
      calls.push({ name, args });
      if (name === "create_thread") return result({ threadId: `fresh-${calls.length}`, hostId: "local" });
      if (name === "wait_threads") return result({ polls: args.targets.map(target => ({ cursor: "cursor",
        thread: { id: target.threadId, status: { type: state.threadStatus } }, latestTurn: { status: state.turnStatus } })) });
      if (name === "set_thread_archived" && state.archiveFails) throw new Error("archive unavailable");
      if (name === "set_thread_archived") return result({ archived: true });
      throw new Error(`Unexpected call: ${name}`);
    },
  };
  return { root, calls, state, deps, manager: new AgentThreads(root, deps) };
}

test("each job creates a fresh context, with no inherited model, project or owner prompt", async t => {
  const h = harness(t);
  const one = await h.manager.dispatch({ id: "one", operation: "decompose" });
  const two = await h.manager.dispatch({ id: "two" });
  assert.notEqual(one.threadId, two.threadId);
  assert.ok(h.calls.every(c => c.name === "create_thread"));
  assert.deepEqual(h.calls[0].args.target, { type: "projectless", directoryName: "drawpaint-ui-one" });
  assert.equal(h.calls[0].args.prompt, "Only job one");
  assert.equal(h.calls[0].args.model, undefined);
  await assert.rejects(h.manager.dispatch({ id: "one" }), /不能重复/);
  const restarted = new AgentThreads(h.root, h.deps);
  await assert.rejects(restarted.dispatch({ id: "one" }), /不能重复/);
  assert.equal(h.calls.length, 2);
});

test("concurrent duplicate clicks and uncertain create responses never create twice", async t => {
  const h = harness(t);
  let resolve;
  h.deps.call = async () => new Promise(done => { resolve = done; });
  const manager = new AgentThreads(h.root, h.deps);
  const first = manager.dispatch({ id: "one" });
  await assert.rejects(manager.dispatch({ id: "one" }), /不能重复/);
  resolve(result({ clientThreadId: "pending-id" }));
  await assert.rejects(first, /未取得新对话/);
  assert.equal(manager.jobs.get("one").state, "unknown");
  await assert.rejects(new AgentThreads(h.root, h.deps).dispatch({ id: "one" }), /不能重复/);
});

test("completion retains execution threads across restart and never archives", async t => {
  const h = harness(t);
  const created = await h.manager.dispatch({ id: "one" });
  assert.equal(created.autoArchive,false);
  h.state.turnStatus = "inProgress"; h.state.threadStatus = "active";
  await h.manager.poll();
  assert.equal(h.calls.filter(c => c.name === "set_thread_archived").length, 0);
  h.state.turnStatus = "completed"; h.state.threadStatus = "idle"; h.state.jobStatus = "processing";
  await h.manager.poll();
  h.state.jobStatus = "agent_generating"; // Could be waiting for user input.
  await h.manager.poll();
  assert.match(h.manager.jobs.get("one").attention,/尚未完成/);
  assert.equal(h.calls.filter(c => c.name === "set_thread_archived").length, 0);
  h.state.jobStatus = "ready";
  const restarted = new AgentThreads(h.root, h.deps);
  await restarted.poll();
  assert.equal(restarted.jobs.get("one").state,"retained");
  assert.equal(restarted.jobs.get("one").attention,null);
  assert.equal(restarted.jobs.get("one").outcome, "ready");
  await new AgentThreads(h.root, h.deps).poll();
  assert.equal(h.calls.filter(c => c.name === "set_thread_archived").length, 0);
});

test("failed and cancelled jobs retain their execution threads without regeneration", async t => {
  const h = harness(t);
  await h.manager.dispatch({ id: "one" });
  h.state.jobStatus = "failed"; h.state.turnStatus = "failed"; h.state.archiveFails = true;
  await h.manager.poll();
  assert.equal(h.manager.jobs.get("one").state, "retained");
  h.state.archiveFails = false;
  await h.manager.poll();
  assert.equal(h.manager.jobs.get("one").state, "retained");
  await h.manager.dispatch({ id: "two" });
  h.state.jobStatus = "cancelled"; h.state.turnStatus = "interrupted";
  await h.manager.poll();
  assert.equal(h.manager.jobs.get("two").outcome, "cancelled");
  assert.equal(h.calls.filter(c => c.name === "create_thread").length, 2);
  assert.equal(h.calls.filter(c => c.name === "set_thread_archived").length,0);
});

test("missing snapshots, tool errors and corrupt state never imply successful execution", async t => {
  const h = harness(t);
  await h.manager.dispatch({ id: "one" });
  h.manager.call = async () => result({ errors: [{ message: "offline" }], polls: [] });
  await h.manager.poll();
  assert.equal(h.manager.jobs.get("one").state, "active");
  assert.throws(() => toolPayload({ isError: true, content: [{ type: "text", text: "denied" }] }), /denied/);
  fs.writeFileSync(h.manager.file, "invalid");
  assert.throws(() => new AgentThreads(h.root, h.deps), /记录损坏/);
});


test("candidate completion is retained and each retry has a distinct persistent receipt",async t=>{
  const h=harness(t);
  await h.manager.dispatch({id:'one',operation:'decompose'});
  h.state.jobStatus='review_repairs';await h.manager.poll();
  assert.equal(h.manager.jobs.get('one').state,'retained');assert.equal(h.manager.jobs.get('one').attention,null);
  await h.manager.dispatch({id:'one',operation:'decompose',attempt:1});
  assert.equal(h.calls.filter(c=>c.name==='create_thread').length,2);
  await assert.rejects(new AgentThreads(h.root,h.deps).dispatch({id:'one',attempt:1}),/不能重复/);
  assert.equal(h.calls.filter(c=>c.name==='set_thread_archived').length,0);
});
