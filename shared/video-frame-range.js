// The chosen tail is inclusive: keep its whole frame in preview and export.
export function videoFrameRange(clip) {
  const step = 1 / (clip.fps || 24);
  const latest = Math.max(clip.in, clip.out - step);
  const start = Math.max(clip.in, Math.min(clip.startFrame ?? clip.in, latest));
  const last = Math.max(clip.in, Math.min(clip.endFrame ?? latest, latest));
  return { start, last, end: Math.min(clip.out, last + step), step, valid: last >= start };
}
