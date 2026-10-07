import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attachedVideoSequences } from "../server/video-attached-sequences.mjs";

test("completed transparent frames reconnect after reopening a canvas and prefer the newest export", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "drawpaint-attached-sequences-"));
  try {
    const source = { type: "job", id: "job-one" }, clip = { id: "clip-one", source, status: "completed", in: 0, out: 2 };
    const project = { id: "canvas-one", clips: [clip] };
    const records = {};
    for (const [id, date] of [["older", "2026-10-01"], ["newer", "2026-10-02"], ["raw", "2026-10-03"]]) {
      fs.mkdirSync(path.join(directory, id, "sheets"), { recursive: true });
      fs.writeFileSync(path.join(directory, id, "sheets/sheet-000.png"), "sheet");
      fs.writeFileSync(path.join(directory, id, "animation.json"), JSON.stringify({ schema: "drawpaint.animation.v1", fps: 12, frameCount: 1, transparentFrames: id === "raw" ? 0 : 1,
        backgroundRemoval: { removeBackground: id !== "raw" }, source: { clips: [{ id: clip.id, source, in: 0, out: 2 }] },
        sheets: [{ file: "sheets/sheet-000.png", width: 128, height: 128 }], frames: [{ sheet: 0, x: 0, y: 0, w: 128, h: 128 }] }));
      records[id] = { id, canvasId: project.id, status: "completed", kind: "sequence", scope: "clip", createdAt: date };
    }
    assert.equal(attachedVideoSequences(records, directory, project)[0].id, "newer");
    assert.equal(attachedVideoSequences(records, directory, { ...project, clips: [{ ...clip, source: { type: "job", id: "replacement" } }] }).length, 0);
    assert.equal(attachedVideoSequences(records, directory, { ...project, id: "other-canvas", clips: [{ ...clip, id: "imported-clip" }] })[0].clipId, "imported-clip");
    assert.equal(attachedVideoSequences(records, directory, { ...project, clips: [clip, { ...clip, id: "copy" }] }).length, 2);
    assert.equal(attachedVideoSequences(records, directory, { ...project, id: "other-canvas", clips: [{ ...clip, id: "imported-clip", out: 3 }] }).length, 0);
    assert.equal(attachedVideoSequences(records, directory, { ...project, id: "other-canvas", clips: [] }).length, 0);
    records.newer.status = "running";
    assert.equal(attachedVideoSequences(records, directory, project)[0].id, "older");
    fs.unlinkSync(path.join(directory, "older", "sheets/sheet-000.png"));
    assert.equal(attachedVideoSequences(records, directory, project).length, 0);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
