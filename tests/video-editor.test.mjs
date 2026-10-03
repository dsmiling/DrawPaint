import test from "node:test";
import assert from "node:assert/strict";
import { buildClipExportArgs, buildExportArgs, normalizeProject } from "../server/video-editor.mjs";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const source = { type: "job", id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const clip = { id, source, name: "镜头", position: 1.5, track: 0, in: 0.25, out: 2.25, mediaDuration: 3, fps: 24, status: "completed" };

test("video project preserves frame choices and rejects invalid timeline geometry", () => {
  const project = normalizeProject({ clips: [{ ...clip, startFrame: 0.5, endFrame: 2, nodeX: 318, nodeY: 76 }] });
  assert.equal(project.clips[0].startFrame, 0.5);
  assert.equal(project.clips[0].endFrame, 2);
  assert.equal(project.clips[0].fps, 24);
  assert.equal(project.clips[0].nodeX, 318);
  assert.equal(project.clips[0].nodeY, 76);
  const moved = normalizeProject({ clips: [{ ...clip, nodeX: -420, nodeY: -135 }] });
  assert.equal(moved.clips[0].nodeX, -420);
  assert.equal(moved.clips[0].nodeY, -135);
  assert.equal(project.width, 640);
  assert.throws(() => normalizeProject({ clips: [{ ...clip, out: 0.1 }] }), /时间或轨道/);
  assert.throws(() => normalizeProject({ clips: [clip, clip] }), /重复/);
  assert.throws(() => normalizeProject({ clips: [clip], width: 641, height: 640 }), /尺寸/);
});

test("export places trimmed clips on timeline and retains audio when present", () => {
  const clips = [clip, { ...clip, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", position: 3.5, track: 1 }];
  const args = buildExportArgs(clips, ["one.mp4", "two.mp4"], "out.mp4", [0, 1]);
  const filter = args[args.indexOf("-filter_complex") + 1];
  assert.match(filter, /setpts=PTS-STARTPTS\+1\.500\/TB/);
  assert.match(filter, /setpts=PTS-STARTPTS\+3\.500\/TB/);
  assert.match(filter, /adelay=1500:all=1/);
  assert.match(filter, /amix=inputs=2/);
  assert.equal(args[args.lastIndexOf("-t") + 1], "5.500");
  assert.equal(args.at(-1), "out.mp4");
});

test("clip export uses the selected trim without timeline offset and keeps optional audio", () => {
  const args = buildClipExportArgs(clip, "source.mp4", "clip.mp4");
  assert.equal(args[args.indexOf("-ss") + 1], "0.250");
  assert.equal(args[args.indexOf("-t") + 1], "2.000");
  assert.deepEqual(args.slice(args.indexOf("-map"), args.indexOf("-vf")), ["-map", "0:v:0", "-map", "0:a?"]);
  assert.equal(args.at(-1), "clip.mp4");
  assert.throws(() => buildClipExportArgs({ ...clip, out: clip.in }, "source.mp4", "clip.mp4"), /裁剪范围/);
});
