import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGeneratedVideoStore } from "../server/video-generated.mjs";

test("completed video remains available after ComfyUI history and output disappear", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drawpaint-generated-"));
  try {
    const canvasDir = path.join(root, "DrawPaint", "canvas");
    const outputDir = path.join(root, "ComfyUI", "output", "video");
    fs.mkdirSync(outputDir, { recursive: true });
    const original = path.join(outputDir, "generated.mp4");
    fs.writeFileSync(original, "video bytes");
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const store = createGeneratedVideoStore({
      canvasDir,
      comfyJson: async () => ({ [id]: { outputs: {} } }),
      videoOutput: () => ({ subfolder: "video", filename: "generated.mp4" }),
    });
    const first = await store.resolve(id);
    assert.equal(fs.readFileSync(first.file, "utf8"), "video bytes");
    fs.unlinkSync(original);
    const restarted = createGeneratedVideoStore({
      canvasDir,
      comfyJson: async () => { throw new Error("ComfyUI history unavailable"); },
      videoOutput: () => null,
    });
    const second = await restarted.resolve(id);
    assert.equal(second.file, first.file);
    assert.equal(fs.readFileSync(second.file, "utf8"), "video bytes");
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
