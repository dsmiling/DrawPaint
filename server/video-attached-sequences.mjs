import fs from "node:fs";
import path from "node:path";

// Derive attachments from durable exports so closing a dialog or reloading a
// canvas cannot lose the generated frames or race with the canvas autosaver.
export function attachedVideoSequences(records, directory, project) {
  const attached = new Map();
  for (const record of Object.values(records).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))) {
    if (record.kind !== "sequence" || record.status !== "completed" || record.scope !== "clip") continue;
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(directory, record.id, "animation.json"), "utf8")); } catch { continue; }
    if (manifest.schema !== "drawpaint.animation.v1" || !manifest.backgroundRemoval?.removeBackground || !manifest.transparentFrames) continue;
    const exported = manifest.source?.clips?.[0];
    const source = exported?.source || record.clipSource;
    if (!Number.isFinite(manifest.fps) || manifest.fps <= 0 || !Array.isArray(manifest.frames) || manifest.frames.length !== manifest.frameCount || !manifest.frames.length || !Array.isArray(manifest.sheets)) continue;
    if (!manifest.sheets.every(sheet => /^sheets\/sheet-\d{3}\.(png|webp)$/.test(sheet.file) && fs.existsSync(path.join(directory, record.id, sheet.file)))) continue;
    if (!manifest.frames.every(frame => {
      const sheet = manifest.sheets[frame.sheet];
      return sheet && [frame.x, frame.y, frame.w, frame.h].every(Number.isInteger) && frame.x >= 0 && frame.y >= 0 && frame.w > 0 && frame.h > 0 && frame.x + frame.w <= sheet.width && frame.y + frame.h <= sheet.height;
    })) continue;
    for (const clip of project.clips) {
      if (attached.has(clip.id) || clip.status !== "completed") continue;
      const sameSource = source && source.type === clip.source?.type && source.id === clip.source?.id;
      const ownsClip = record.canvasId === project.id && (clip.id === (record.clipId || exported?.id) || !exported && manifest.source?.jobId && clip.source?.type === "job" && clip.source.id === manifest.source.jobId);
      // Adding an existing generated video to another canvas also brings its
      // frames, provided the export covers the imported clip's source range.
      const reusable = sameSource && Number.isFinite(exported?.in) && Number.isFinite(exported?.out) && exported.in <= clip.in + .001 && exported.out >= clip.out - .001;
      if (!(ownsClip || reusable) || source && !sameSource) continue;
      attached.set(clip.id, { id: record.id, clipId: clip.id, name: manifest.name, filename: record.filename, manifest,
        range: { in: exported?.in ?? clip.in, out: exported?.out ?? clip.out, playbackRate: exported?.playbackRate || 1 },
        url: `/api/video/exports/${record.id}/file`, previewUrl: `/api/video/exports/${record.id}/preview.html`, baseUrl: `/api/video/exports/${record.id}/` });
    }
  }
  return [...attached.values()];
}
