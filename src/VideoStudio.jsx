import { useEffect, useRef, useState } from "react";
import { blobToDataUrl, fileToDataUrl } from "./api.js";
import VideoInspector from "./VideoInspector.jsx";
import VideoModelSetup from "./VideoModelSetup.jsx";
import "./video.css";
import "./video-theme.css";

const FPS = 24, TRACKS = 4;
const TRACK_HEIGHT = 36, CLIP_INSET = 4, TIMELINE_HEIGHT = 216, TIMELINE_MIN_HEIGHT = 120;
const roundFrame = (time, fps = FPS) => Math.round(time * fps) / fps;
const durationOf = clip => Math.max(0, clip.out - clip.in);
const endOf = clip => clip.position + durationOf(clip);
const timeLabel = time => `${Math.floor(time / 60).toString().padStart(2, "0")}:${Math.floor(time % 60).toString().padStart(2, "0")}.${Math.floor((time % 1) * 100).toString().padStart(2, "0")}`;
const sourceUrl = source => source.type === "job" ? `/api/video/jobs/${source.id}/file` : `/api/video/assets/${source.id}.${source.ext || "mp4"}`;
const frameUrl = (source, time) => `/api/video/frame?type=${source.type}&id=${source.id}&time=${(Math.floor(time * 1000) / 1000).toFixed(3)}`;
const nodePosition = (clip, index) => ({ x: clip.nodeX ?? 32 + (index % 3) * 260, y: clip.nodeY ?? 28 + Math.floor(index / 3) * 244 });
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function TransportIcon({ kind }) {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "start" && <><path d="M5 4v16" /><path d="M19 5 8 12l11 7V5Z" fill="currentColor" stroke="none" /></>}
    {kind === "play" && <path d="m7 4 12 8-12 8V4Z" fill="currentColor" stroke="none" />}
    {kind === "pause" && <><path d="M7 5v14" strokeWidth="3" /><path d="M17 5v14" strokeWidth="3" /></>}
    {kind === "frame" && <><path d="m5 5 11 7-11 7V5Z" fill="currentColor" stroke="none" /><path d="M19 4v16" /></>}
  </svg>;
}

async function request(url, options) {
  const response = await fetch(url, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

async function imageData(value) {
  if (!value) return null;
  if (value instanceof File) return fileToDataUrl(value);
  if (value.startsWith("data:")) return value;
  const response = await fetch(value);
  if (!response.ok) throw new Error("无法读取参考帧");
  return blobToDataUrl(await response.blob());
}

function visibleClip(clips, time) {
  return clips.map((clip, index) => ({ clip, index }))
    .filter(({ clip }) => clip.status === "completed" && time >= clip.position && time < endOf(clip))
    .sort((a, b) => a.clip.track - b.clip.track || b.index - a.index)[0]?.clip || null;
}

export default function VideoStudio({ canvasImage }) {
  const [clips, setClips] = useState([]), [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState(null), [playhead, setPlayhead] = useState(0), [playing, setPlaying] = useState(false);
  const [frameTime, setFrameTime] = useState(0), [zoom, setZoom] = useState(50);
  const [outputSize, setOutputSize] = useState("640x640");
  const [setup, setSetup] = useState(null), [startingModel, setStartingModel] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [selectedModel, setSelectedModel] = useState(() => { try { return localStorage.getItem("drawpaint.video-studio.model") || "minimax-h3"; } catch { return "minimax-h3"; } });
  const [busy, setBusy] = useState(false), [exportJob, setExportJob] = useState(null), [recent, setRecent] = useState([]);
  const [firstImage, setFirstImage] = useState(null), [lastImage, setLastImage] = useState(null);
  const [prompt, setPrompt] = useState(""), [seconds, setSeconds] = useState(2), [newName, setNewName] = useState("");
  const [panel, setPanel] = useState("inspect");
  const [graphPan, setGraphPan] = useState({ x: 0, y: 0 });
  const [layoutPrefs, setLayoutPrefs] = useState(() => {
    try { const saved = JSON.parse(localStorage.getItem("drawpaint.video-studio.layout") || "{}"); return { leftWidth: clamp(Number(saved.leftWidth) || 230, 160, 420), timelineHeight: saved.compactTimeline ? clamp(Number(saved.timelineHeight) || TIMELINE_HEIGHT, TIMELINE_MIN_HEIGHT, 700) : TIMELINE_HEIGHT, compactTimeline: true, graphZoom: clamp(Number(saved.graphZoom) || 100, 40, 200), rightCollapsed: saved.rightCollapsed === true }; }
    catch { return { leftWidth: 230, timelineHeight: TIMELINE_HEIGHT, compactTimeline: true, graphZoom: 100, rightCollapsed: false }; }
  });
  const { leftWidth, timelineHeight, graphZoom, rightCollapsed } = layoutPrefs;
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem("drawpaint.video-studio.theme") || localStorage.getItem("drawpaint.ui-studio.theme");
      return saved === "light" ? "light" : "dark";
    } catch { return "dark"; }
  });
  const [contextMenu, setContextMenu] = useState(null);
  const previewRef = useRef(null), laneRef = useRef(null), dragRef = useRef(null), uploadRef = useRef(null), menuRef = useRef(null);
  const graphScrollRef = useRef(null), timelineScrollRef = useRef(null), nodeDragRef = useRef(null), panRef = useRef(null);
  const layoutRef = useRef(null), centerRef = useRef(null), resizeRef = useRef(null);
  const savedSnapshotRef = useRef(null), revisionRef = useRef(null), saveQueueRef = useRef(Promise.resolve());
  const selected = clips.find(clip => clip.id === selectedId) || null;
  const menuClip = clips.find(clip => clip.id === contextMenu?.id) || null;
  const active = visibleClip(clips, playhead);
  const videoModel = setup?.models.find(item => item.id === selectedModel);
  const modelReady = Boolean(videoModel?.ready);
  const total = clips.length ? Math.max(...clips.map(endOf)) : 5;
  const timelineWidth = Math.max(940, (total + 3) * zoom);
  const activeUrl = active ? sourceUrl(active.source) : "";
  const graphWidth = Math.max(1100, ...clips.map((clip, index) => nodePosition(clip, index).x + 260));
  const graphHeight = Math.max(390, ...clips.map((clip, index) => nodePosition(clip, index).y + 255));

  useEffect(() => {
    try { localStorage.setItem("drawpaint.video-studio.theme", theme); } catch { /* Keep the theme usable without storage. */ }
  }, [theme]);
  useEffect(() => {
    try { localStorage.setItem("drawpaint.video-studio.layout", JSON.stringify(layoutPrefs)); } catch { /* Resizing still works without storage. */ }
  }, [layoutPrefs]);
  useEffect(() => { try { localStorage.setItem("drawpaint.video-studio.model", selectedModel); } catch { /* Selection still works. */ } }, [selectedModel]);

  async function refreshSetup() {
    const next = await request("/api/video/setup");
    setSetup(next);
    return next;
  }
  async function startLocalModel() {
    setStartingModel(true); setError("");
    try { setSetup(await request("/api/video/start", { method: "POST" })); }
    catch (e) { setError(e.message); }
    finally { setStartingModel(false); }
  }
  function chooseVideoModel(id) {
    setSelectedModel(id); setLastImage(null);
    const choice = setup?.models.find(item => item.id === id);
    if (choice && !choice.durations.includes(seconds)) setSeconds(choice.durations[0]);
  }
  useEffect(() => {
    const timer = setInterval(() => refreshSetup().catch(() => {}), 12000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    Promise.all([request("/api/video/project"), request("/api/video/setup"), request("/api/video/jobs")])
      .then(([project, service, history]) => {
        const savedClips = project.clips || [];
        const width = project.width || 640, height = project.height || 640;
        savedSnapshotRef.current = JSON.stringify({ clips: savedClips, width, height });
        revisionRef.current = project.revision ?? project.updatedAt ?? null;
        setClips(savedClips);
        setOutputSize(`${width}x${height}`);
        if (savedClips.length) { setSelectedId(savedClips[0].id); setFrameTime(savedClips[0].startFrame ?? savedClips[0].in); setPrompt(savedClips[0].prompt || ""); }
        setSetup(service); setRecent(history.jobs || []); setLoaded(true);
      })
      .catch(e => { setError(e.message); setLoaded(true); });
  }, []);

  useEffect(() => { if (canvasImage) { setFirstImage(canvasImage.src); setSelectedId(null); setPanel("create"); setLayoutPrefs(current => ({ ...current, rightCollapsed: false })); } }, [canvasImage]);
  useEffect(() => {
    if (!loaded || savedSnapshotRef.current === null) return;
    const [width, height] = outputSize.split("x").map(Number);
    const snapshot = JSON.stringify({ clips, width, height });
    if (snapshot === savedSnapshotRef.current) return;
    const timer = setTimeout(() => {
      const task = saveQueueRef.current.catch(() => {}).then(() => snapshot === savedSnapshotRef.current ? null : persistProject(snapshot));
      saveQueueRef.current = task;
      task.catch(e => setError(`项目保存失败：${e.message}`));
    }, 400);
    return () => clearTimeout(timer);
  }, [clips, loaded, outputSize]);
  useEffect(() => {
    const pending = clips.filter(clip => clip.status === "running");
    if (!pending.length) return;
    const timer = setInterval(async () => {
      const results = await Promise.all(pending.map(async clip => {
        try { return { clipId: clip.id, ...(await request(`/api/video/jobs/${clip.source.id}`)) }; }
        catch (e) { return { clipId: clip.id, status: "failed", error: e.message }; }
      }));
      setClips(current => current.map(clip => { const result = results.find(item => item.clipId === clip.id); return result && result.status !== "running" ? { ...clip, status: result.status } : clip; }));
      if (results.some(item => item.status === "completed")) setMessage("新视频已生成，可在时间线上播放和剪辑。");
    }, 5000);
    return () => clearInterval(timer);
  }, [clips]);
  useEffect(() => {
    if (!exportJob?.id || exportJob.status !== "running") return;
    const timer = setInterval(() => request(`/api/video/exports/${exportJob.id}`).then(setExportJob).catch(e => setError(e.message)), 1500);
    return () => clearInterval(timer);
  }, [exportJob?.id, exportJob?.status]);
  useEffect(() => {
    if (!playing) { previewRef.current?.pause(); return; }
    const origin = performance.now() - playhead * 1000;
    let frame;
    const tick = now => { const next = (now - origin) / 1000; if (next >= total) { setPlayhead(total); setPlaying(false); return; } setPlayhead(next); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, total]);
  useEffect(() => {
    const video = previewRef.current;
    if (!video || !active) return;
    const target = active.in + playhead - active.position;
    if (video.readyState >= 1 && Math.abs(video.currentTime - target) > (playing ? 0.25 : 0.025)) video.currentTime = Math.max(0, target);
    if (playing && video.paused) video.play().catch(() => {});
    if (!playing && !video.paused) video.pause();
  }, [active?.id, playhead, playing]);
  useEffect(() => {
    if (playing && selected && active?.id === selected.id) setFrameTime(Math.min(selected.out - 1 / (selected.fps || FPS), selected.in + playhead - selected.position));
  }, [playhead, playing, selectedId, active?.id]);
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = event => { if (!menuRef.current?.contains(event.target)) setContextMenu(null); };
    const escape = event => { if (event.key === "Escape") setContextMenu(null); };
    const close = () => setContextMenu(null);
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);
  useEffect(() => {
    if (contextMenu) menuRef.current?.querySelector(contextMenu.renaming ? "input" : "button")?.focus();
  }, [contextMenu?.id, contextMenu?.renaming]);
  useEffect(() => {
    const move = event => nodePointerMove(event);
    const pan = event => { const drag = panRef.current; if (drag) setGraphPan({ x: drag.panX + event.clientX - drag.x, y: drag.panY + event.clientY - drag.y }); };
    const stop = () => { nodeDragRef.current = null; panRef.current = null; };
    window.addEventListener("mousemove", move);
    window.addEventListener("mousemove", pan);
    window.addEventListener("mouseup", stop);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mousemove", pan); window.removeEventListener("mouseup", stop); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); window.removeEventListener("pointercancel", stop); };
  }, [graphZoom]);
  useEffect(() => {
    const move = event => {
      const drag = resizeRef.current;
      if (!drag) return;
      if (drag.axis === "left") {
        const available = (layoutRef.current?.clientWidth || window.innerWidth) - (rightCollapsed ? 42 : 340) - 327;
        setLayoutPrefs(current => ({ ...current, leftWidth: clamp(drag.value + event.clientX - drag.start, 160, Math.max(160, available)) }));
      } else {
        const available = (centerRef.current?.clientHeight || window.innerHeight) - 190;
        setLayoutPrefs(current => ({ ...current, timelineHeight: clamp(drag.value + drag.start - event.clientY, TIMELINE_MIN_HEIGHT, Math.max(TIMELINE_MIN_HEIGHT, available)) }));
      }
    };
    const stop = () => { resizeRef.current = null; };
    window.addEventListener("pointermove", move);
    window.addEventListener("mousemove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("mouseup", stop);
    window.addEventListener("pointercancel", stop);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("mousemove", move); window.removeEventListener("pointerup", stop); window.removeEventListener("mouseup", stop); window.removeEventListener("pointercancel", stop); };
  }, [rightCollapsed]);

  function startResize(event, axis) {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeRef.current = { axis, start: axis === "left" ? event.clientX : event.clientY, value: axis === "left" ? leftWidth : timelineHeight };
  }

  function changeGraphZoom(value, anchor) {
    const next = clamp(Math.round(value / 5) * 5, 40, 200);
    if (next === graphZoom) return;
    const graph = graphScrollRef.current;
    if (graph) {
      const rect = graph.getBoundingClientRect();
      const x = anchor ? anchor.x - rect.left : rect.width / 2;
      const y = anchor ? anchor.y - rect.top : rect.height / 2;
      const logicalX = (x - graphPan.x) / (graphZoom / 100);
      const logicalY = (y - graphPan.y) / (graphZoom / 100);
      setGraphPan({ x: x - logicalX * next / 100, y: y - logicalY * next / 100 });
    }
    setLayoutPrefs(current => ({ ...current, graphZoom: next }));
  }

  function fitGraph() {
    const graph = graphScrollRef.current;
    if (!graph) return;
    if (!clips.length) { setGraphPan({ x: 0, y: 0 }); setLayoutPrefs(current => ({ ...current, graphZoom: 100 })); return; }
    const points = clips.map(nodePosition);
    const minX = Math.min(...points.map(point => point.x)), minY = Math.min(...points.map(point => point.y));
    const maxX = Math.max(...points.map(point => point.x + 228)), maxY = Math.max(...points.map(point => point.y + 218));
    const next = clamp(Math.floor(Math.min((graph.clientWidth - 48) / (maxX - minX), (graph.clientHeight - 48) / (maxY - minY)) * 100 / 5) * 5, 40, 200);
    const scale = next / 100;
    setGraphPan({ x: (graph.clientWidth - (maxX - minX) * scale) / 2 - minX * scale, y: (graph.clientHeight - (maxY - minY) * scale) / 2 - minY * scale });
    setLayoutPrefs(current => ({ ...current, graphZoom: next }));
  }

  function revealClip(clip, source) {
    requestAnimationFrame(() => {
      const timeline = timelineScrollRef.current;
      if (timeline) {
        const left = clip.position * zoom;
        timeline.scrollTo({ left: Math.max(0, left - timeline.clientWidth / 3), top: Math.max(0, clip.track * TRACK_HEIGHT - TRACK_HEIGHT), behavior: "smooth" });
      }
      if (source !== "graph") {
        const graph = graphScrollRef.current;
        const index = clips.findIndex(item => item.id === clip.id);
        const point = nodePosition(clip, index);
        if (graph) setGraphPan({ x: graph.clientWidth / 3 - point.x * graphZoom / 100, y: 35 - point.y * graphZoom / 100 });
      }
    });
  }
  function selectClip(clip, source) { setSelectedId(clip.id); setFrameTime(clip.startFrame ?? clip.in); setPlayhead(clip.position); setPanel("inspect"); setPrompt(clip.prompt || ""); revealClip(clip, source); }
  function nodePointerDown(event, clip, index) {
    if (event.button !== 0) return;
    event.stopPropagation(); selectClip(clip, "graph");
    const point = nodePosition(clip, index);
    nodeDragRef.current = { id: clip.id, x: event.clientX, y: event.clientY, nodeX: point.x, nodeY: point.y };
    if (event.pointerId != null) event.currentTarget.setPointerCapture(event.pointerId);
  }
  function nodePointerMove(event) {
    const drag = nodeDragRef.current;
    if (!drag) return;
    updateClip(drag.id, { nodeX: clamp(Math.round(drag.nodeX + (event.clientX - drag.x) / (graphZoom / 100)), -10000, 10000), nodeY: clamp(Math.round(drag.nodeY + (event.clientY - drag.y) / (graphZoom / 100)), -10000, 10000) });
  }
  function panPointerDown(event) {
    if (event.button !== 0 && event.button !== 1) return;
    if (event.target.closest(".vs-node")) return;
    panRef.current = { x: event.clientX, y: event.clientY, panX: graphPan.x, panY: graphPan.y };
    if (event.pointerId != null) event.currentTarget.setPointerCapture(event.pointerId);
  }
  function updateClip(id, patch) { setClips(current => current.map(clip => clip.id === id ? { ...clip, ...patch } : clip)); }
  async function persistProject(snapshot) {
    const project = await request("/api/video/project", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...JSON.parse(snapshot), baseRevision: revisionRef.current }) });
    revisionRef.current = project.revision ?? project.updatedAt ?? null;
    savedSnapshotRef.current = snapshot;
    return project;
  }
  function openClipMenu(event, clip) {
    event.preventDefault(); event.stopPropagation();
    dragRef.current = null;
    setPlaying(false); setSelectedId(clip.id); setFrameTime(clip.startFrame ?? clip.in); setPanel("inspect"); setPrompt(clip.prompt || "");
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX || rect.left, y = event.clientY || rect.bottom;
    setContextMenu({ id: clip.id, x: Math.max(8, Math.min(x, window.innerWidth - 208)), y: Math.max(8, Math.min(y, window.innerHeight - 250)), name: clip.name, renaming: false });
  }
  function duplicateClip(clip) {
    const point = nodePosition(clip, clips.indexOf(clip));
    const clone = { ...clip, id: crypto.randomUUID(), name: `${clip.name} 副本`, position: endOf(clip), nodeX: point.x + 36, nodeY: point.y + 36 };
    setClips(current => [...current, clone]); selectClip(clone); setContextMenu(null);
  }
  function removeClip(clip) {
    setPlaying(false); setClips(current => current.filter(item => item.id !== clip.id));
    if (selectedId === clip.id) setSelectedId(null);
    setContextMenu(null);
  }
  function splitClip(clip) {
    const fps = clip.fps || FPS, offset = roundFrame(playhead - clip.position, fps), cut = roundFrame(clip.in + offset, fps);
    if (cut <= clip.in + 1 / fps || cut >= clip.out - 1 / fps) return;
    const point = nodePosition(clip, clips.indexOf(clip));
    const second = { ...clip, id: crypto.randomUUID(), name: `${clip.name} · 后段`, position: roundFrame(clip.position + cut - clip.in, fps), in: cut, nodeX: point.x + 36, nodeY: point.y + 36,
      startFrame: clip.startFrame != null && clip.startFrame >= cut ? clip.startFrame : null,
      endFrame: clip.endFrame != null && clip.endFrame >= cut ? clip.endFrame : null };
    setClips(current => [...current.map(item => item.id === clip.id ? { ...item, out: cut,
      startFrame: item.startFrame != null && item.startFrame < cut ? item.startFrame : null,
      endFrame: item.endFrame != null && item.endFrame < cut ? item.endFrame : null } : item), second]);
    selectClip(second); setContextMenu(null);
  }
  function renameClip(event) {
    event.preventDefault();
    const name = contextMenu?.name.trim();
    if (name && menuClip) updateClip(menuClip.id, { name });
    setContextMenu(null);
  }

  async function createClip(first, last, description, length, position, track, name) {
    setBusy(true); setError(""); setMessage("");
    try {
      if (!modelReady) throw new Error("当前视频模型未就绪，请在“模型设置”中启动并检查");
      if (last && !videoModel.supportsEndFrame) throw new Error(`${videoModel.name} 暂不支持尾帧约束，请切换 MiniMax H3`);
      const [image, lastFrame] = await Promise.all([imageData(first), imageData(last)]);
      if (!image) throw new Error("请先选择起始图片或视频帧");
      const result = await request("/api/video/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image, lastImage: lastFrame, prompt: description, seconds: length, modelId: selectedModel }) });
      const clip = { id: crypto.randomUUID(), source: { type: "job", id: result.id }, name: name || "生成片段", position: roundFrame(position), track, in: 0, out: length, mediaDuration: length, fps: videoModel.fps, modelId: selectedModel, startFrame: null, endFrame: null, prompt: description, status: "running" };
      setClips(current => [...current, clip]); setSelectedId(clip.id); setPanel("inspect");
      setMessage("已提交视频生成任务，完成后会出现在时间线上。"); return clip;
    } catch (e) { setError(e.message); return null; }
    finally { setBusy(false); }
  }
  async function generateNew(event) {
    event.preventDefault();
    const created = await createClip(firstImage, lastImage, prompt.trim(), seconds, Math.max(0, ...clips.map(endOf)), 0, newName.trim() || `片段 ${clips.length + 1}`);
    if (created) { setFirstImage(null); setLastImage(null); setPrompt(""); setNewName(""); }
  }
  async function regenerate() {
    if (!selected || selected.status !== "completed") return;
    const start = selected.startFrame ?? selected.in, end = selected.endFrame ?? Math.max(selected.in, selected.out - 1 / (selected.fps || FPS));
    if (end <= start) { setError("尾帧必须晚于首帧"); return; }
    const created = await createClip(frameUrl(selected.source, start), frameUrl(selected.source, end), prompt.trim() || selected.prompt, seconds, selected.position, selected.track, `${selected.name} · 新版本`);
    if (created) setMessage("新版本正在生成；原片段保留在同一轨道下方，可继续比较或移走。");
  }
  async function importVideo(file) {
    if (!file) return;
    setBusy(true); setError("");
    try {
      const video = await fileToDataUrl(file);
      const imported = await request("/api/video/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ video }) });
      const clip = { id: crypto.randomUUID(), source: { type: "asset", id: imported.id, ext: imported.url.split(".").pop() }, name: file.name.replace(/\.[^.]+$/, ""), position: Math.max(0, ...clips.map(endOf)), track: 0, in: 0, out: imported.duration, mediaDuration: imported.duration, fps: imported.fps || FPS, startFrame: null, endFrame: null, prompt: "", status: "completed" };
      setClips(current => [...current, clip]); selectClip(clip); setMessage("视频已导入片段树，可拖到任意轨道位置。");
    } catch (e) { setError(e.message); }
    finally { setBusy(false); if (uploadRef.current) uploadRef.current.value = ""; }
  }
  function addRecent(job) {
    if (clips.some(clip => clip.source.type === "job" && clip.source.id === job.id)) return;
    const clip = { id: crypto.randomUUID(), source: { type: "job", id: job.id }, name: "历史生成片段", position: Math.max(0, ...clips.map(endOf)), track: 0, in: 0, out: 2, mediaDuration: 2, fps: FPS, startFrame: null, endFrame: null, prompt: "", status: job.status };
    setClips(current => [...current, clip]); selectClip(clip);
  }
  function pointerDown(event, clip, kind) {
    if (event.button === 2) { openClipMenu(event, clip); return; }
    if (event.button !== 0) return;
    event.stopPropagation(); selectClip(clip);
    dragRef.current = { id: clip.id, kind, x: event.clientX, position: clip.position, track: clip.track, in: clip.in, out: clip.out, mediaDuration: clip.mediaDuration || clip.out, fps: clip.fps || FPS };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function pointerMove(event) {
    const drag = dragRef.current;
    if (!drag) return;
    const delta = roundFrame((event.clientX - drag.x) / zoom, drag.fps);
    if (drag.kind === "left") {
      const next = Math.max(0, Math.min(drag.out - 1 / drag.fps, roundFrame(drag.in + delta, drag.fps)));
      updateClip(drag.id, { in: next, position: Math.max(0, roundFrame(drag.position + next - drag.in, drag.fps)) });
    } else if (drag.kind === "right") updateClip(drag.id, { out: Math.max(drag.in + 1 / drag.fps, Math.min(drag.mediaDuration, roundFrame(drag.out + delta, drag.fps))) });
    else {
      const rect = laneRef.current?.getBoundingClientRect();
      const track = rect ? Math.max(0, Math.min(TRACKS - 1, Math.floor((event.clientY - rect.top) / TRACK_HEIGHT))) : drag.track;
      updateClip(drag.id, { position: Math.max(0, roundFrame(drag.position + delta, drag.fps)), track });
    }
  }
  async function exportVideo() {
    setError(""); setMessage(""); setExportJob(null);
    try {
      const [width, height] = outputSize.split("x").map(Number);
      await saveQueueRef.current;
      const snapshot = JSON.stringify({ clips, width, height });
      if (snapshot !== savedSnapshotRef.current) await persistProject(snapshot);
      setExportJob(await request("/api/video/exports", { method: "POST" }));
    } catch (e) { setError(e.message); }
  }
  async function exportClip(clip) {
    setContextMenu(null); setError(""); setMessage(""); setExportJob(null);
    try {
      const [width, height] = outputSize.split("x").map(Number);
      await saveQueueRef.current;
      const snapshot = JSON.stringify({ clips, width, height });
      if (snapshot !== savedSnapshotRef.current) await persistProject(snapshot);
      setExportJob(await request("/api/video/exports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clipId: clip.id }) }));
    } catch (e) { setError(e.message); }
  }
  async function saveExportAs(job) {
    if (!job?.url || !window.showSaveFilePicker) return;
    let fileHandle;
    try {
      fileHandle = await window.showSaveFilePicker({
        suggestedName: job.filename || "DrawPaint-edit.mp4",
        types: [{ description: "MP4 视频", accept: { "video/mp4": [".mp4"] } }],
      });
    } catch (e) {
      if (e.name !== "AbortError") setError(`无法选择保存位置：${e.message}`);
      return;
    }
    setError(""); setMessage("正在保存到所选位置…");
    let writable;
    try {
      const response = await fetch(job.url);
      if (!response.ok || !response.body) throw new Error(`下载导出文件失败（HTTP ${response.status}）`);
      writable = await fileHandle.createWritable();
      await response.body.pipeTo(writable);
      setMessage("已保存到所选位置");
    } catch (e) {
      if (writable) await writable.abort().catch(() => {});
      setMessage(""); setError(`保存失败：${e.message}`);
    }
  }

  const frameStep = 1 / (selected?.fps || FPS);
  return <div className="vs-shell" data-theme={theme}>
    <header className="vs-header"><div className="vs-title"><span className="vs-logo">▶</span><div><strong>视频工坊</strong></div></div><div className="vs-header-actions"><button type="button" className="vs-theme-toggle" aria-label={theme === "dark" ? "切换浅色主题" : "切换深色主题"} title={theme === "dark" ? "切换浅色主题" : "切换深色主题"} onClick={() => setTheme(current => current === "dark" ? "light" : "dark")}>{theme === "dark" ? "☀" : "☾"}</button><button type="button" className={`vs-model-status ${modelReady ? "vs-online" : "vs-offline"}`} onClick={() => { setPanel("models"); setLayoutPrefs(current => ({ ...current, rightCollapsed: false })); }}>{videoModel?.name || "视频模型"} · {modelReady ? "可生成" : setup?.starting ? "启动中" : "需设置"}</button><label className="vs-size-label">画幅 <select value={outputSize} onChange={e => setOutputSize(e.target.value)}><option value="640x640">1:1 · 640</option><option value="960x540">16:9 · 540p</option><option value="540x960">9:16 · 540p</option><option value="1280x720">16:9 · 720p</option><option value="720x1280">9:16 · 720p</option></select></label><button onClick={() => { setSelectedId(null); setPanel("create"); setLayoutPrefs(current => ({ ...current, rightCollapsed: false })); }}>＋ 生成</button><button onClick={() => uploadRef.current?.click()} disabled={busy}>导入</button><input ref={uploadRef} className="vs-hidden" type="file" accept="video/mp4,video/webm,video/quicktime" onChange={e => importVideo(e.target.files?.[0])} /><button className="vs-primary" onClick={exportVideo} disabled={!clips.some(clip => clip.status === "completed")}>导出视频</button></div></header>
    {(error || message || exportJob) && <div className={`vs-notice ${error ? "is-error" : ""}`} role="status">{error || message || (exportJob?.status === "running" ? exportJob.kind === "clip" ? "正在导出片段…" : "正在导出 MP4…" : "")}{exportJob?.status === "completed" && <>{typeof window.showSaveFilePicker === "function" && <button type="button" className="vs-save-as" onClick={() => saveExportAs(exportJob)}>选择保存位置…</button>}<a href={exportJob.url} download={exportJob.filename || "DrawPaint-edit.mp4"}>{exportJob.kind === "clip" ? "下载片段 MP4" : "下载 MP4"}（浏览器默认位置）</a></>}{exportJob?.status === "failed" && <span>导出失败：{exportJob.error}</span>}<button aria-label="关闭提示" onClick={() => { setError(""); setMessage(""); setExportJob(null); }}>×</button></div>}
    <div ref={layoutRef} className="vs-layout" style={{ gridTemplateColumns: `${leftWidth}px 7px minmax(320px, 1fr) ${rightCollapsed ? 42 : 340}px` }}>
      <aside className="vs-left"><div className="vs-panel-heading"><strong>片段图层</strong><span>{clips.length}</span></div><div className="vs-layer-list">{clips.length === 0 && <div className="vs-empty-small">尚无片段。可生成、导入视频，或添加历史生成结果。</div>}{[...clips].sort((a, b) => a.track - b.track || a.position - b.position).map(clip => <button key={clip.id} className={`vs-layer ${selectedId === clip.id ? "is-selected" : ""}`} onClick={() => selectClip(clip)} onContextMenu={event => openClipMenu(event, clip)}><span className="vs-layer-icon">{clip.status === "running" ? "◌" : "▶"}</span><span className="vs-layer-meta"><b>{clip.name}</b><small>轨道 {clip.track + 1} · {timeLabel(clip.position)} · {durationOf(clip).toFixed(1)} 秒</small></span></button>)}</div>{recent.some(job => job.status === "completed" && !clips.some(clip => clip.source.type === "job" && clip.source.id === job.id)) && <div className="vs-recent"><strong>历史生成</strong>{recent.filter(job => job.status === "completed" && !clips.some(clip => clip.source.type === "job" && clip.source.id === job.id)).slice(0, 8).map((job, i) => <button key={job.id} onClick={() => addRecent(job)}>＋ 添加历史片段 {i + 1}</button>)}</div>}</aside>
      <div className="vs-splitter vs-splitter-vertical" role="separator" aria-label="调整片段图层宽度" aria-orientation="vertical" aria-valuenow={leftWidth} tabIndex={0} onPointerDown={event => startResize(event, "left")} onMouseDown={event => startResize(event, "left")} onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setLayoutPrefs(current => ({ ...current, leftWidth: clamp(current.leftWidth + (event.key === "ArrowRight" ? 20 : -20), 160, 420) })); } }} />
      <main ref={centerRef} className="vs-center"><section className="vs-viewer"><div className="vs-viewer-heading"><strong>画布</strong><div className="vs-viewer-actions"><span>{timeLabel(playhead)} / {timeLabel(total)}</span><div className="vs-graph-zoom" role="group" aria-label="画布缩放"><button type="button" aria-label="缩小画布" onClick={() => changeGraphZoom(graphZoom - 10)}>−</button><output aria-label="画布缩放比例">{graphZoom}%</output><button type="button" aria-label="放大画布" onClick={() => changeGraphZoom(graphZoom + 10)}>＋</button><button type="button" className="vs-graph-fit" onClick={fitGraph}>适应</button></div></div></div>
        <div className="vs-node-scroll" ref={graphScrollRef} onPointerDown={panPointerDown} onMouseDown={panPointerDown} onWheel={event => { if (event.shiftKey) return; event.preventDefault(); changeGraphZoom(graphZoom + (event.deltaY < 0 ? 5 : -5), { x: event.clientX, y: event.clientY }); }} style={{ backgroundSize: `${24 * graphZoom / 100}px ${24 * graphZoom / 100}px`, backgroundPosition: `${graphPan.x}px ${graphPan.y}px` }}><div className="vs-node-canvas" style={{ width: graphWidth, height: graphHeight, transform: `translate(${graphPan.x}px, ${graphPan.y}px) scale(${graphZoom / 100})` }}>
          {clips.length === 0 && <div className="vs-node-empty">在左侧添加片段，节点会显示在这里</div>}
          {clips.map((clip, index) => { const point = nodePosition(clip, index); const isActive = active?.id === clip.id; return <article key={clip.id} data-node-id={clip.id} role="button" tabIndex={0} aria-label={`${clip.name}，节点预览`} className={`vs-node ${selectedId === clip.id ? "is-selected" : ""} ${isActive ? "is-active" : ""}`} style={{ left: point.x, top: point.y }} onPointerDown={event => nodePointerDown(event, clip, index)} onMouseDown={event => nodePointerDown(event, clip, index)} onClick={() => selectClip(clip, "graph")} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectClip(clip, "graph"); } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) openClipMenu(event, clip); }} onContextMenu={event => openClipMenu(event, clip)}>
            <div className="vs-node-header"><span className="vs-node-grip">⠿</span><strong title={clip.name}>{clip.name}</strong><span className="vs-node-track">V{clip.track + 1}</span></div>
            <div className="vs-node-media">{clip.status === "completed" ? <video key={sourceUrl(clip.source)} ref={isActive ? previewRef : null} src={sourceUrl(clip.source)} muted playsInline preload="metadata" autoPlay={!isActive} loop={!isActive} onLoadedMetadata={e => { const media = e.currentTarget; media.currentTime = isActive ? Math.max(0, clip.in + playhead - clip.position) : clip.in; if (isActive && playing) media.play().catch(() => {}); if (isActive && Number.isFinite(media.duration) && Math.abs((clip.mediaDuration || 0) - media.duration) > 0.1) setClips(current => current.map(item => item.id === clip.id ? { ...item, out: item.out === item.mediaDuration ? media.duration : item.out, mediaDuration: media.duration } : item)); }} /> : <span>{clip.status === "running" ? "正在生成视频…" : "生成失败"}</span>}</div>
            <div className="vs-node-footer"><span>{timeLabel(clip.position)} → {timeLabel(endOf(clip))}</span><span>{durationOf(clip).toFixed(1)}s</span></div>
          </article>; })}
        </div></div>
        <div className="vs-transport"><button type="button" aria-label="回到开头" title="回到开头" onClick={() => { setPlayhead(0); setPlaying(false); }}><TransportIcon kind="start" /></button><button type="button" className="vs-play" aria-label={playing ? "暂停" : "播放"} title={playing ? "暂停" : "播放"} onClick={() => { if (playhead >= total) setPlayhead(0); setPlaying(value => !value); }}><TransportIcon kind={playing ? "pause" : "play"} /></button><button type="button" aria-label="下一帧" title="下一帧" onClick={() => setPlayhead(Math.min(total, playhead + 1 / FPS))}><TransportIcon kind="frame" /></button></div></section>
        <div className="vs-splitter vs-splitter-horizontal" role="separator" aria-label="调整时间线高度" aria-orientation="horizontal" aria-valuenow={timelineHeight} tabIndex={0} onPointerDown={event => startResize(event, "timeline")} onMouseDown={event => startResize(event, "timeline")} onKeyDown={event => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); setLayoutPrefs(current => ({ ...current, timelineHeight: clamp(current.timelineHeight + (event.key === "ArrowUp" ? 20 : -20), TIMELINE_MIN_HEIGHT, Math.max(TIMELINE_MIN_HEIGHT, (centerRef.current?.clientHeight || 700) - 190)) })); } }} />
        <section className="vs-timeline-section" style={{ height: timelineHeight, "--track-height": `${TRACK_HEIGHT}px`, "--tracks-height": `${TRACKS * TRACK_HEIGHT}px`, "--time-grid": `${zoom}px` }}><div className="vs-timeline-toolbar"><strong>时间线</strong><label>缩放 <input type="range" min="25" max="120" step="5" value={zoom} onChange={e => setZoom(Number(e.target.value))} /></label></div><div ref={timelineScrollRef} className="vs-timeline-scroll"><div className="vs-timeline-inner" style={{ width: timelineWidth }}><div className="vs-ruler" onPointerDown={e => { setPlaying(false); setPlayhead(Math.max(0, Math.min(total, roundFrame((e.clientX - e.currentTarget.getBoundingClientRect().left) / zoom)))); }}>{Array.from({ length: Math.ceil(timelineWidth / zoom) }, (_, i) => <span key={i} style={{ left: i * zoom }}>{i}s</span>)}</div><div ref={laneRef} className="vs-lanes" onPointerMove={pointerMove} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }}>{Array.from({ length: TRACKS }, (_, track) => <div key={track} className="vs-lane"><span className="vs-lane-label">V{track + 1}</span></div>)}{clips.map(clip => <div key={clip.id} className={`vs-clip ${selectedId === clip.id ? "is-selected" : ""} ${clip.status !== "completed" ? "is-pending" : ""}`} style={{ left: clip.position * zoom, top: clip.track * TRACK_HEIGHT + CLIP_INSET, width: Math.max(20, durationOf(clip) * zoom) }} role="button" tabIndex={0} aria-label={`${clip.name}，轨道 ${clip.track + 1}`} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectClip(clip); } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) openClipMenu(event, clip); }} onClick={() => selectClip(clip)} onPointerDown={e => pointerDown(e, clip, "move")} onContextMenu={event => openClipMenu(event, clip)}><span className="vs-trim" onPointerDown={e => pointerDown(e, clip, "left")} /><span className="vs-clip-title">{clip.status === "running" ? "◌ " : "▶ "}{clip.name}</span><span className="vs-clip-time">{durationOf(clip).toFixed(1)}s</span><span className="vs-trim" onPointerDown={e => pointerDown(e, clip, "right")} /></div>)}<div className="vs-playhead" style={{ left: playhead * zoom }} /></div></div></div></section></main>
      <aside className={`vs-right ${rightCollapsed ? "is-collapsed" : ""}`}><button type="button" className="vs-right-toggle" aria-label={rightCollapsed ? "展开片段检查面板" : "收起片段检查面板"} title={rightCollapsed ? "展开侧栏" : "收起侧栏"} aria-expanded={!rightCollapsed} onClick={() => setLayoutPrefs(current => ({ ...current, rightCollapsed: !current.rightCollapsed }))}>{rightCollapsed ? "◀" : "▶"}</button><div className="vs-right-tabs"><button className={panel === "inspect" ? "is-current" : ""} onClick={() => setPanel("inspect")}>片段检查</button><button className={panel === "create" ? "is-current" : ""} onClick={() => setPanel("create")}>生成片段</button><button className={panel === "models" ? "is-current" : ""} onClick={() => setPanel("models")}>模型设置</button></div>{panel === "inspect" && selected && <VideoInspector key={selected.id} selected={selected} frameTime={frameTime} setFrameTime={setFrameTime} setPlayhead={setPlayhead} setPlaying={setPlaying} playing={playing} updateClip={updateClip} prompt={prompt} setPrompt={setPrompt} seconds={seconds} setSeconds={setSeconds} regenerate={regenerate} busy={busy} ready={modelReady && videoModel?.supportsEndFrame} videoModel={videoModel} duplicateClip={duplicateClip} removeClip={removeClip} />}{panel === "inspect" && !selected && <div className="vs-empty-small">在左侧片段树或中间时间线选中片段，检查每一帧并重生成。</div>}{panel === "models" && <VideoModelSetup setup={setup} selectedModel={selectedModel} onSelect={chooseVideoModel} onRefresh={() => refreshSetup().catch(e => setError(e.message))} onStart={startLocalModel} starting={startingModel} />}{panel === "create" && <form className="vs-create" onSubmit={generateNew}><h2>生成视频片段</h2><div className="vs-create-model"><span>当前模型：{videoModel?.name || "加载中"}</span><button type="button" onClick={() => setPanel("models")}>更换 / 设置</button></div>{!modelReady && <p className="vs-help">模型尚未就绪，请先进入“模型设置”检查并启动。</p>}<label>片段名称<input value={newName} onChange={e => setNewName(e.target.value)} placeholder="例如：镜头 01" /></label><label>起始图<input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => setFirstImage(e.target.files?.[0] || null)} /></label>{firstImage && <img className="vs-upload-preview" src={firstImage instanceof File ? URL.createObjectURL(firstImage) : firstImage} alt="起始图" />}{videoModel?.supportsEndFrame ? <label>尾帧图（可选）<input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => setLastImage(e.target.files?.[0] || null)} /></label> : <p className="vs-help">此模型仅支持起始图，不支持尾帧约束。</p>}{lastImage && <img className="vs-upload-preview" src={lastImage instanceof File ? URL.createObjectURL(lastImage) : lastImage} alt="尾帧图" />}<label>动作描述<textarea required rows={5} maxLength={2000} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="描述镜头运动、人物动作和场景变化…" /></label><label>时长<select value={seconds} onChange={e => setSeconds(Number(e.target.value))}>{(videoModel?.durations || [2, 3, 5]).map(value => <option key={value} value={value}>{value} 秒</option>)}</select></label><button className="vs-primary" disabled={busy || !modelReady || !firstImage || !prompt.trim()}>{busy ? "正在提交…" : "生成并加入时间线"}</button></form>}</aside>
    </div>
    {contextMenu && menuClip && <div ref={menuRef} className="vs-context-menu" role="menu" aria-label={`${menuClip.name} 的操作`} style={{ left: contextMenu.x, top: contextMenu.y }} onContextMenu={event => event.preventDefault()}>
      {contextMenu.renaming ? <form className="vs-context-rename" onSubmit={renameClip}>
        <label>片段名称<input autoFocus value={contextMenu.name} maxLength={100} onChange={event => setContextMenu(current => ({ ...current, name: event.target.value }))} /></label>
        <div><button type="button" onClick={() => setContextMenu(null)}>取消</button><button type="submit" disabled={!contextMenu.name.trim()}>保存</button></div>
      </form> : <>
        <strong className="vs-context-title">{menuClip.name}</strong>
        <button role="menuitem" onClick={() => duplicateClip(menuClip)}>复制片段</button>
        <button role="menuitem" disabled={playhead <= menuClip.position + 1 / (menuClip.fps || FPS) || playhead >= endOf(menuClip) - 1 / (menuClip.fps || FPS)} onClick={() => splitClip(menuClip)}>在播放头处分割</button>
        <button role="menuitem" onClick={() => setContextMenu(current => ({ ...current, renaming: true }))}>重命名</button>
        <button role="menuitem" disabled={menuClip.status !== "completed" || exportJob?.status === "running"} onClick={() => exportClip(menuClip)}>导出片段（MP4）</button>
        <button role="menuitem" className="vs-context-delete" onClick={() => removeClip(menuClip)}>删除片段</button>
      </>}
    </div>}
  </div>;
}
