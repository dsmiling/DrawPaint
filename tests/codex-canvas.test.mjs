import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  initCanvasLayout,
  pendingRequestPath,
  readJson,
  snapshotPath,
  writeJson,
} from "../server/storage.mjs";

const cli = path.resolve("scripts/drawpaint.mjs");

function run(project, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: path.resolve("."),
    env: { ...process.env, DRAWPAINT_PROJECT_DIR: project },
    encoding: "utf8",
  });
}

function workspace(t) {
  fs.mkdirSync("tmp", { recursive: true });
  const project = fs.mkdtempSync(path.resolve("tmp", "codex-canvas-test-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  return { project, canvas: initCanvasLayout(project) };
}

test("Codex CLI reads an exact pending request", t => {
  const { project, canvas } = workspace(t);
  const request = { id: "11111111-1111-4111-8111-111111111111", type: "ai_image_generate", prompt: "moon" };
  writeJson(pendingRequestPath(canvas), request);

  const result = run(project, "request", request.id);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), request);
  assert.notEqual(run(project, "request", "22222222-2222-4222-8222-222222222222").status, 0);
});

test("Codex CLI replaces an AI holder and clears the request", async t => {
  const { project, canvas } = workspace(t);
  const request = {
    id: "33333333-3333-4333-8333-333333333333",
    type: "ai_image_generate",
    prompt: "finished image",
    anchorShapeId: "shape:holder",
  };
  writeJson(pendingRequestPath(canvas), request);
  writeJson(snapshotPath(canvas), {
    schema: "drawpaint.snapshot.v1",
    document: {
      store: {
        "page:page": { id: "page:page", typeName: "page", name: "Page 1", index: "a1", meta: {} },
        "shape:holder": {
          id: "shape:holder", typeName: "shape", type: "frame", parentId: "page:page",
          index: "a1", x: 25, y: 40, rotation: 0, meta: { drawpaintAiImageHolder: true },
          props: { w: 320, h: 180, name: "AI 图片" },
        },
      },
    },
  });
  const image = path.join(project, "result.png");
  await sharp({ create: { width: 8, height: 8, channels: 4, background: "#336699" } }).png().toFile(image);

  const result = run(project, "complete", request.id, image);
  assert.equal(result.status, 0, result.stderr);
  const completion = JSON.parse(result.stdout);
  assert.equal(completion.replacedHolder, true);
  assert.equal(readJson(pendingRequestPath(canvas), "missing"), null);

  const store = readJson(snapshotPath(canvas)).document.store;
  assert.equal(store["shape:holder"], undefined);
  const generated = Object.values(store).find(record => record.typeName === "shape" && record.type === "image");
  assert.deepEqual({ x: generated.x, y: generated.y, w: generated.props.w, h: generated.props.h }, { x: 25, y: 40, w: 320, h: 180 });
});

test("Codex CLI rejects a missing output without clearing the request", t => {
  const { project, canvas } = workspace(t);
  const request = { id: "44444444-4444-4444-8444-444444444444", type: "ai_image_generate" };
  writeJson(pendingRequestPath(canvas), request);

  const result = run(project, "complete", request.id);
  assert.notEqual(result.status, 0);
  assert.deepEqual(readJson(pendingRequestPath(canvas)), request);
});
