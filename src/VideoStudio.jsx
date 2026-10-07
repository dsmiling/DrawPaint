import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { createProjectSaver } from "./video-project-save.js";
import useVideoDocument from "./useVideoDocument.js";
import { blobToDataUrl, fileToDataUrl } from "./api.js";
import { releaseVideoPromptModel } from "./video-prompt-model.js";
import VideoInspector from "./VideoInspector.jsx";
import VideoClipHeading from "./VideoClipHeading.jsx";
import VideoClipSettings from "./VideoClipSettings.jsx";
import VideoLibraryDialog from "./VideoLibraryDialog.jsx";
import VideoDraftEditor from "./VideoDraftEditor.jsx";
import VideoLayers, { assetKey, sourceUrl } from "./VideoLayers.jsx";
import VideoTimelinePreview from "./VideoTimelinePreview.jsx";
import VideoModelSetup from "./VideoModelSetup.jsx";
import VideoSequenceExport from "./VideoSequenceExport.jsx";
import VideoGenerationQueue from "./VideoGenerationQueue.jsx";
import useVideoGenerationQueue from "./useVideoGenerationQueue.js";
import useVideoSequences from "./useVideoSequences.js";
import { FrameSequenceCanvas } from "./FrameSequencePreview.jsx";
import { enqueueVideoDrafts, videoQueueLabel } from "../shared/video-queue.js";
import UiIcon, { IconButton } from "./UiIcon.jsx";
import { normalizeFrameAnimation } from "../shared/frame-animation.js";
import { videoProjectSnapshot } from "../shared/video-project-sync.js";
import { arrangeNodes, clamp, clipRate, durationOf, endOf, exportable, MAX_VIDEO_CLIPS, newDraft, nodePosition, nodeSize, patchClip, roundFrame, sourceTime, splitAt, VIDEO_TRACKS } from "../shared/video-editing.js";
import "./video.css";
import "./video-theme.css";
import "./video-controls.css";

const TRACK_HEIGHT = 36, TRACK_INSET = 4;
const timeLabel = time => `${Math.floor(time / 60).toString().padStart(2, "0")}:${Math.floor(time % 60).toString().padStart(2, "0")}.${Math.floor(time % 1 * 100).toString().padStart(2, "0")}`;
const frameUrl = (source, time, maxSize = 2048) => `/api/video/frame?type=${source.type}&id=${source.id}&time=${Math.floor(time * 1000) / 1000}&maxSize=${maxSize}`;
const jsonOptions = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function request(url, options) {
  const response = await fetch(url, options), value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error || `HTTP ${response.status}`), { status: response.status });
  return value;
}
async function imageData(value) {
  if (value instanceof File) return fileToDataUrl(value);
  if (value?.startsWith("data:")) return value;
  const response = await fetch(value);
  if (!response.ok) throw new Error("无法读取参考帧");
  return blobToDataUrl(await response.blob());
}

function NodeMedia({ clip, enabled, onMetadata, generationJob, sequence }) {
  const ref = useRef(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  useEffect(() => { setPreviewFailed(false); }, [clip.source?.id, clip.in]);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.playbackRate = clipRate(clip);
    if (enabled && !clip.hidden) video.play().catch(() => {}); else video.pause();
  }, [enabled, clip.hidden, clip.playbackRate]);
  if (clip.status === "draft") return <div className="vs-node-draft" title={clip.prompt || "选中后上传首帧、填写动作"}>{clip.firstImageId ? <img src={`/api/video/reference-images/${clip.firstImageId}.png`} alt="待生成首帧" /> : <UiIcon name="newVideo" size={32} />}</div>;
  if (clip.status !== "completed" || !clip.source) return <span className={`vs-node-state ${clip.status === "running" && generationJob?.queueState !== "queued" ? "is-running" : ""}`} title={clip.status === "running" ? videoQueueLabel(generationJob) : "视频不可用，可在素材库检查或替换视频"} aria-label={clip.status === "running" ? videoQueueLabel(generationJob) : "视频不可用"}><UiIcon name={clip.status === "running" ? "pending" : "warning"} size={26} />{clip.status === "running" && <small>{videoQueueLabel(generationJob)}</small>}</span>;
  if (sequence) return <FrameSequenceCanvas sequence={sequence} playing={enabled && !clip.hidden} loop playbackRate={clipRate(clip) / sequence.range.playbackRate} />;
  const poster = frameUrl(clip.source, clip.in, 512);
  if (!enabled && !previewFailed) return <img src={poster} alt={clip.name || "视频缩略图"} loading="lazy" draggable={false} onError={() => setPreviewFailed(true)} />;
  return <video ref={ref} src={sourceUrl(clip.source)} poster={previewFailed ? undefined : poster} muted playsInline preload="auto" onLoadedMetadata={event => {
    event.currentTarget.currentTime = clip.in; event.currentTarget.playbackRate = clipRate(clip);
    onMetadata(event.currentTarget); if (enabled && !clip.hidden) event.currentTarget.play().catch(() => {});
  }} onTimeUpdate={event => { const video = event.currentTarget; if (video.currentTime >= clip.out - .015 || video.currentTime < clip.in) video.currentTime = clip.in; }} onEnded={event => { event.currentTarget.currentTime = clip.in; if (enabled && !clip.hidden) event.currentTarget.play().catch(() => {}); }} />;
}

export default forwardRef(function VideoWorkspace({ canvasImage, canvasId, canvasName, canvasToolbar, locked, onState, onSaved, active = true, clipboardRef }, ref) {
  const document = useVideoDocument(), { clips, setClips, outputSize, setOutputSize } = document;
  const [loaded, setLoaded] = useState(false), [selectedIds, setSelectedIds] = useState([]);
  const [playhead, setPlayhead] = useState(0), [playing, setPlaying] = useState(false), [frameTime, setFrameTime] = useState(0);
  const [zoom, setZoom] = useState(50), [graphPan, setGraphPan] = useState({ x: 0, y: 0 });
  const [tool, setTool] = useState("select"), [snap, setSnap] = useState(true), [marquee, setMarquee] = useState(null), [viewMode, setViewMode] = useState("nodes");
  const [setup, setSetup] = useState(null), [startingModel, setStartingModel] = useState(false), [busy, setBusy] = useState(false);
  const { queue: generationQueue, refresh: refreshGenerationQueue } = useVideoGenerationQueue(active);
  const [queueOpen, setQueueOpen] = useState(false);
  const [error, setError] = useState(""), [message, setMessage] = useState(""), [saveStatus, setSaveStatus] = useState("loading");
  const [panel, setPanel] = useState("inspect"), [library, setLibrary] = useState([]), [libraryOpen, setLibraryOpen] = useState(false);
  const [selectedAssetKeys, setSelectedAssetKeys] = useState([]), [playingAssetKey, setPlayingAssetKey] = useState(null);
  const [libraryFolders, setLibraryFolders] = useState([]), [libraryDialog, setLibraryDialog] = useState(null), [libraryWorking, setLibraryWorking] = useState(false);
  const [libraryFolder, setLibraryFolder] = useState(() => { try { return localStorage.getItem("drawpaint.video-library.folder") || "all"; } catch { return "all"; } });
  const [selectedModel, setSelectedModel] = useState(() => { try { return localStorage.getItem("drawpaint.video-studio.model") || "minimax-h3"; } catch { return "minimax-h3"; } });
  const [seconds, setSeconds] = useState(2), [regenerationSettings, setRegenerationSettings] = useState(normalizeFrameAnimation(null));
  const [exportJob, setExportJob] = useState(null), [sequenceDialog, setSequenceDialog] = useState(null), [exportSubmitting, setExportSubmitting] = useState(false);
  const { sequences, error: sequenceError } = useVideoSequences(canvasId, active, exportJob?.status === "completed" ? exportJob.id : null);
  const sequenceByClip = new Map(sequences.map(sequence => [sequence.clipId, sequence]));
  const [clipSettingsId, setClipSettingsId] = useState(null);
  const [contextMenu, setContextMenu] = useState(null), [layout, setLayout] = useState(() => {
    try { const value = JSON.parse(localStorage.getItem("drawpaint.video-studio.layout") || "{}"); return { leftWidth: clamp(Number(value.leftWidth) || 230, 190, 420), timelineHeight: clamp(Number(value.timelineHeight) || 216, 140, 700), graphZoom: 100, rightCollapsed: value.rightCollapsed === true }; }
    catch { return { leftWidth: 230, timelineHeight: 216, graphZoom: 100, rightCollapsed: false }; }
  });
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem("drawpaint.video-studio.theme") === "light" ? "light" : "dark"; } catch { return "dark"; } });
  const { leftWidth, timelineHeight, graphZoom, rightCollapsed } = layout;
  const selected = clips.find(clip => clip.id === selectedIds.at(-1)) || null;
  const selectedSequence = selected ? sequenceByClip.get(selected.id) : null;
  const selectedClips = clips.filter(clip => selectedIds.includes(clip.id));
  const selectedDrafts = selectedClips.filter(clip => clip.status === "draft");
  const generationJobs = new Map(generationQueue.jobs.map(job => [job.id, job]));
  const selectedGenerationJob = selected?.source?.type === "job" ? generationJobs.get(selected.source.id) : null;
  const videoModel = setup?.models.find(model => model.id === selectedModel);
  const total = clips.length ? Math.max(...clips.filter(clip => !clip.hidden).map(endOf), 1 / 24) : 5, timelineWidth = Math.max(940, (total + 3) * zoom);
  const completed = clips.filter(exportable), unavailable = clips.filter(clip => !clip.source || clip.status !== "completed");
  const rootRef = useRef(null), graphRef = useRef(null), timelineRef = useRef(null), lanesRef = useRef(null), centerRef = useRef(null), layoutRef = useRef(null), uploadRef = useRef(null), menuRef = useRef(null);
  const gestureRef = useRef(null), handlers = useRef(null), replaceRef = useRef(null), localClipboard = useRef([]), imageConsumed = useRef(null), spaceRef = useRef(false);
  const clipboard = clipboardRef || localClipboard;
  const snapshotRef = useRef(null), saverRef = useRef(null), onSavedRef = useRef(onSaved), busyRef = useRef(false);
  const [width, height] = outputSize.split("x").map(Number);
  snapshotRef.current = JSON.stringify({ clips, width, height, view: { graphPan, graphZoom, timelineZoom: zoom, selectedIds } });
  onSavedRef.current = onSaved; busyRef.current = busy || exportSubmitting;
  if (!saverRef.current) saverRef.current = createProjectSaver({ getSnapshot: () => snapshotRef.current,
    send: (project, revision) => request(`/api/video/project?canvasId=${encodeURIComponent(canvasId)}`, jsonOptions("PUT", { ...project, baseRevision: revision })),
    onStatus: setSaveStatus, onSaved: project => onSavedRef.current(project) });
  useImperativeHandle(ref, () => ({ flush: async () => { if (busyRef.current) throw new Error("正在提交生成、导入或导出，请稍后切换画布"); await saverRef.current.flush(); } }), []);
  useEffect(() => { onState({ status: saveStatus, busy: busy || exportSubmitting, ready: loaded }); }, [saveStatus, busy, exportSubmitting, loaded, onState]);
  useEffect(() => { try { localStorage.setItem("drawpaint.video-studio.theme", theme); } catch { /* Optional preference. */ } }, [theme]);
  useEffect(() => { try { localStorage.setItem("drawpaint.video-studio.layout", JSON.stringify({ ...layout, compactTimeline: true })); } catch { /* Optional preference. */ } }, [layout]);
  useEffect(() => { try { localStorage.setItem("drawpaint.video-studio.model", selectedModel); } catch { /* Optional preference. */ } }, [selectedModel]);
  useEffect(() => { setRegenerationSettings(normalizeFrameAnimation(selected?.frameAnimation)); }, [selected?.id, selected?.frameAnimation]);
  useEffect(() => { if (!active) setPlaying(false); }, [active]);
  useEffect(() => { try { localStorage.setItem("drawpaint.video-library.folder", libraryFolder); } catch { /* Optional view preference. */ } }, [libraryFolder]);

  async function refreshSetup() { const service = await request("/api/video/setup"); setSetup(service); return service; }
  async function refreshLibrary() {
    const [jobs, imports, catalog] = await Promise.all([request("/api/video/jobs?limit=500"), request("/api/video/assets"), request("/api/video/library")]);
    setLibraryFolders(catalog.folders);
    setLibrary([...jobs.jobs.map(job => ({ ...job, name: job.name || "生成视频", source: { type: "job", id: job.id } })), ...imports.assets].map(asset => ({ ...asset, ...catalog.items[assetKey(asset)] })));
    setLibraryFolder(current => ["all", "root"].includes(current) || catalog.folders.some(folder => folder.id === current) ? current : "all");
  }
  function selectFolder(id) { setLibraryFolder(id); setSelectedAssetKeys([]); setPlayingAssetKey(null); setContextMenu(null); }
  function insertionFolder() { return libraryOpen && libraryFolder !== "all" ? libraryFolder === "root" ? null : libraryFolder : undefined; }
  async function changeLibrary(action) {
    if (libraryWorking) throw new Error("正在保存目录，请稍后再试");
    setLibraryWorking(true);
    try {
      const catalog = await request("/api/video/library", jsonOptions("POST", action));
      setLibraryFolders(catalog.folders); setLibrary(current => current.map(asset => ({ ...asset, ...catalog.items[assetKey(asset)] })));
      if (catalog.affectedFolderId) selectFolder(catalog.affectedFolderId);
      else if (!["all", "root"].includes(libraryFolder) && !catalog.folders.some(folder => folder.id === libraryFolder)) selectFolder("root");
      if (action.action === "move-assets") { setSelectedAssetKeys([]); setPlayingAssetKey(null); }
      setContextMenu(null); return catalog;
    } finally { setLibraryWorking(false); }
  }
  function newFolder(parentId = libraryFolder === "all" || libraryFolder === "root" ? null : libraryFolder) { setContextMenu(null); setLibraryDialog({ kind: "create-folder", parentId }); }
  function openFolderMenu(event, folderId) {
    event.preventDefault(); event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setContextMenu({ folderMenu: true, folderId, x: clamp(event.clientX ?? rect.left + 16, 8, window.innerWidth - 220), y: clamp(event.clientY ?? rect.top + 16, 8, window.innerHeight - 160) });
  }
  async function dropInFolder(event, folderId) {
    try {
      const sourceFolder = event.dataTransfer.getData("application/x-drawpaint-video-folder"), keys = event.dataTransfer.getData("application/x-drawpaint-video-assets");
      if (sourceFolder) await changeLibrary({ action: "move-folder", id: sourceFolder, parentId: folderId });
      else if (keys) await changeLibrary({ action: "move-assets", keys: JSON.parse(keys), folderId });
      else if (event.dataTransfer.files[0]?.type.startsWith("video/")) await importVideo(event.dataTransfer.files[0], null, undefined, folderId);
    } catch (cause) { setError(cause.message); }
  }
  useEffect(() => {
    let cancelled = false;
    request(`/api/video/project?canvasId=${encodeURIComponent(canvasId)}`).then(project => {
      if (cancelled) return;
      const { clips: savedClips, width: savedWidth, height: savedHeight, view } = videoProjectSnapshot(project);
      saverRef.current.seed(JSON.stringify({ clips: savedClips, width: savedWidth, height: savedHeight, view }), project.revision ?? project.updatedAt ?? null);
      document.reset({ clips: savedClips, outputSize: `${savedWidth}x${savedHeight}` }); setGraphPan(view.graphPan); setZoom(view.timelineZoom); setSelectedIds(view.selectedIds);
      setLayout(current => ({ ...current, graphZoom: view.graphZoom })); setFrameTime(savedClips.find(clip => clip.id === view.selectedIds.at(-1))?.in || 0); setSaveStatus("saved"); setLoaded(true);
    }).catch(cause => { if (!cancelled) { setError(`画布加载失败：${cause.message}`); setSaveStatus("error"); } });
    refreshSetup().catch(cause => { if (!cancelled) setError(cause.message); }); refreshLibrary().catch(cause => { if (!cancelled) setError(cause.message); });
    return () => { cancelled = true; if (saverRef.current.dirty()) saverRef.current.flush().catch(() => {}); };
  }, []);
  useEffect(() => {
    if (!loaded || !saverRef.current.dirty()) return;
    setSaveStatus("dirty"); const timer = setTimeout(() => saverRef.current.flush().catch(cause => setError(`画布保存失败：${cause.message}`)), 400);
    return () => clearTimeout(timer);
  }, [snapshotRef.current, loaded]);
  useEffect(() => { setSelectedIds(current => { const next = current.filter(id => clips.some(clip => clip.id === id)); return next.length === current.length ? current : next; }); }, [clips]);
  useEffect(() => {
    if (!loaded || !active) return;
    let cancelled = false, polling = false;
    const refresh = async () => {
      if (polling || busyRef.current || gestureRef.current || playing) return;
      polling = true;
      try {
        const revision = saverRef.current.revision();
        const project = await request(`/api/video/project?canvasId=${encodeURIComponent(canvasId)}`);
        if (cancelled || busyRef.current || gestureRef.current) return;
        const remote = videoProjectSnapshot(project);
        const received = await saverRef.current.receive(JSON.stringify(remote), project.revision ?? project.updatedAt ?? null, revision, merged => {
          if (cancelled) return false;
          const previous = JSON.parse(snapshotRef.current), added = merged.clips.filter(clip => !previous.clips.some(item => item.id === clip.id));
          snapshotRef.current = JSON.stringify(merged);
          if (JSON.stringify(previous.clips) !== JSON.stringify(merged.clips) || previous.width !== merged.width || previous.height !== merged.height) {
            document.reset({ clips: merged.clips, outputSize: `${merged.width}x${merged.height}` });
            setSelectedIds(merged.view.selectedIds);
          }
          setError(current => current.startsWith("画布保存失败：") ? "" : current);
          onSavedRef.current(project);
          if (added.length) {
            setMessage(`画布已同步，新增 ${added.length} 个片段。`);
            requestAnimationFrame(() => { if (!cancelled) fitGraph(merged.clips.map(clip => clip.id), merged.clips); });
          }
        });
        if (received && saverRef.current.dirty()) saverRef.current.flush().catch(cause => { if (!cancelled) setError(`画布保存失败：${cause.message}`); });
      } catch { /* Keep local edits available during a temporary disconnect. */ }
      finally { polling = false; }
    };
    refresh(); const timer = setInterval(refresh, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [canvasId, loaded, active, playing]);
  useEffect(() => { const timer = setInterval(() => refreshSetup().catch(() => {}), 12000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const pending = clips.filter(clip => clip.status === "running" && clip.source);
    if (!pending.length) return;
    let cancelled = false;
    const poll = async () => {
      const results = await Promise.all(pending.map(async clip => { try { return { id: clip.id, sourceId: clip.source.id, ...(await request(`/api/video/jobs/${clip.source.id}`)) }; } catch { return null; } }));
      if (cancelled) return;
      for (const result of results.filter(Boolean)) if (result.status !== "running") {
        const info = result.status === "completed" ? await request(`/api/video/media-info?type=job&id=${result.sourceId}`).catch(() => null) : null;
        if (cancelled) return;
        setClips(current => current.map(clip => clip.source?.id === result.sourceId ? { ...clip, status: result.status,
          ...(info ? { out: clip.out === clip.mediaDuration ? info.duration : Math.min(clip.out, info.duration), mediaDuration: info.duration, mediaWidth: info.width, mediaHeight: info.height, fps: info.fps } : {}) } : clip), false);
        if (result.status === "completed") { setMessage("视频已生成，可以裁剪、选取首尾帧和导出。"); refreshLibrary().catch(() => {}); }
      }
    };
    poll(); const timer = setInterval(poll, 5000); return () => { cancelled = true; clearInterval(timer); };
  }, [clips.filter(clip => clip.status === "running").map(clip => clip.id).join(",")]);
  useEffect(() => {
    if (exportJob?.status !== "running") return;
    let cancelled = false;
    const timer = setInterval(() => request(`/api/video/exports/${exportJob.id}`).then(job => { if (!cancelled) setExportJob(job); }).catch(cause => { if (!cancelled) setError(cause.message); }), 1500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [exportJob?.id, exportJob?.status]);
  useEffect(() => {
    if (!playing) return;
    const origin = performance.now() - playhead * 1000; let frame;
    const tick = now => { const next = (now - origin) / 1000; if (next >= total) { setPlayhead(total); setPlaying(false); return; } setPlayhead(next); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [playing, total]);
  useEffect(() => { if (playing && selected && playhead >= selected.position && playhead < endOf(selected)) setFrameTime(Math.min(selected.out - 1 / (selected.fps || 24), sourceTime(selected, playhead))); }, [playhead, playing, selected?.id]);
  useEffect(() => {
    if (!canvasImage || !loaded || imageConsumed.current === canvasImage) return;
    imageConsumed.current = canvasImage;
    const draft = createDraft(); if (draft) uploadReference(draft.id, "firstImageId", canvasImage.src);
  }, [canvasImage, loaded]);
  useEffect(() => {
    const move = event => handlers.current?.move(event), finish = () => handlers.current?.finish();
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish); window.addEventListener("pointercancel", finish);
    const release = event => { if (event.code === "Space") spaceRef.current = false; };
    window.addEventListener("keyup", release); window.addEventListener("blur", finish);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", finish); window.removeEventListener("keyup", release); window.removeEventListener("blur", finish); };
  }, []);
  useEffect(() => {
    if (!contextMenu) return;
    const close = event => { if (!menuRef.current?.contains(event.target)) setContextMenu(null); };
    window.addEventListener("pointerdown", close); return () => window.removeEventListener("pointerdown", close);
  }, [contextMenu]);
  useLayoutEffect(() => {
    if (!contextMenu || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const x = clamp(contextMenu.x, 8, window.innerWidth - rect.width - 8), y = clamp(contextMenu.y, 8, window.innerHeight - rect.height - 8);
    if (x !== contextMenu.x || y !== contextMenu.y) setContextMenu(current => ({ ...current, x, y }));
  }, [contextMenu]);

  function editClip(id, patch) {
    if (patch.frameAnimation && clips.find(clip => clip.id === id)?.status === "draft") {
      try { localStorage.setItem("drawpaint.video-studio.generation-purpose", JSON.stringify(patch.frameAnimation)); } catch { /* Saving the draft remains available. */ }
    }
    setClips(current => current.map(clip => clip.id === id ? patchClip(clip, patch) : clip));
  }
  function selectClip(clip, source = "graph", event) {
    const multiple = event?.ctrlKey || event?.metaKey || event?.shiftKey;
    setSelectedIds(current => multiple ? current.includes(clip.id) ? current.filter(id => id !== clip.id) : [...current, clip.id] : [clip.id]);
    setFrameTime(clip.startFrame ?? clip.in); setPlayhead(clip.position); setPlaying(false); setPanel("inspect"); setLayout(current => ({ ...current, rightCollapsed: false }));
    if (source === "list") {
      const point = nodePosition(clip, clips.indexOf(clip)), graph = graphRef.current;
      if (graph) setGraphPan({ x: graph.clientWidth / 2 - (point.x + nodeSize(clip).width / 2) * graphZoom / 100, y: graph.clientHeight / 2 - (point.y + nodeSize(clip).height / 2) * graphZoom / 100 });
    }
    const timeline = timelineRef.current;
    if (timeline) timeline.scrollTo({ left: Math.max(0, clip.position * zoom - timeline.clientWidth / 3), top: Math.max(0, clip.track * TRACK_HEIGHT - TRACK_HEIGHT) });
  }
  function canvasPoint(clientX, clientY) {
    const rect = graphRef.current?.getBoundingClientRect();
    return { x: ((clientX ?? (rect?.left || 0) + (rect?.width || 600) / 2) - (rect?.left || 0) - graphPan.x) / (graphZoom / 100), y: ((clientY ?? (rect?.top || 0) + 80) - (rect?.top || 0) - graphPan.y) / (graphZoom / 100) };
  }
  function createDraft(point) {
    try {
      let purpose = normalizeFrameAnimation(null);
      try { purpose = normalizeFrameAnimation(JSON.parse(localStorage.getItem("drawpaint.video-studio.generation-purpose") || "null")); } catch { /* Use ordinary video for an invalid preference. */ }
      const draft = { ...newDraft(crypto.randomUUID(), clips, point || canvasPoint(), purpose), modelId: selectedModel };
      setClips(current => [...current, draft]); setSelectedIds([draft.id]); setFrameTime(0); setPanel("inspect"); setViewMode("nodes"); setLibraryOpen(false); setLayout(current => ({ ...current, rightCollapsed: false })); setContextMenu(null); setMessage(""); return draft;
    } catch (cause) { setError(cause.message); return null; }
  }
  function fitGraph(ids = clips.map(clip => clip.id), graphClips = clips) {
    const graph = graphRef.current, chosen = graphClips.filter(clip => ids.includes(clip.id));
    if (!graph) return;
    if (!chosen.length) { setGraphPan({ x: 0, y: 0 }); setLayout(current => ({ ...current, graphZoom: 100 })); return; }
    const boxes = chosen.map(clip => ({ ...nodePosition(clip, graphClips.indexOf(clip)), ...nodeSize(clip) }));
    const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y)), right = Math.max(...boxes.map(box => box.x + box.width)), bottom = Math.max(...boxes.map(box => box.y + box.height));
    const next = clamp(Math.floor(Math.min((graph.clientWidth - 48) / (right - x), (graph.clientHeight - 48) / (bottom - y)) * 100 / 5) * 5, 20, 200);
    setGraphPan({ x: (graph.clientWidth - (right - x) * next / 100) / 2 - x * next / 100, y: (graph.clientHeight - (bottom - y) * next / 100) / 2 - y * next / 100 }); setLayout(current => ({ ...current, graphZoom: next }));
  }
  function changeZoom(value, anchor) {
    const next = clamp(Math.round(value / 5) * 5, 20, 200), graph = graphRef.current;
    if (!graph || next === graphZoom) return;
    const rect = graph.getBoundingClientRect(), x = anchor ? anchor.x - rect.left : rect.width / 2, y = anchor ? anchor.y - rect.top : rect.height / 2;
    setGraphPan({ x: x - (x - graphPan.x) * next / graphZoom, y: y - (y - graphPan.y) * next / graphZoom }); setLayout(current => ({ ...current, graphZoom: next }));
  }
  function duplicateSelection(source = selectedClips, paste = false) {
    if (clips.length + source.length > MAX_VIDEO_CLIPS) { setError("每个画布最多 100 个片段"); return; }
    const point = contextMenu?.point || canvasPoint(), originX = Math.min(...source.map((clip, index) => nodePosition(clip, index).x)), originY = Math.min(...source.map((clip, index) => nodePosition(clip, index).y));
    const timelineStart = Math.max(0, ...clips.map(endOf)), sourceStart = Math.min(...source.map(clip => clip.position));
    const clones = source.map((clip, index) => ({ ...clip, id: crypto.randomUUID(), name: `${clip.name} 副本`.slice(0, 100), locked: false,
      position: paste ? timelineStart + clip.position - sourceStart : endOf(clip), nodeX: nodePosition(clip, index).x + (paste ? point.x - originX : 36), nodeY: nodePosition(clip, index).y + (paste ? point.y - originY : 36) }));
    setClips(current => [...current, ...clones]); setSelectedIds(clones.map(clip => clip.id)); setContextMenu(null); setPanel("inspect");
  }
  function copySelection(source = selectedClips) {
    clipboard.current = source.map(clip => ({ ...clip }));
    setMessage(`已复制 ${source.length} 个片段，可切换画布后右键粘贴。`); setContextMenu(null);
  }
  function removeSelection(ids = selectedIds) {
    const removable = clips.filter(clip => ids.includes(clip.id) && !clip.locked).map(clip => clip.id);
    setClips(current => current.filter(clip => !removable.includes(clip.id))); setSelectedIds(current => current.filter(id => !removable.includes(id))); setPlaying(false); setContextMenu(null);
    if (removable.length < ids.length) setMessage("锁定的片段已保留，请先解锁再移除。");
  }
  function splitClip(clip = selected) {
    try { if (clips.length >= MAX_VIDEO_CLIPS) throw new Error("每个画布最多 100 个片段"); const [left, right] = splitAt(clip, playhead, crypto.randomUUID()); setClips(current => [...current.map(item => item.id === clip.id ? left : item), right]); setSelectedIds([right.id]); setContextMenu(null); }
    catch (cause) { setError(cause.message); }
  }
  function bulkChange(patch, ids = selectedIds) { setClips(current => current.map(clip => ids.includes(clip.id) ? patchClip(clip, patch) : clip)); }
  function openMenu(event, clip) {
    event.preventDefault(); event.stopPropagation();
    if (clip && !selectedIds.includes(clip.id)) selectClip(clip);
    setContextMenu({ id: clip?.id || null, point: canvasPoint(event.clientX, event.clientY), x: clamp(event.clientX, 8, window.innerWidth - 220), y: clamp(event.clientY, 8, window.innerHeight - 390) });
  }
  function selectAsset(asset, event) {
    const key = assetKey(asset);
    setSelectedAssetKeys(current => event?.ctrlKey || event?.metaKey || event?.shiftKey ? current.includes(key) ? current.filter(item => item !== key) : [...current, key] : [key]);
    setPlayingAssetKey(current => current === key ? current : null); setContextMenu(null);
  }
  function openAssetMenu(event, asset) {
    event.preventDefault(); event.stopPropagation();
    const keys = selectedAssetKeys.includes(assetKey(asset)) ? selectedAssetKeys : [assetKey(asset)];
    setSelectedAssetKeys(keys);
    const rect = event.currentTarget.getBoundingClientRect();
    setContextMenu({ assetKey: assetKey(asset), assetKeys: keys, x: clamp(event.clientX ?? rect.left + 16, 8, window.innerWidth - 220), y: clamp(event.clientY ?? rect.top + 16, 8, window.innerHeight - 220) });
  }
  function beginNode(event, clip) {
    if (event.button !== 0) return;
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey || event.shiftKey) { selectClip(clip, "graph", event); return; }
    const ids = selectedIds.includes(clip.id) ? selectedIds : [clip.id];
    if (!selectedIds.includes(clip.id)) selectClip(clip);
    if (clip.locked || tool === "hand" || spaceRef.current) { if (tool === "hand" || spaceRef.current) beginBackground(event, true); return; }
    document.begin(); gestureRef.current = { kind: "node", clickedId: clip.id, moved: false, x: event.clientX, y: event.clientY, clips: clips.filter(item => ids.includes(item.id) && !item.locked).map(item => ({ ...item, ...nodePosition(item, clips.indexOf(item)) })) };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function beginBackground(event, forcePan = false) {
    if (event.button !== 0 && event.button !== 1 || !forcePan && event.target.closest(".vs-node,button,input,select")) return;
    event.preventDefault(); graphRef.current?.focus();
    if (forcePan || event.button === 1 || tool === "hand" || spaceRef.current) gestureRef.current = { kind: "pan", x: event.clientX, y: event.clientY, pan: graphPan };
    else { const rect = graphRef.current.getBoundingClientRect(); const x = event.clientX - rect.left, y = event.clientY - rect.top; gestureRef.current = { kind: "marquee", x, y, additive: event.shiftKey || event.ctrlKey || event.metaKey }; setMarquee({ x, y, width: 0, height: 0 }); }
  }
  function beginTimeline(event, clip, kind) {
    if (event.button !== 0) return;
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey || event.shiftKey) { selectClip(clip, "timeline", event); return; }
    const ids = selectedIds.includes(clip.id) ? selectedIds : [clip.id]; if (!selectedIds.includes(clip.id)) selectClip(clip, "timeline");
    if (clip.locked) return;
    document.begin(); gestureRef.current = { kind: "timeline", handle: kind, moved: false, x: event.clientX, y: event.clientY, clip, clips: clips.filter(item => ids.includes(item.id) && !item.locked) }; event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event) {
    const gesture = gestureRef.current; if (!gesture) return;
    if (gesture.kind === "pan") setGraphPan({ x: gesture.pan.x + event.clientX - gesture.x, y: gesture.pan.y + event.clientY - gesture.y });
    else if (gesture.kind === "resize") {
      if (gesture.axis === "left") setLayout(current => ({ ...current, leftWidth: clamp(gesture.value + event.clientX - gesture.x, 190, Math.max(190, (layoutRef.current?.clientWidth || 1100) - (rightCollapsed ? 42 : 340) - 327)) }));
      else setLayout(current => ({ ...current, timelineHeight: clamp(gesture.value + gesture.y - event.clientY, 140, Math.max(140, (centerRef.current?.clientHeight || 700) - 240)) }));
    } else if (gesture.kind === "marquee") {
      const rect = graphRef.current.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
      gesture.box = { x: Math.min(x, gesture.x), y: Math.min(y, gesture.y), width: Math.abs(x - gesture.x), height: Math.abs(y - gesture.y) }; setMarquee(gesture.box);
    } else if (gesture.kind === "node") {
      const dx = (event.clientX - gesture.x) / (graphZoom / 100), dy = (event.clientY - gesture.y) / (graphZoom / 100), first = gesture.clips[0];
      if (!gesture.moved && Math.hypot(dx, dy) < 3) return;
      gesture.moved = true;
      const step = snap && !event.altKey ? 24 : 1, deltaX = Math.round((first.x + dx) / step) * step - first.x, deltaY = Math.round((first.y + dy) / step) * step - first.y;
      setClips(current => current.map(clip => { const start = gesture.clips.find(item => item.id === clip.id); return start ? { ...clip, nodeX: clamp(Math.round(start.x + deltaX), -10000, 10000), nodeY: clamp(Math.round(start.y + deltaY), -10000, 10000) } : clip; }));
    } else if (gesture.kind === "timeline") {
      const original = gesture.clip, rate = clipRate(original), sourceDelta = roundFrame((event.clientX - gesture.x) / zoom * rate, original.fps || 24);
      if (!gesture.moved && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 3) return;
      gesture.moved = true;
      if (gesture.handle === "left") { const start = clamp(original.in + sourceDelta, 0, original.out - 1 / (original.fps || 24)); editClip(original.id, { in: start, position: Math.max(0, original.position + (start - original.in) / rate) }); }
      else if (gesture.handle === "right") editClip(original.id, { out: clamp(original.out + sourceDelta, original.in + 1 / (original.fps || 24), original.mediaDuration || original.out) });
      else {
        const rect = lanesRef.current.getBoundingClientRect(), track = clamp(Math.floor((event.clientY - rect.top) / TRACK_HEIGHT), 0, VIDEO_TRACKS - 1);
        let delta = (event.clientX - gesture.x) / zoom;
        if (snap && !event.altKey) {
          const edges = [0, playhead, ...clips.filter(clip => !gesture.clips.some(item => item.id === clip.id)).flatMap(clip => [clip.position, endOf(clip)])];
          const target = edges.map(edge => ({ edge, distance: Math.abs(edge - original.position - delta) })).sort((a, b) => a.distance - b.distance)[0]; if (target?.distance < 8 / zoom) delta = target.edge - original.position;
        }
        delta = Math.max(delta, -Math.min(...gesture.clips.map(clip => clip.position)));
        const trackDelta = clamp(track - original.track, -Math.min(...gesture.clips.map(clip => clip.track)), VIDEO_TRACKS - 1 - Math.max(...gesture.clips.map(clip => clip.track)));
        setClips(current => current.map(clip => { const initial = gesture.clips.find(item => item.id === clip.id); return initial ? { ...clip, position: clamp(roundFrame(initial.position + delta), 0, 3600), track: initial.track + trackDelta } : clip; }));
      }
    }
  }
  function finish() {
    const gesture = gestureRef.current; if (!gesture) return;
    if ((gesture.kind === "node" || gesture.kind === "timeline") && !gesture.moved) {
      const clip = clips.find(item => item.id === (gesture.clickedId || gesture.clip.id));
      if (clip) selectClip(clip, gesture.kind === "timeline" ? "timeline" : "graph");
    }
    if (gesture.kind === "marquee") {
      const box = gesture.box || { x: gesture.x, y: gesture.y, width: 0, height: 0 };
      const ids = box.width < 3 && box.height < 3 ? [] : clips.filter(clip => { const point = nodePosition(clip, clips.indexOf(clip)), size = nodeSize(clip), x = point.x * graphZoom / 100 + graphPan.x, y = point.y * graphZoom / 100 + graphPan.y; return x < box.x + box.width && x + size.width * graphZoom / 100 > box.x && y < box.y + box.height && y + size.height * graphZoom / 100 > box.y; }).map(clip => clip.id);
      setSelectedIds(current => gesture.additive ? [...new Set([...current, ...ids])] : ids); setPanel("inspect"); setMarquee(null);
    }
    gestureRef.current = null; document.end();
  }
  handlers.current = { move, finish };
  function keyboard(event) {
    if (contextMenu?.assetKey || contextMenu?.folderMenu) {
      if (event.key === "Escape") { event.preventDefault(); setContextMenu(null); }
      return;
    }
    if (!active || busy || locked || event.isComposing || event.target.closest("input,textarea,select,[contenteditable=true],dialog,.vs-library")) return;
    const command = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
    if (command && key === "z") { event.preventDefault(); event.shiftKey ? document.redo() : document.undo(); }
    else if (command && key === "y") { event.preventDefault(); document.redo(); }
    else if (command && key === "a") { event.preventDefault(); setSelectedIds(clips.map(clip => clip.id)); }
    else if (command && key === "d") { event.preventDefault(); duplicateSelection(); }
    else if (command && key === "c") { event.preventDefault(); copySelection(); }
    else if (command && key === "v") { event.preventDefault(); duplicateSelection(clipboard.current, true); }
    else if (key === "delete" || key === "backspace") { event.preventDefault(); removeSelection(); }
    else if (key === "escape") { setSelectedIds([]); setContextMenu(null); finish(); }
    else if (event.code === "Space" && !event.target.closest("button")) { event.preventDefault(); spaceRef.current = true; }
    else if (!command && key === "h") setTool("hand"); else if (!command && key === "v") setTool("select");
    else if (!command && ["arrowleft", "arrowright", "arrowup", "arrowdown"].includes(key)) { event.preventDefault(); const step = event.shiftKey ? 10 : 1; setClips(current => current.map(clip => { if (!selectedIds.includes(clip.id) || clip.locked) return clip; const point = nodePosition(clip, current.indexOf(clip)); return { ...clip, nodeX: clamp(point.x + (key === "arrowleft" ? -step : key === "arrowright" ? step : 0), -10000, 10000), nodeY: clamp(point.y + (key === "arrowup" ? -step : key === "arrowdown" ? step : 0), -10000, 10000) }; })); }
  }

  async function uploadReference(id, key, value) {
    if (!value) return;
    setBusy(true); setError("");
    try { const result = await request("/api/video/reference-images", jsonOptions("POST", { image: await imageData(value) })); editClip(id, { [key]: result.id }); }
    catch (cause) { setError(cause.message); } finally { setBusy(false); }
  }
  async function submitGeneration(clip, first, last, length, purpose, modelId, replacing = false, batch = false) {
    if (!batch) { setBusy(true); setError(""); setMessage(""); }
    try {
      const model = setup?.models.find(item => item.id === modelId); if (!model?.ready) throw new Error("当前视频模型未就绪，请在模型设置中检查");
      if (last && !model.supportsEndFrame) throw new Error("当前模型不支持尾帧约束");
      const [image, lastImage] = await Promise.all([imageData(first), last ? imageData(last) : null]);
      await releaseVideoPromptModel();
      const result = await request("/api/video/jobs", jsonOptions("POST", { image, lastImage, prompt: clip.prompt.trim(), seconds: length, modelId, frameAnimation: purpose, name: clip.name, folderId: insertionFolder() }));
      const generated = { ...clip, source: { type: "job", id: result.id }, status: "running", in: 0, out: length, mediaDuration: length, fps: model.fps, modelId, startFrame: null, endFrame: null, frameAnimation: result.frameAnimation, playbackRate: 1, locked: false };
      setClips(current => replacing ? current.map(item => item.id === clip.id ? generated : item) : [...current, generated]);
      if (!batch) { setSelectedIds([clip.id]); setPanel("inspect"); setMessage("已加入视频生成队列，完成后会自动填入这个片段。"); }
      setQueueOpen(true); refreshGenerationQueue(); return result;
    } catch (cause) { if (batch) throw cause; setError(cause.message); return null; } finally { if (!batch) setBusy(false); }
  }
  function generateDraft(clip, batch = false) { return submitGeneration(clip, `/api/video/reference-images/${clip.firstImageId}.png`, clip.lastImageId ? `/api/video/reference-images/${clip.lastImageId}.png` : null, clip.out, clip.frameAnimation, clip.modelId || selectedModel, true, batch); }
  async function generateSelection() {
    if (busyRef.current || !selectedDrafts.length) return;
    const invalid = selectedDrafts.filter(clip => {
      const model = setup?.models.find(item => item.id === (clip.modelId || selectedModel));
      return clip.locked || !clip.firstImageId || !clip.prompt.trim() || !model?.ready || !model.durations.includes(clip.out) || (clip.lastImageId && !model.supportsEndFrame);
    });
    if (invalid.length) { setError(`请先检查这些片段的首帧、动作描述、模型和锁定状态：${invalid.map(clip => clip.name).join("、")}`); return; }
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await enqueueVideoDrafts(selectedDrafts, clip => generateDraft(clip, true));
      setMessage(`已将 ${result.added} 个片段加入生成队列，按加入顺序依次完成。`);
      if (result.failures.length) setError(`以下片段提交失败，可检查后重试：${result.failures.map(item => `${item.name}（${item.error}）`).join("、")}`);
    } finally { setBusy(false); refreshGenerationQueue(); }
  }
  async function regenerate() {
    if (!selected?.source || selected.status !== "completed") return;
    if (clips.length >= MAX_VIDEO_CLIPS) { setError("每个画布最多 100 个片段"); return; }
    const start = selected.startFrame ?? selected.in, end = selected.endFrame ?? selected.out - 1 / (selected.fps || 24);
    if (end <= start) { setError("尾帧必须晚于首帧"); return; }
    const point = nodePosition(selected, clips.indexOf(selected));
    await submitGeneration({ ...selected, id: crypto.randomUUID(), name: `${selected.name} · 新版本`, nodeX: point.x + 36, nodeY: point.y + 36 }, frameUrl(selected.source, start), frameUrl(selected.source, end), seconds, regenerationSettings, selectedModel);
  }
  function chooseImport(target = null) { replaceRef.current = target; uploadRef.current?.click(); }
  async function importVideo(file, target = null, point, folderId = insertionFolder()) {
    if (!file) return; setBusy(true); setError("");
    try {
      if (!target && clips.length >= MAX_VIDEO_CLIPS) throw new Error("每个画布最多 100 个片段");
      const info = await request("/api/video/import", jsonOptions("POST", { video: await fileToDataUrl(file), name: file.name.replace(/\.[^.]+$/, ""), folderId }));
      const clip = { ...(target || newDraft(crypto.randomUUID(), clips, point || canvasPoint())), source: { type: "asset", id: info.id, ext: info.url.split(".").pop() }, name: target?.name || file.name.replace(/\.[^.]+$/, ""), status: "completed", in: 0, out: info.duration, mediaDuration: info.duration, fps: info.fps, mediaWidth: info.width, mediaHeight: info.height, startFrame: null, endFrame: null, playbackRate: 1 };
      setClips(current => target ? current.map(item => item.id === target.id ? clip : item) : [...current, clip]); setSelectedIds([clip.id]); setPanel("inspect"); setMessage("视频已加入当前画布，可以裁剪和编辑。"); refreshLibrary().catch(() => {});
    } catch (cause) { setError(cause.message); } finally { setBusy(false); replaceRef.current = null; if (uploadRef.current) uploadRef.current.value = ""; }
  }
  async function addAsset(asset, target = null) {
    setContextMenu(null); setBusy(true); setError("");
    try {
      if (!target && clips.length >= MAX_VIDEO_CLIPS) throw new Error("每个画布最多 100 个片段");
      const info = await request(`/api/video/media-info?type=${asset.source.type}&id=${asset.source.id}`);
      const clip = { ...(target || newDraft(crypto.randomUUID(), clips, canvasPoint())), source: asset.source, name: target?.name || asset.name || "视频片段", status: "completed", in: 0, out: info.duration, mediaDuration: info.duration, fps: info.fps, mediaWidth: info.width, mediaHeight: info.height, startFrame: null, endFrame: null, prompt: asset.prompt || target?.prompt || "", frameAnimation: normalizeFrameAnimation(asset.frameAnimation), playbackRate: 1 };
      setClips(current => target ? current.map(item => item.id === target.id ? clip : item) : [...current, clip]); setSelectedIds([clip.id]); setPanel("inspect");
    } catch (cause) { setError(cause.message); } finally { setBusy(false); }
  }
  async function addAssets(assets) {
    setContextMenu(null); setBusy(true); setError("");
    try {
      if (clips.length + assets.length > MAX_VIDEO_CLIPS) throw new Error("每个画布最多 100 个片段");
      const info = await Promise.all(assets.map(asset => request(`/api/video/media-info?type=${asset.source.type}&id=${asset.source.id}`)));
      const point = canvasPoint(), added = [];
      assets.forEach((asset, index) => { const metadata = info[index], draft = newDraft(crypto.randomUUID(), [...clips, ...added], { x: point.x + index % 3 * 260, y: point.y + Math.floor(index / 3) * 244 }); added.push({ ...draft, source: asset.source, name: asset.name || "视频片段", status: "completed", in: 0, out: metadata.duration, mediaDuration: metadata.duration, fps: metadata.fps, mediaWidth: metadata.width, mediaHeight: metadata.height, prompt: asset.prompt || "", frameAnimation: normalizeFrameAnimation(asset.frameAnimation), playbackRate: 1 }); });
      setClips(current => [...current, ...added]); setSelectedIds(added.map(clip => clip.id)); setPanel("inspect");
    } catch (cause) { setError(cause.message); } finally { setBusy(false); }
  }
  async function dropFile(event) {
    event.preventDefault(); if (busy || locked) return;
    const assetKeys = event.dataTransfer.getData("application/x-drawpaint-video-assets");
    if (assetKeys) { try { const keys = JSON.parse(assetKeys), assets = library.filter(asset => keys.includes(assetKey(asset))); if (!assets.length || assets.some(asset => asset.status !== "completed")) throw new Error("请选择已完成的视频素材"); await addAssets(assets); } catch (cause) { setError(cause.message); } return; }
    const file = event.dataTransfer.files[0], targetId = event.target.closest(".vs-node")?.dataset.nodeId, target = clips.find(clip => clip.id === targetId);
    if (target?.locked) { setError("请先解锁目标片段"); return; }
    const point = canvasPoint(event.clientX, event.clientY);
    if (file?.type.startsWith("video/")) await importVideo(file, target || null, point);
    else if (file?.type.startsWith("image/")) { const draft = target?.status === "draft" ? target : createDraft(point); if (draft) await uploadReference(draft.id, "firstImageId", file); }
    else setError("支持拖入 MP4、WebM、MOV 视频或 PNG、JPEG、WebP 关键帧");
  }
  function mediaMetadata(id, media) {
    if (!Number.isFinite(media.duration)) return;
    setClips(current => current.map(clip => clip.id === id && (Math.abs((clip.mediaDuration || 0) - media.duration) > .1 || !clip.mediaWidth) ? { ...clip, out: clip.out === clip.mediaDuration ? media.duration : Math.min(clip.out, media.duration), mediaDuration: media.duration, mediaWidth: media.videoWidth, mediaHeight: media.videoHeight } : clip), false);
  }
  async function submitExport(options = {}) {
    setError(""); setMessage(""); setExportJob(null); setExportSubmitting(true);
    try { await saverRef.current.flush(); setExportJob(await request("/api/video/exports", jsonOptions("POST", { ...options, canvasId }))); }
    catch (cause) { setError(cause.message); } finally { setExportSubmitting(false); }
  }
  function sequence(clip = selected, frameRange = false) { setPlaying(false); setContextMenu(null); setSequenceDialog({ clipId: clip?.status === "completed" ? clip.id : null, frameRange }); }
  async function saveExportAs(job) {
    let handle, writable;
    try {
      handle = await window.showSaveFilePicker({ suggestedName: job.filename, types: job.kind === "sequence" ? [{ description: "序列帧 ZIP", accept: { "application/zip": [".zip"] } }] : [{ description: "MP4 视频", accept: { "video/mp4": [".mp4"] } }] });
      const response = await fetch(job.url); if (!response.ok || !response.body) throw new Error("无法读取导出文件");
      writable = await handle.createWritable(); await response.body.pipeTo(writable); setMessage("已保存到所选位置");
    } catch (cause) { if (writable) await writable.abort().catch(() => {}); if (cause.name !== "AbortError") setError(cause.message); }
  }
  function canSplit(clip) { return Boolean(clip?.source && !clip.locked && clip.status === "completed" && playhead > clip.position && playhead < endOf(clip)); }
  const menuClip = clips.find(clip => clip.id === contextMenu?.id);
  const menuAsset = library.find(asset => assetKey(asset) === contextMenu?.assetKey);
  const menuAssets = library.filter(asset => contextMenu?.assetKeys?.includes(assetKey(asset)));
  const menuFolder = libraryFolders.find(folder => folder.id === contextMenu?.folderId);
  const folderIsEmpty = menuFolder && !libraryFolders.some(folder => folder.parentId === menuFolder.id) && !library.some(asset => asset.folderId === menuFolder.id);
  const assetTarget = selectedIds.length === 1 && selected?.status === "draft" && !selected.locked ? selected : null;
  const menuClips = menuClip ? selectedIds.includes(menuClip.id) ? selectedClips : [menuClip] : [];
  const menuIds = menuClips.map(clip => clip.id), menuMultiple = menuClips.length > 1;
  const settingsClip = clips.find(clip => clip.id === clipSettingsId);
  const editBlocked = locked || busy || !loaded;

  return <div ref={rootRef} className="vs-shell" data-theme={theme} onKeyDown={keyboard}>
    <header className="vs-header" inert={editBlocked}><div className="vs-title"><span className="vs-logo">▶</span><strong>视频工坊</strong></div><div className="vs-header-actions">
      <IconButton icon={theme === "dark" ? "sun" : "moon"} label={theme === "dark" ? "切换浅色主题" : "切换深色主题"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")} />
      <button className={`vs-model-status ${videoModel?.ready ? "vs-online" : "vs-offline"}`} onClick={() => { setPanel("models"); setLayout(current => ({ ...current, rightCollapsed: false })); }}>{videoModel?.name || "视频模型"} · {videoModel?.ready ? "可生成" : "需设置"}</button>
      <label className="vs-size-label">画幅 <select aria-label="输出画幅" value={outputSize} onChange={event => setOutputSize(event.target.value)}>{[["640x640", "1:1 · 640"], ["960x540", "16:9 · 540p"], ["540x960", "9:16 · 540p"], ["1280x720", "16:9 · 720p"], ["720x1280", "9:16 · 720p"]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <IconButton icon="newVideo" label="新建片段" onClick={() => createDraft()} /><IconButton icon="upload" label="导入视频" onClick={() => chooseImport()} /><IconButton icon="frames" label="导出序列帧" disabled={!completed.length} onClick={() => sequence()} /><IconButton icon="download" label="导出视频" className="vs-primary" disabled={!completed.length || exportSubmitting || exportJob?.status === "running"} onClick={() => submitExport()} />
      <VideoGenerationQueue queue={generationQueue} open={queueOpen} onOpen={setQueueOpen} clips={clips} onSelect={clip => selectClip(clip)} />
    </div></header>
    {canvasToolbar}
    {sequenceError && <div className="vs-notice is-error" role="status">{sequenceError}</div>}
    <input ref={uploadRef} className="vs-hidden" type="file" accept="video/mp4,video/webm,video/quicktime,.mov" onChange={event => importVideo(event.target.files?.[0], replaceRef.current)} />
    {(error || message || exportJob) && <div className={`vs-notice ${error ? "is-error" : ""}`} role="status">{error || message || (exportJob?.status === "running" ? "正在导出…" : "")}{exportJob?.status === "completed" && <>{typeof window.showSaveFilePicker === "function" && <button className="vs-save-as" onClick={() => saveExportAs(exportJob)}>选择保存位置…</button>}<a href={exportJob.url} download={exportJob.filename}>{exportJob.kind === "sequence" ? "下载序列帧 ZIP" : "下载视频 MP4"}</a></>}{exportJob?.status === "failed" && <span>导出失败：{exportJob.error}</span>}<button aria-label="关闭提示" onClick={() => { setError(""); setMessage(""); if (exportJob?.status !== "running") setExportJob(null); }}>×</button></div>}
    <div ref={layoutRef} inert={editBlocked} className="vs-layout" style={{ gridTemplateColumns: `${leftWidth}px 7px minmax(320px,1fr) ${rightCollapsed ? 42 : 340}px` }}>
      <aside className="vs-left"><VideoLayers clips={clips} sequences={sequenceByClip} generationJobs={generationJobs} selectedIds={selectedIds} onSelect={selectClip} onMenu={openMenu} onChange={editClip} onNew={() => createDraft()} onImport={() => chooseImport()} library={library} selectedAssetKeys={selectedAssetKeys} playingAssetKey={active ? playingAssetKey : null} onSelectAsset={selectAsset} onAssetMenu={openAssetMenu} folders={libraryFolders} folderId={libraryFolder} onFolderSelect={selectFolder} onFolderMenu={openFolderMenu} onFolderDrop={dropInFolder} onNewFolder={() => newFolder()} libraryWorking={libraryWorking} onRefresh={() => { setContextMenu(null); return refreshLibrary().catch(cause => setError(cause.message)); }} libraryOpen={libraryOpen} setLibraryOpen={setLibraryOpen} /></aside>
      <div className="vs-splitter vs-splitter-vertical" role="separator" aria-label="调整片段图层宽度" aria-orientation="vertical" aria-valuenow={leftWidth} tabIndex={0} onPointerDown={event => { event.preventDefault(); gestureRef.current = { kind: "resize", axis: "left", x: event.clientX, value: leftWidth }; }} onKeyDown={event => { if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.stopPropagation(); setLayout(current => ({ ...current, leftWidth: clamp(current.leftWidth + (event.key === "ArrowRight" ? 20 : -20), 190, 420) })); } }} />
      <main ref={centerRef} className="vs-center"><section className="vs-viewer">
        <div className="vs-viewer-heading"><strong>{canvasName}</strong><div className="vs-view-mode" role="group" aria-label="画布视图"><IconButton icon="nodes" label="节点画布" aria-pressed={viewMode === "nodes"} onClick={() => { setPlaying(false); setViewMode("nodes"); }} /><IconButton icon="preview" label="时间线预览" aria-pressed={viewMode === "preview"} onClick={() => setViewMode("preview")} /></div></div>
        <div className="vs-canvas-tools" role="toolbar" aria-label="画布编辑工具"><IconButton icon="select" label="选择工具" shortcut="V" aria-pressed={tool === "select"} onClick={() => setTool("select")} /><IconButton icon="hand" label="平移工具" shortcut="H / 空格" aria-pressed={tool === "hand"} onClick={() => setTool("hand")} /><span className="vs-tool-divider" aria-hidden="true" /><IconButton icon="undo" label="撤销" disabled={!document.canUndo} onClick={document.undo} shortcut="Ctrl+Z" /><IconButton icon="redo" label="重做" disabled={!document.canRedo} onClick={document.redo} shortcut="Ctrl+Shift+Z" /><span className="vs-tool-divider" aria-hidden="true" /><IconButton icon="arrange" label="整理节点" onClick={() => setClips(current => arrangeNodes(current, selectedIds.length ? selectedIds : current.map(clip => clip.id)))} /><IconButton icon="magnet" label="吸附" aria-pressed={snap} onClick={() => setSnap(value => !value)} /><div className="vs-graph-zoom"><IconButton icon="minus" label="缩小画布" onClick={() => changeZoom(graphZoom - 10)} /><output aria-label="画布缩放比例">{graphZoom}%</output><IconButton icon="plus" label="放大画布" onClick={() => changeZoom(graphZoom + 10)} /><IconButton icon="fit" label="适应画布" className="vs-graph-fit" onClick={() => fitGraph()} /></div></div>
        {viewMode === "preview" ? <VideoTimelinePreview clips={clips} sequences={sequenceByClip} time={playhead} playing={playing} size={outputSize} /> : <div ref={graphRef} tabIndex={0} className={`vs-node-scroll ${tool === "select" ? "vs-select-tool" : ""}`} aria-label="视频节点画布" onPointerDown={beginBackground} onContextMenu={event => openMenu(event, null)} onDoubleClick={event => { if (!event.target.closest(".vs-node,button,input,select")) createDraft(canvasPoint(event.clientX, event.clientY)); }} onWheel={event => { if (event.shiftKey) setGraphPan(current => ({ x: current.x - event.deltaY, y: current.y })); else { event.preventDefault(); changeZoom(graphZoom + (event.deltaY < 0 ? 5 : -5), { x: event.clientX, y: event.clientY }); } }} onDragOver={event => event.preventDefault()} onDrop={dropFile} style={{ backgroundSize: `${24 * graphZoom / 100}px ${24 * graphZoom / 100}px`, backgroundPosition: `${graphPan.x}px ${graphPan.y}px` }}>
          {!clips.length && <div className="vs-canvas-empty"><span>▶</span><h2>建立你的第一个视频片段</h2><p>新建节点后，在右侧上传首帧并填写动作；也可拖入视频或图片。</p><div><button className="vs-primary" onClick={() => createDraft()}>＋ 新建视频片段</button><button onClick={() => chooseImport()}>导入视频</button><button onClick={() => setLibraryOpen(true)}>打开视频素材</button></div><small>双击空白处新建 · 右键打开工具 · 空格拖动平移</small></div>}
          <div className="vs-node-canvas" style={{ width: 1100, height: 800, transform: `translate(${graphPan.x}px,${graphPan.y}px) scale(${graphZoom / 100})` }}>{clips.map((clip, index) => {
            const point = nodePosition(clip, index), size = nodeSize(clip);
            return <article key={clip.id} data-node-id={clip.id} role="button" tabIndex={0} aria-label={`${clip.name}，节点预览`} aria-pressed={selectedIds.includes(clip.id)} className={`vs-node ${selectedIds.includes(clip.id) ? "is-selected" : ""} ${clip.locked ? "is-locked" : ""} ${clip.hidden ? "is-hidden" : ""}`} style={{ left: point.x, top: point.y, width: size.width, height: size.height }} onPointerDown={event => beginNode(event, clip)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); selectClip(clip); } }} onContextMenu={event => openMenu(event, clip)}>
              <div className="vs-node-header"><span className="vs-node-grip" title={clip.locked ? "已锁定" : "拖动节点"}><UiIcon name={clip.locked ? "lock" : "grip"} size={14} /></span><span className="vs-node-kind" title={clip.status === "draft" ? "待生成片段" : clip.frameAnimation?.enabled ? "帧动画视频" : "视频"}><UiIcon name={clip.status === "draft" ? "newVideo" : clip.frameAnimation?.enabled ? "frames" : "video"} size={15} /></span><strong title={clip.name}>{/^(生成视频|导入视频|视频片段|待生成视频片段|新建视频片段)$/.test(clip.name) ? "" : clip.name}</strong><span className="vs-node-track" title={`轨道 ${clip.track + 1}`}>V{clip.track + 1}</span></div><div className="vs-node-media"><NodeMedia clip={clip} sequence={sequenceByClip.get(clip.id)} enabled={active && !playing && selectedIds.length === 1 && selectedIds.includes(clip.id)} onMetadata={media => mediaMetadata(clip.id, media)} generationJob={generationJobs.get(clip.source?.id)} /></div><div className="vs-node-footer">{clip.hidden && <span title="已隐藏"><UiIcon name="hidden" size={14} /></span>}<span className="vs-node-duration" title={`片段时长 ${durationOf(clip).toFixed(2)} 秒${clipRate(clip) !== 1 ? `，播放速度 ${clipRate(clip)} 倍` : ""}`}><UiIcon name="clock" size={12} />{durationOf(clip).toFixed(2)}s{clipRate(clip) !== 1 && <small>{clipRate(clip)}×</small>}</span></div>
            </article>;
          })}</div>{marquee && <div className="vs-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }} />}
        </div>}
        <div className="vs-canvas-hint">{selectedIds.length ? `已选 ${selectedIds.length} 个片段 · Ctrl / Shift 多选 · Delete 移除` : "框选片段 · 双击新建 · 拖入视频或关键帧"}</div>
        {viewMode === "preview" && <div className="vs-transport"><IconButton icon="rewind" label="回到开头" onClick={() => { setPlaying(false); setPlayhead(0); }} /><IconButton icon={playing ? "pause" : "play"} label={playing ? "暂停" : "播放时间线"} className="vs-play" onClick={() => { if (playhead >= total) setPlayhead(0); setPlaying(value => !value); }} /><IconButton icon="next" label="下一帧" onClick={() => { setPlaying(false); setPlayhead(Math.min(total, playhead + 1 / 24)); }} /><span>{timeLabel(playhead)} / {timeLabel(total)}</span></div>}
      </section>
      <div className="vs-splitter vs-splitter-horizontal" role="separator" aria-label="调整时间线高度" aria-orientation="horizontal" aria-valuenow={timelineHeight} tabIndex={0} onPointerDown={event => { event.preventDefault(); gestureRef.current = { kind: "resize", axis: "timeline", y: event.clientY, value: timelineHeight }; }} />
      <section className="vs-timeline-section" style={{ height: timelineHeight, "--track-height": `${TRACK_HEIGHT}px`, "--tracks-height": `${VIDEO_TRACKS * TRACK_HEIGHT}px`, "--time-grid": `${zoom}px` }}><div className="vs-timeline-toolbar"><strong>时间线</strong><button disabled={!canSplit(selected)} onClick={() => splitClip()}>分割</button>{unavailable.length > 0 && <span>{unavailable.length} 个片段待就绪，导出时跳过</span>}<label>缩放<input aria-label="时间线缩放" type="range" min="25" max="120" step="5" value={zoom} onChange={event => setZoom(Number(event.target.value))} /></label></div>
        <div ref={timelineRef} className="vs-timeline-scroll"><div className="vs-timeline-inner" style={{ width: timelineWidth }}><div className="vs-ruler" onPointerDown={event => { setPlaying(false); setPlayhead(clamp(roundFrame((event.clientX - event.currentTarget.getBoundingClientRect().left) / zoom), 0, total)); }}>{Array.from({ length: Math.ceil(timelineWidth / zoom) }, (_, i) => <span key={i} style={{ left: i * zoom }}>{i}s</span>)}</div><div ref={lanesRef} className="vs-lanes">{Array.from({ length: VIDEO_TRACKS }, (_, i) => <div className="vs-lane" key={i}><span className="vs-lane-label">V{i + 1}</span></div>)}{clips.map(clip => <div key={clip.id} role="button" tabIndex={0} aria-label={`${clip.name}，轨道 ${clip.track + 1}`} aria-pressed={selectedIds.includes(clip.id)} className={`vs-clip ${selectedIds.includes(clip.id) ? "is-selected" : ""} ${clip.status !== "completed" ? "is-pending" : ""} ${clip.hidden ? "is-hidden" : ""} ${clip.locked ? "is-locked" : ""}`} style={{ left: clip.position * zoom, top: clip.track * TRACK_HEIGHT + TRACK_INSET, width: Math.max(20, durationOf(clip) * zoom) }} onPointerDown={event => beginTimeline(event, clip, "move")} onKeyDown={event => { if (event.key === "Enter") selectClip(clip, "timeline"); }} onContextMenu={event => openMenu(event, clip)}><span className="vs-trim" onPointerDown={event => beginTimeline(event, clip, "left")} /><span className="vs-clip-title">{clip.locked ? "▣ " : clip.status === "draft" ? "＋ " : "▶ "}{clip.name}</span><span className="vs-clip-time">{durationOf(clip).toFixed(1)}s</span><span className="vs-trim" onPointerDown={event => beginTimeline(event, clip, "right")} /></div>)}<div className="vs-playhead" style={{ left: playhead * zoom }} /></div></div></div>
      </section></main>
      <aside className={`vs-right ${rightCollapsed ? "is-collapsed" : ""}`}><button className="vs-right-toggle" aria-label={rightCollapsed ? "展开片段详情" : "收起片段详情"} aria-expanded={!rightCollapsed} onClick={() => setLayout(current => ({ ...current, rightCollapsed: !current.rightCollapsed }))}>{rightCollapsed ? "◀" : "▶"}</button><div className="vs-right-tabs"><button className={panel === "inspect" ? "is-current" : ""} onClick={() => setPanel("inspect")}>选中详情</button><button className={panel === "models" ? "is-current" : ""} onClick={() => setPanel("models")}>模型设置</button></div>
        {panel === "models" && <VideoModelSetup setup={setup} selectedModel={selectedModel} onSelect={id => { setSelectedModel(id); if (selected?.status === "draft") { const choice = setup?.models.find(model => model.id === id), length = choice?.durations[0] || 2; editClip(selected.id, { modelId: id, in: 0, out: length, mediaDuration: length, lastImageId: null }); } const choice = setup?.models.find(model => model.id === id); if (choice && !choice.durations.includes(seconds)) setSeconds(choice.durations[0]); }} onRefresh={() => refreshSetup().catch(cause => setError(cause.message))} onStart={async () => { setStartingModel(true); try { setSetup(await request("/api/video/start", { method: "POST" })); } catch (cause) { setError(cause.message); } finally { setStartingModel(false); } }} starting={startingModel} />}
        {panel === "inspect" && selectedIds.length > 1 && <section className="vs-properties"><h2>已选 {selectedIds.length} 个片段</h2><p className="vs-property-note">右键所选片段可复制、整理、锁定或移除。</p>{selectedDrafts.length > 0 && <><button type="button" className="vs-primary" disabled={busy} onClick={generateSelection}>{busy ? "正在加入队列…" : `将 ${selectedDrafts.length} 个待生成片段加入队列`}</button><p className="vs-property-note">使用各片段的首尾图、动作描述和模型，按画布片段顺序提交。</p></>}<label>统一轨道<select aria-label="多选片段轨道" defaultValue="" onChange={event => bulkChange({ track: Number(event.target.value) })}><option disabled value="">选择轨道…</option>{Array.from({ length: VIDEO_TRACKS }, (_, i) => <option key={i} value={i}>V{i + 1}</option>)}</select></label></section>}
        {panel === "inspect" && selectedIds.length === 1 && selected && <section className="vs-selected-editor" aria-label="所选片段编辑"><VideoClipHeading clip={selected} generationJob={selectedGenerationJob} onChange={patch => editClip(selected.id, patch)} onBegin={document.begin} onEnd={document.end} />
          {selected.status === "draft" || (selected.status === "running" && selected.firstImageId) ? <VideoDraftEditor key={selected.id} clip={selected} generationJob={selectedGenerationJob} setup={setup} busy={busy} onChange={patch => editClip(selected.id, patch)} onImage={(key, value) => uploadReference(selected.id, key, value)} onGenerate={() => generateDraft(selected)} onModels={() => setPanel("models")} onImport={() => chooseImport(selected)} onLibrary={() => setLibraryOpen(true)} onBegin={document.begin} onEnd={document.end} /> : <VideoInspector key={selected.id} selected={selected} sequence={selectedSequence} frameTime={frameTime} setFrameTime={setFrameTime} setPlayhead={setPlayhead} setPlaying={setPlaying} playing={playing} updateClip={editClip} prompt={selected.prompt || ""} setPrompt={value => editClip(selected.id, { prompt: value })} seconds={seconds} setSeconds={setSeconds} regenerate={regenerate} busy={busy} ready={Boolean(videoModel?.ready && videoModel.supportsEndFrame)} videoModel={videoModel} createFrameAnimation={() => sequence(selected, true)} generationSettings={regenerationSettings} setGenerationSettings={setRegenerationSettings} onBegin={document.begin} onEnd={document.end} />}
        </section>}
        {panel === "inspect" && !selectedIds.length && <div className="vs-empty-inspector"><h2>画布详情</h2><p>选择片段以预览动画、修改名称和首尾帧。其他参数可在右键“片段设置”中调整。</p><button className="vs-primary" onClick={() => createDraft()}>＋ 新建视频片段</button><button onClick={() => chooseImport()}>导入已有视频</button><small>Ctrl+Z 撤销 · Ctrl+D 复制 · Delete 移除</small></div>}
      </aside>
    </div>
    {contextMenu && <div ref={menuRef} className="vs-context-menu" role="menu" aria-label={contextMenu.folderMenu ? "素材文件夹操作" : menuAsset ? "视频素材操作" : menuClip ? "视频片段操作" : "画布工具"} style={{ left: contextMenu.x, top: contextMenu.y }} onContextMenu={event => event.preventDefault()}>
      {contextMenu.folderMenu ? <><button role="menuitem" disabled={libraryWorking} onClick={() => newFolder(contextMenu.folderId)}>新建子文件夹</button>{menuFolder && <><button role="menuitem" disabled={libraryWorking} onClick={() => { setLibraryDialog({ kind: "rename-folder", id: menuFolder.id, name: menuFolder.name }); setContextMenu(null); }}>重命名文件夹</button><button role="menuitem" disabled={libraryWorking} onClick={() => { setLibraryDialog({ kind: "move-folder", id: menuFolder.id, parentId: menuFolder.parentId }); setContextMenu(null); }}>移动文件夹…</button><button role="menuitem" disabled={libraryWorking || !folderIsEmpty} onClick={() => changeLibrary({ action: "delete-folder", id: menuFolder.id }).catch(cause => setError(cause.message))}>移除空文件夹</button></>}</> : menuAsset ? <>
        {menuAssets.length === 1 && <button role="menuitem" disabled={menuAsset.status !== "completed"} onClick={() => { setPlayingAssetKey(current => current === assetKey(menuAsset) ? null : assetKey(menuAsset)); setContextMenu(null); }}>{playingAssetKey === assetKey(menuAsset) ? "暂停预览" : "循环预览"}</button>}
        <button role="menuitem" disabled={menuAssets.some(asset => asset.status !== "completed")} onClick={() => addAssets(menuAssets)}>{menuAssets.length > 1 ? "添加所选到画布" : "添加到画布"}</button>
        {assetTarget && menuAssets.length === 1 && <button role="menuitem" disabled={menuAsset.status !== "completed"} onClick={() => addAsset(menuAsset, assetTarget)}>填入所选片段</button>}
        {menuAssets.length === 1 && <button role="menuitem" disabled={libraryWorking} onClick={() => { setLibraryDialog({ kind: "rename-asset", key: assetKey(menuAsset), name: menuAsset.name }); setContextMenu(null); }}>重命名素材</button>}
        <button role="menuitem" disabled={libraryWorking} onClick={() => { setLibraryDialog({ kind: "move-assets", keys: menuAssets.map(assetKey), parentId: menuAsset.folderId }); setContextMenu(null); }}>移动到文件夹…</button>
      </> : <><strong className="vs-context-title">{menuMultiple ? `已选 ${menuClips.length} 个片段` : menuClip?.name || "画布工具"}</strong>{menuClip ? <>
        {!menuMultiple && <button role="menuitem" onClick={() => { setClipSettingsId(menuClip.id); setContextMenu(null); }}>片段设置</button>}
        <button role="menuitem" onClick={() => duplicateSelection(menuClips)}>复制所选片段</button><button role="menuitem" onClick={() => copySelection(menuClips)}>复制到剪贴板</button>
        {!menuMultiple && <button role="menuitem" disabled={!canSplit(menuClip)} onClick={() => splitClip(menuClip)}>在播放头处分割</button>}
        <button role="menuitem" onClick={() => { setClips(current => arrangeNodes(current, menuIds)); setContextMenu(null); }}>整理所选节点</button><button role="menuitem" onClick={() => { fitGraph(menuIds); setContextMenu(null); }}>适应所选节点</button>
        <button role="menuitem" onClick={() => { bulkChange({ locked: !menuClips.every(clip => clip.locked) }, menuIds); setContextMenu(null); }}>{menuClips.every(clip => clip.locked) ? "解锁" : "锁定"}{menuMultiple ? "所选片段" : "片段"}</button><button role="menuitem" onClick={() => { bulkChange({ hidden: !menuClips.every(clip => clip.hidden) }, menuIds); setContextMenu(null); }}>{menuClips.every(clip => clip.hidden) ? "显示" : "隐藏"}{menuMultiple ? "所选片段" : "片段"}</button>
        {!menuMultiple && <><button role="menuitem" disabled={menuClip.locked} onClick={() => { chooseImport(menuClip); setContextMenu(null); }}>替换视频来源</button><button role="menuitem" disabled={menuClip.status !== "completed"} onClick={() => { submitExport({ clipId: menuClip.id }); setContextMenu(null); }}>导出片段 MP4</button><button role="menuitem" disabled={menuClip.status !== "completed"} onClick={() => sequence(menuClip)}>导出序列帧动画</button></>}
        <button role="menuitem" className="vs-context-delete" disabled={menuClips.every(clip => clip.locked)} onClick={() => removeSelection(menuIds)}>移除所选片段</button>
      </> : <><button role="menuitem" onClick={() => createDraft(contextMenu.point)}>新建视频片段</button><button role="menuitem" onClick={() => { chooseImport(); setContextMenu(null); }}>导入视频</button><button role="menuitem" onClick={() => { setLibraryOpen(true); setContextMenu(null); }}>打开视频素材</button><button role="menuitem" disabled={!clipboard.current.length} onClick={() => duplicateSelection(clipboard.current, true)}>粘贴片段</button><button role="menuitem" onClick={() => { setClips(current => arrangeNodes(current, current.map(clip => clip.id))); setContextMenu(null); }}>整理全部节点</button><button role="menuitem" onClick={() => { fitGraph(); setContextMenu(null); }}>适应全部节点</button></>}</>}
    </div>}
    {libraryDialog && <VideoLibraryDialog key={`${libraryDialog.kind}:${libraryDialog.id || libraryDialog.key || ""}`} action={libraryDialog} folders={libraryFolders} working={libraryWorking} onSubmit={async action => { await changeLibrary(action); setLibraryDialog(null); }} onClose={() => setLibraryDialog(null)} />}
    {settingsClip && <VideoClipSettings key={settingsClip.id} clip={settingsClip} index={clips.indexOf(settingsClip)} onChange={patch => editClip(settingsClip.id, patch)} onBegin={document.begin} onEnd={document.end} onClose={() => { document.end(); setClipSettingsId(null); }} />}
    {sequenceDialog && <VideoSequenceExport clips={clips} initialClipId={sequenceDialog.clipId} initialFrameRange={sequenceDialog.frameRange} job={exportJob?.kind === "sequence" ? exportJob : null} submitting={exportSubmitting || exportJob?.status === "running"} onExport={submitExport} onClose={() => setSequenceDialog(null)} onSave={saveExportAs} error={error} />}
  </div>;
});
