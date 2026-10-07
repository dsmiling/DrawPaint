export const MAX_VIDEO_CLIPS = 100;
export const VIDEO_TRACKS = 8;
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const roundFrame = (time, fps = 24) => Math.round(time * fps) / fps;
export const clipRate = clip => clip.playbackRate ?? 1;
export const durationOf = clip => Math.max(0, clip.out - clip.in) / clipRate(clip);
export const endOf = clip => clip.position + durationOf(clip);
export const sourceTime = (clip, time) => clip.in + (time - clip.position) * clipRate(clip);
export const nodePosition = (clip, index = 0) => ({ x: clip.nodeX ?? 32 + index % 3 * 260, y: clip.nodeY ?? 28 + Math.floor(index / 3) * 244 });
export const nodeSize = clip => ({ width: clip.nodeWidth ?? 228, height: clip.nodeHeight ?? 218 });
export const exportable = clip => clip.status === "completed" && Boolean(clip.source) && !clip.hidden;

export function newDraft(id, clips, point, purpose = { enabled: false, background: "auto" }) {
  if (clips.length >= MAX_VIDEO_CLIPS) throw new Error("每个画布最多 100 个片段");
  const position = nodePosition({}, clips.length);
  return { id, source: null, status: "draft", name: `视频片段 ${clips.length + 1}`, position: Math.max(0, ...clips.map(endOf)), track: 0,
    in: 0, out: 2, mediaDuration: 2, fps: 24, startFrame: null, endFrame: null, prompt: "", frameAnimation: purpose,
    nodeX: Math.round(point?.x ?? position.x), nodeY: Math.round(point?.y ?? position.y), modelId: "minimax-h3" };
}

export function patchClip(clip, patch) {
  if (clip.locked && Object.keys(patch).some(key => key !== "locked" && key !== "hidden" && key !== "muted")) return clip;
  const next = { ...clip, ...patch }, fps = next.fps || 24, step = 1 / fps;
  if ("position" in patch) next.position = clamp(Number(next.position) || 0, 0, 3600);
  if ("track" in patch) next.track = clamp(Math.round(Number(next.track) || 0), 0, VIDEO_TRACKS - 1);
  for (const key of ["nodeX", "nodeY"]) if (key in patch) next[key] = clamp(Math.round(Number(next[key]) || 0), -10000, 10000);
  for (const key of ["nodeWidth", "nodeHeight"]) if (key in patch) next[key] = clamp(Math.round(Number(next[key]) || 180), 180, 600);
  if ("playbackRate" in patch) next.playbackRate = clamp(Number(next.playbackRate) || 1, .25, 4);
  if ("volume" in patch) next.volume = clamp(Number(next.volume) || 0, 0, 1);
  const timingChanged = ["in", "out", "mediaDuration", "fps"].some(key => key in patch);
  if (timingChanged) {
    const mediaDuration = next.mediaDuration || next.out;
    next.in = clamp(roundFrame(Number(next.in) || 0, fps), 0, Math.max(0, mediaDuration - step));
    next.out = clamp(roundFrame(Number(next.out) || step, fps), Math.min(mediaDuration, next.in + step), mediaDuration);
  }
  const last = Math.max(next.in, next.out - step);
  for (const key of ["startFrame", "endFrame"]) if (next[key] != null && (timingChanged || key in patch)) next[key] = clamp(roundFrame(Number(next[key]), fps), next.in, last);
  return next;
}

export function splitAt(clip, playhead, id) {
  if (clip.locked || !clip.source || clip.status !== "completed") throw new Error("请选择可编辑的已完成片段");
  const cut = roundFrame(sourceTime(clip, playhead), clip.fps || 24), step = 1 / (clip.fps || 24);
  if (cut < clip.in + step || cut > clip.out - step) throw new Error("播放头须位于片段内部，前后至少保留一帧");
  const { x, y } = nodePosition(clip);
  const left = { ...clip, out: cut, startFrame: clip.startFrame != null && clip.startFrame < cut ? clip.startFrame : null, endFrame: clip.endFrame != null && clip.endFrame < cut ? clip.endFrame : null };
  const right = { ...clip, id, name: `${clip.name} · 后段`, in: cut, position: clip.position + (cut - clip.in) / clipRate(clip), nodeX: x + 36, nodeY: y + 36,
    startFrame: clip.startFrame != null && clip.startFrame >= cut ? clip.startFrame : null, endFrame: clip.endFrame != null && clip.endFrame >= cut ? clip.endFrame : null };
  return [left, right];
}

export function arrangeNodes(clips, ids) {
  const chosen = new Set(ids), editable = clips.filter(clip => chosen.has(clip.id) && !clip.locked);
  const points = editable.map((clip, index) => nodePosition(clip, clips.indexOf(clip)));
  const origin = { x: Math.min(...points.map(p => p.x), 32), y: Math.min(...points.map(p => p.y), 28) };
  const columns = Math.max(1, Math.ceil(Math.sqrt(editable.length)));
  const width = Math.max(228, ...editable.map(clip => nodeSize(clip).width)) + 32;
  const height = Math.max(218, ...editable.map(clip => nodeSize(clip).height)) + 32;
  return clips.map(clip => {
    const index = editable.indexOf(clip);
    return index < 0 ? clip : { ...clip, nodeX: origin.x + index % columns * width, nodeY: origin.y + Math.floor(index / columns) * height };
  });
}

export function editHistory(state, action) {
  if (action.type === "reset") return { present: action.document, past: [], future: [], group: null };
  if (action.type === "stop") return { ...state, group: null };
  if (action.type === "undo") {
    if (!state.past.length) return state;
    return { present: state.past.at(-1), past: state.past.slice(0, -1), future: [state.present, ...state.future], group: null };
  }
  if (action.type === "redo") {
    if (!state.future.length) return state;
    return { present: state.future[0], past: [...state.past, state.present].slice(-80), future: state.future.slice(1), group: null };
  }
  const next = action.update(state.present);
  if (JSON.stringify(next) === JSON.stringify(state.present)) return state;
  if (action.type === "system") return { ...state, present: next, past: state.past.map(action.update), future: state.future.map(action.update) };
  return { present: next, past: action.group && action.group === state.group ? state.past : [...state.past, state.present].slice(-80), future: [], group: action.group || null };
}
