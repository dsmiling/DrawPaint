import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildVideoGraph, closestH3AspectRatio, inspectVideoModels } from "../server/video-models.mjs";

test("model inventory reports missing files and node readiness", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drawpaint-models-"));
  try {
    const models = inspectVideoModels(dir, false, null);
    assert.equal(models.length, 2);
    assert.equal(models[0].installed, false);
    assert.equal(models[0].ready, false);
    assert.ok(models[0].missingFiles.includes("diffusion_models/minimax_h3_fl2va_pruned_fp8_scaled.safetensors"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("selected workflow receives the correct images, prompt and duration constraints", () => {
  const input = { image: "start.png", prompt: "walk", seconds: 2, id: "demo", imageWidth: 768, imageHeight: 1024 };
  const h3 = buildVideoGraph({ ...input, modelId: "minimax-h3", lastImage: "end.png" });
  assert.equal(h3["114"].inputs.image, "start.png");
  assert.equal(h3["115"].inputs.aspect_ratio, "3:4 (Portrait Standard)");
  assert.equal(h3["130"].inputs.image, "end.png");
  assert.equal(h3["105:104"].inputs.prompt, "walk");
  const wan = buildVideoGraph({ ...input, modelId: "wan-2.2-5b" });
  assert.equal(wan["4"].inputs.image, "start.png");
  assert.equal(wan["7"].inputs.length, 33);
  assert.throws(() => buildVideoGraph({ ...input, modelId: "wan-2.2-5b", lastImage: "end.png" }), /尾帧/);
  assert.throws(() => buildVideoGraph({ ...input, modelId: "wan-2.2-5b", seconds: 5 }), /不支持/);
});

test("H3 selects the closest supported aspect ratio from the input photo", () => {
  assert.equal(closestH3AspectRatio(768, 1024), "3:4 (Portrait Standard)");
  assert.equal(closestH3AspectRatio(1920, 1080), "16:9 (Widescreen)");
  assert.equal(closestH3AspectRatio(600, 1000), "9:16 (Portrait Widescreen)");
  assert.throws(() => closestH3AspectRatio(0, 1024), /宽高/);
});
