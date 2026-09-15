import { useCallback, useEffect, useRef, useState } from "react";
import { Tldraw, getSnapshot, loadSnapshot } from "tldraw";
import { uiApi, dataUrl, assetUrl, jobStateLabel } from "./api.js";
import { insertJob, removeRedundantAtlases, locateJob, selectUiNode, placeJobBesideSource } from "./canvas.js";
import ReviewDialog from "./ReviewDialog.jsx";
import LayerPanel from "./LayerPanel.jsx";
import ResizableLayers from "./ResizableLayers.jsx";
import { UiRefineContext, uiComponents } from "./UiContextMenu.jsx";
import { installCtrlWheelZoom, uiCameraOptions } from "./wheel-zoom.js";
import "./ui-studio.css";
import "./theme.css";
import MockupWorkflow, { PlanDialog, CompareDialog } from "./MockupWorkflow.jsx";
import MaskReviewDialog from "./MaskReviewDialog.jsx";
import DeliveryDialog from "./DeliveryDialog.jsx";
import { loadSplitOptions, splitStorageKey, sourcePixelMode } from "../../shared/split-options.mjs";
import { isolatePanelKey, blurCanvasForPanel } from "./panel-events.js";
import { canvasResult, orphanedCanvasDelivery } from "../../shared/ui-delivery.mjs";

const defaults = { removeBackground: true, autoSplit: true, background: "#ff00ff", removalMode: "color", tolerance: 24, feather: 8, minArea: 12, padding: 2 };
const working = job => ["queued", "generating", "processing", "agent_dispatching", "agent_queued", "agent_generating", "agent_unknown"].includes(job.status);
const accepted = "image/png,image/jpeg,image/webp";
const promptPresets = [
  { label: "风格界面", mockup: "生成一张【风格】的【界面类型】游戏界面，包含【主要内容】，布局清晰，风格统一。", atlas: "生成一组【风格】的游戏 UI 素材，包含【组件清单】，各组件独立排列，风格统一。" },
  { label: "主菜单", mockup: "生成一张【风格】游戏主菜单，包含游戏标题、开始游戏、继续游戏、设置和退出按钮，突出主操作。", atlas: "生成一组【风格】主菜单素材：游戏标题、开始游戏、继续游戏、设置和退出按钮，各组件独立排列。" },
  { label: "游戏 HUD", mockup: "生成一张【风格】游戏 HUD 界面，包含头像、生命条、资源计数、小地图和技能栏，中央保留游戏视野。", atlas: "生成一组【风格】游戏 HUD 素材：头像框、生命条、资源计数器、小地图框和技能按钮，各组件独立排列。" },
  { label: "背包", mockup: "生成一张【风格】背包界面，包含物品网格、分类标签、物品详情和使用按钮，选中状态清晰。", atlas: "生成一组【风格】背包 UI 素材：物品格、分类标签、详情面板和使用按钮，包含选中与未选中状态，各组件独立排列。" },
  { label: "按钮图标", mockup: "生成一张【风格】按钮与图标展示界面，包含【按钮文字与图标清单】，展示正常、悬停和选中状态，尺寸与配色统一。", atlas: "生成一组【风格】按钮与图标素材，包含【按钮文字与图标清单】，展示正常、悬停和选中状态，各组件独立排列。" },
];
const sourceFile = job => job.sourceFile || (job.operation === "decompose" ? job.references?.[0] : null);
const uiAssets = { async upload(_asset, file) { return uiApi("uploads", { dataUrl: await dataUrl(file) }); }, resolve(asset) { return asset.props.src; } };

function ProcessingOptions({ options, setOptions, compact = false }) {
  const change = (key, value) => setOptions(current => ({ ...current, [key]: value }));
  return <div className="uis-processing-options">
    <div className="uis-switches"><label><input type="checkbox" checked={options.removeBackground} onChange={e => change("removeBackground", e.target.checked)} />移除背景</label>
      <label><input type="checkbox" checked={options.autoSplit} onChange={e => change("autoSplit", e.target.checked)} />按组件切图</label></div>
    <p className="uis-hint">先按外轮廓提取组件；再从左侧图层树选中节点，使用「拆分」分离内部元素。</p>
    <details open={compact || undefined}><summary>切图参数</summary>
      <div className="uis-fields"><label>背景颜色<select value={options.background} onChange={e => change("background", e.target.value)}>
        <option value="auto">自动检测</option><option value="#ff00ff">品红色</option><option value="#ffffff">白色</option><option value="#000000">黑色</option><option value="#00ff00">绿色</option><option value="#e5e7eb">浅灰色</option>
      </select></label><label>去背景方式<select value={options.removalMode} onChange={e => change("removalMode", e.target.value)}>
        <option value="edge">从外部移除</option><option value="color">移除全部同色区域</option></select></label>
        {[ ["tolerance", "颜色容差", 0, 150], ["feather", "边缘过渡", 0, 60], ["minArea", "最小面积 / 像素", 1, 10000], ["padding", "切片留边 / 像素", 0, 100] ].map(([key, label, min, max]) =>
          <label key={key}>{label}<input type="number" min={min} max={max} value={options[key]} onChange={e => change(key, Number(e.target.value))} /></label>)}
      </div><p className="uis-hint">纯色图集适合自动拆分。浅色图案建议从外部移除；空心边框可移除同色区域。实际透明图集保留原透明度。</p>
    </details>
  </div>;
}

export default function UiStudio() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem("drawpaint.ui-studio.theme") === "light" ? "light" : "dark"; }
    catch { return "dark"; }
  });
  const [canvasBackground, setCanvasBackground] = useState(() => {
    try {
      const saved = localStorage.getItem("drawpaint.ui-studio.canvas-background");
      return /^#[0-9a-f]{6}$/i.test(saved || "") ? saved : "#f3f5fa";
    } catch { return "#f3f5fa"; }
  });
  useEffect(() => {
    try { localStorage.setItem("drawpaint.ui-studio.canvas-background", canvasBackground); } catch { /* Keep the setting usable without storage. */ }
  }, [canvasBackground]);
  const [diagnosticJobId,setDiagnosticJobId]=useState(null);
  const editorRef = useRef(null);
  const readyRef = useRef(false);
  const jobsRef = useRef([]);
  const inserted = useRef(new Set());
  const saving = useRef(Promise.resolve());
  const snapshotRevision = useRef(0);
  const saveBlocked = useRef(false);
  const [loadError, setLoadError] = useState("");
  const [saveConflict, setSaveConflict] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [editor, setEditor] = useState(null);
  useEffect(() => {
    editor?.user.updateUserPreferences({ colorScheme: theme });
    try { localStorage.setItem("drawpaint.ui-studio.theme", theme); } catch { /* Theme remains usable without storage. */ }
  }, [editor, theme]);
  const [jobs, setJobs] = useState([]);
  const [agent, setAgent] = useState(null);
  const [kind, setKind] = useState("generate");
  const [workflow, setWorkflow] = useState("mockup");
  const [planDialog, setPlanDialog] = useState(null), [compareJob, setCompareJob] = useState(null);
  const [maskJob, setMaskJob] = useState(null);
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState("2048x1152");
  const [quality, setQuality] = useState("medium");
  const submitting = useRef(false);
  const [options, setOptions] = useState(defaults);
  const [references, setReferences] = useState([]);
  const [source, setSource] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessageText] = useState("");
  const [messageJobId, setMessageJobId] = useState(null);
  const setMessage = useCallback(text => { setMessageText(text); setMessageJobId(null); }, []);
  const [saveStatus, setSaveStatus] = useState("正在加载 UI 画布…");
  const [review, setReview] = useState(null);
  const [processJob, setProcessJob] = useState(null);
  const [processOptions, setProcessOptions] = useState(defaults);
  const [selectedId, setSelectedId] = useState(null);
  const [ready, setReady] = useState(false);
  const draftLoaded = useRef(false);
  const [canvasReady, setCanvasReady] = useState(false);
  const [refineTarget, setRefineTarget] = useState(null);
  const [splitOptions, setSplitOptions] = useState(() => loadSplitOptions(localStorage));
  const [splitSaveError, setSplitSaveError] = useState("");
  useEffect(() => {
    try { localStorage.setItem(splitStorageKey,JSON.stringify(splitOptions)); setSplitSaveError(""); }
    catch { setSplitSaveError("浏览器无法保存配置，本次选择仍可使用。"); }
  }, [splitOptions]);
  useEffect(() => editor ? installCtrlWheelZoom(editor) : undefined, [editor]);
  const openRefine = useCallback(target => {
    setRefineTarget(target);
    setMessage("");
    setMessageJobId(null);
  }, []);

  useEffect(() => {
    try {
      const draft = JSON.parse(localStorage.getItem("drawpaint.ui-studio.draft") || "null");
      if (draft) { setPrompt(draft.prompt || ""); setSize(draft.size || "2048x1152"); setQuality(draft.quality || "medium"); setWorkflow(draft.workflow || "mockup"); }
    } catch { /* Ignore an outdated draft. */ }
    draftLoaded.current = true;
  }, []);
  useEffect(() => {
    if (!draftLoaded.current) return;
    localStorage.setItem("drawpaint.ui-studio.draft", JSON.stringify({ prompt, size, quality, workflow }));
  }, [prompt, size, quality, workflow]);

  const persist = useCallback(ed => {
    if (saveBlocked.current) return Promise.resolve();
    const snapshot = getSnapshot(ed.store);
    setSaveStatus("正在保存…");
    const importedRevisions = [...inserted.current];
    const request = saving.current.catch(() => {}).then(async () => {
      if (saveBlocked.current) return;
      const result = await uiApi("snapshot", { ...snapshot, importedRevisions, baseRevision: snapshotRevision.current });
      snapshotRevision.current = result.revision;
    });
    saving.current = request;
    request.then(() => { if (!saveBlocked.current) { setSaveStatus("UI 画布已保存"); setSaveError(""); } }).catch(e => {
      if (e.status === 409) { saveBlocked.current = true; setSaveConflict(true); }
      else setSaveError(e.message);
      setSaveStatus(`保存失败：${e.message}`);
    });
    return request;
  }, []);

  const mount = useCallback(ed => {
    let disposed = false, initialized = false, timeout, sessionTimer, dirty = false;
    readyRef.current = false; setCanvasReady(false); setLoadError("");
    editorRef.current = ed; setEditor(ed);
    uiApi("snapshot").then(snapshot => {
      if (disposed) return;
      let session = snapshot.session;
      try { session = JSON.parse(sessionStorage.getItem("drawpaint.ui-studio.view") || "null") || session; } catch { /* Use the saved server view. */ }
      if (snapshot.document) loadSnapshot(ed.store, { document: snapshot.document, session }, { forceOverwriteSessionState: true });
      // Loading is a baseline, not an edit. Otherwise Undo after a reload can
      // restore the empty editor created before the saved document was loaded.
      ed.clearHistory();
      snapshotRevision.current = snapshot.revision || 0;
      inserted.current.clear(); saveBlocked.current = false; setSaveConflict(false);
      for (const revision of snapshot.importedRevisions || []) inserted.current.add(revision);
      for (const shape of ed.store.allRecords()) if (shape.meta?.uiRevision) inserted.current.add(`${shape.meta.uiJobId}/${shape.meta.uiRevision}`);
      initialized = true; readyRef.current = true; setCanvasReady(true); setSaveStatus("UI 画布已保存");
    }).catch(e => { if (!disposed) { setLoadError(e.message); setSaveStatus("画布尚未加载，已暂停保存"); } });
    const unsubscribe = ed.store.listen(() => {
      if (!initialized || disposed) return;
      dirty = true;
      clearTimeout(timeout); timeout = setTimeout(() => { dirty = false; persist(ed); }, 450);
    }, { scope: "document", source: "all" });
    const saveView = () => {
      if (!initialized) return;
      try { sessionStorage.setItem("drawpaint.ui-studio.view", JSON.stringify(getSnapshot(ed.store).session)); } catch { /* The document remains saved on the server. */ }
    };
    const unsubscribeSession = ed.store.listen(() => {
      if (!initialized || disposed) return;
      clearTimeout(sessionTimer); sessionTimer = setTimeout(saveView, 200);
    }, { scope: "session", source: "all" });
    return () => {
      saveView(); disposed = true; unsubscribe(); unsubscribeSession(); clearTimeout(timeout); clearTimeout(sessionTimer);
      if (initialized && dirty) persist(ed);
      readyRef.current = false; setCanvasReady(false); editorRef.current = null;
    };
  }, [persist]);

  function backupCanvas() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(getSnapshot(editor.store), null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "ui-canvas-backup.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const refresh = useCallback(async () => {
    const result = await uiApi("jobs"); jobsRef.current = result.jobs; setJobs(result.jobs); setReady(true);
    setAgent(result.agent || { connected: false }); return result.jobs;
  }, []);
  useEffect(() => {
    let stopped = false, timer;
    const poll = async () => { try { if (!stopped) await refresh(); } catch (e) { if (!stopped) setMessage(e.message); }
      if (!stopped) timer = setTimeout(poll, 1800); };
    poll(); return () => { stopped = true; clearTimeout(timer); };
  }, [refresh]);
  useEffect(() => {
    if (!canvasReady || !editor) return;
    removeRedundantAtlases(editor);
  }, [editor, canvasReady]);
  useEffect(() => {
    if (!canvasReady || !editor) return;
    for (const rawJob of [...jobs].reverse()) {
      const job=canvasResult(rawJob);
      const key = `${job.id}/${job.revision}`;
      const promote=job.status === "ready" && !job.canvasCandidate && editor.store.allRecords().some(s=>s.meta?.uiJobId===job.id && s.meta.uiRevision===job.revision && s.meta.uiCandidate);
      if ((job.status === "ready" || job.canvasCandidate && job.status !== "cancelled") && job.slices?.length && (!inserted.current.has(key) || promote || orphanedCanvasDelivery(job,editor.store.allRecords()))) {
        try { insertJob(editor, job); inserted.current.add(key); setSelectedId(job.id); }
        catch (e) { setMessage(`素材回填失败：${e.message}`); }
      }
    }
  }, [jobs, editor, canvasReady]);

  async function run(fn) {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setMessage(""); setMessageJobId(null);
    try { return await fn(); } catch (e) { setMessage(e.message); }
    finally { submitting.current = false; setBusy(false); }
  }
  async function executeGeneration(request) {
    const job = await uiApi(request.jobId ? `jobs/${request.jobId}/dispatch` : "jobs", request.jobId ? {} : request);
    setSelectedId(job.id);
    setMessage(job.error || (job.status === "awaiting_agent" ? "任务已保存，连接 Agent 后在任务记录中启动。" : job.kind === "generate" ? "已提交到独立 Agent 新对话，对话将保留供检查；可在任务记录检查回填链路。" : "任务已开始，可在任务记录检查处理和回填结果。"));
    await refresh();
  }
  async function submit() {
    await run(async () => {
      if (kind === "extract" && !source) throw new Error("请先选择需要切图的 UI 图集");
      const request = { kind, workflow, provider: "agent", dispatch: kind === "generate" && Boolean(agent?.connected), prompt: kind === "extract" ? source?.name : prompt, size, quality, options, dataUrl: source?.dataUrl, references: references.map(r => r.dataUrl) };
      await executeGeneration(request);
    });
  }
  async function pickFiles(event, target) {
    const files = [...(event.target.files || [])]; event.target.value = "";
    await run(async () => {
      if (target === "reference" && references.length + files.length > 4) throw new Error("最多添加 4 张参考图");
      const images = await Promise.all(files.map(async file => ({ name: file.name, dataUrl: await dataUrl(file) })));
      if (target === "source") setSource(images[0] || null); else setReferences(current => [...current, ...images]);
    });
  }
  async function useSelectedImage() {
    await run(async () => {
      const shapes = editor?.getSelectedShapes();
      if (shapes?.length !== 1 || shapes[0].type !== "image") throw new Error("请在 UI 画布中选择一张图集");
      const asset = editor.getAsset(shapes[0].props.assetId);
      const response = await fetch(asset.props.src);
      if (!response.ok) throw new Error("无法读取所选图片");
      setSource({ name: asset.props.name, dataUrl: await dataUrl(await response.blob()) });
    });
  }
  const selectedJob = jobs.find(job => job.id === selectedId) || jobs[0];
  const messageJob = jobs.find(job => job.id === messageJobId);
  const displayedMessage = messageJob ? (messageJob.error || (messageJob.operation === "plan" && messageJob.status === "ready"
    ? messageJob.continuationError ? `继续拆分失败：${messageJob.continuationError}` : messageJob.continuationId ? "方案已完成，正在继续图片拆分；完成后自动显示候选图层，可在画布检查。" : messageJob.autoContinue ? "方案已完成，正在准备图片拆分。" : `方案已完成，共 ${messageJob.regions?.length || 0} 个图层，尚未生成图片。`
    : jobStateLabel(messageJob))) : message;
  return <div className="uis-shell" data-theme={theme} onKeyDown={isolatePanelKey} onKeyUp={isolatePanelKey} onPointerDownCapture={event=>blurCanvasForPanel(event,editor)} onFocusCapture={event=>blurCanvasForPanel(event,editor)}>
    <header className="uis-header"><div><span className="uis-logo">▦</span><strong>素材工坊</strong><span className="uis-badge">独立模式</span></div><span className="uis-save-status">{saveStatus}</span>
      <div className="uis-background-setting" role="group" aria-label="画布底板颜色">
        <button className="uis-theme-toggle" type="button" aria-label={theme === "dark" ? "切换浅色主题" : "切换深色主题"} title={theme === "dark" ? "切换浅色主题" : "切换深色主题"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? "☀" : "☾"}</button>
        <span>底板</span>
        <select aria-label="画布底板预设" value={["#f3f5fa", "#ffffff", "#808080", "#252830", "#000000"].includes(canvasBackground) ? canvasBackground : "custom"} onChange={event => { if (event.target.value !== "custom") setCanvasBackground(event.target.value); }}>
          <option value="#f3f5fa">默认</option><option value="#ffffff">白色</option><option value="#808080">灰色</option><option value="#252830">深色</option><option value="#000000">黑色</option><option value="custom" disabled>自定义</option>
        </select>
        <input type="color" aria-label="自定义画布底板颜色" title="自定义底板颜色" value={canvasBackground} onChange={event => setCanvasBackground(event.target.value)} />
      </div>
      <span className="uis-badge">{agent?.connected ? "Agent 已连接" : "Agent 待连接"}</span></header>
    <div className="uis-layout"><ResizableLayers><LayerPanel jobs={jobs} editor={editor} ready={canvasReady} busy={busy} onSelect={setSelectedId} onError={setMessage}
      onRefine={openRefine} onRefresh={refresh} /></ResizableLayers><main className="uis-workspace">
      <div className="uis-canvas" style={{ "--uis-canvas-background": canvasBackground }} data-testid="ui-material-canvas"><UiRefineContext.Provider value={{ jobs, busy, ready: canvasReady, onRefine: openRefine }}><Tldraw onMount={mount} assets={uiAssets} components={uiComponents} cameraOptions={uiCameraOptions} /></UiRefineContext.Provider></div>
      {loadError && <div className="uis-recovery" role="alert"><strong>画布未加载成功</strong><p>{loadError}</p><button onClick={() => location.reload()}>重新加载画布</button></div>}
      {saveConflict && <div className="uis-recovery" role="alert"><strong>另一窗口保存了新版画布，本窗口已暂停保存</strong><button onClick={backupCanvas}>下载当前画布备份</button><button onClick={() => location.reload()}>加载最新画布</button></div>}
      {saveError && !saveConflict && <div className="uis-recovery" role="alert"><strong>当前修改尚未保存</strong><p>{saveError}</p><button onClick={backupCanvas}>下载当前画布备份</button><button onClick={() => persist(editor)}>重试保存</button></div>}
      {ready && jobs.length === 0 && <div className="uis-empty"><div className="uis-empty-mark">✦</div><h1>从一张效果图，搭出完整界面</h1><p>先确定整体效果，再校正拆解方案。<br />独立组件验收后拼回，继续编辑并导出。</p><div><span>01 效果图</span><b>→</b><span>02 拆组件</span><b>→</b><span>03 拼回界面</span></div></div>}
      {selectedJob && <div className="uis-current"><span className={`uis-dot ${working(selectedJob) ? "is-working" : ""}`} /><strong>{jobStateLabel(selectedJob)}</strong>
        <span>{selectedJob.slices ? `${selectedJob.slices.length} 个组件` : "UI 素材任务"}</span>
        {selectedJob.status === "ready" && selectedJob.slices?.length && selectedJob.operation !== "decompose" && selectedJob.workflow !== "mockup" && <button onClick={() => setReview(selectedJob)}>校正切片</button>}
        {selectedJob.exportFile && <a href={assetUrl(selectedJob, selectedJob.exportFile)} download>下载素材包</a>}
        {selectedJob.slices && <button disabled={!canvasReady} onClick={() => locateJob(editor, selectedJob)}>定位素材（跨页）</button>}
      </div>}
    </main><aside className="uis-sidebar">
      <div className="uis-tabs" role="tablist" aria-label="生成流程"><button role="tab" aria-selected={workflow === "mockup"} onClick={() => setWorkflow("mockup")}>效果图拆解</button><button role="tab" aria-selected={workflow === "atlas"} onClick={() => setWorkflow("atlas")}>素材图集</button></div>
      <div className="uis-tabs" role="tablist" aria-label="UI 素材操作"><button role="tab" aria-selected={kind === "generate"} onClick={() => { setKind("generate"); setOptions(defaults); }}>生成 UI</button>
        <button role="tab" aria-selected={kind === "extract"} onClick={() => { setKind("extract"); setOptions({ ...defaults, background: "auto", removalMode: "edge" }); }}>{workflow === "mockup" ? "导入效果图" : "提取 UI"}</button></div>
      <div className="uis-form">
        {kind === "generate" ? <>
          <label>描述<textarea aria-label="UI 素材提示词" rows={4} value={prompt} maxLength={12000} onChange={e => setPrompt(e.target.value)} placeholder="输入内容与风格…" /></label>
          <div className="uis-prompt-presets" role="group" aria-label="描述预设">{promptPresets.map(preset => <button type="button" key={preset.label} title={`填入${preset.label}预设`} onClick={event => {
            setPrompt(preset[workflow === "mockup" ? "mockup" : "atlas"]);
            const input = event.currentTarget.closest(".uis-form").querySelector('textarea[aria-label="UI 素材提示词"]');
            input?.focus();
            requestAnimationFrame(() => { const start = input?.value.indexOf("【风格】"); if (start >= 0) input.setSelectionRange(start, start + 4); });
          }}>{preset.label}</button>)}</div>
          <div className="uis-fields"><label>质量<select value={quality} onChange={e => setQuality(e.target.value)}><option value="low">草稿</option><option value="medium">标准</option><option value="high">精细</option></select></label>
          <label>尺寸<select value={size} onChange={e => setSize(e.target.value)}><option value="1024x1024">1K · 1:1</option><option value="1536x1024">1536 × 1024 · 3:2</option><option value="1024x1536">1024 × 1536 · 2:3</option><option value="2048x2048">2K · 1:1</option><option value="2048x1152">2K · 16:9</option></select></label></div>
          <label className="uis-upload">＋ 参考图 <small>{references.length}/4</small><input type="file" multiple accept={accepted} onChange={e => pickFiles(e, "reference")} disabled={busy} /></label>
          {references.length > 0 && <div className="uis-references">{references.map((ref, i) => <div key={i}><img src={ref.dataUrl} alt={ref.name} /><button aria-label={`移除参考图 ${i + 1}`} onClick={() => setReferences(rows => rows.filter((_, n) => n !== i))}>×</button></div>)}</div>}
        </> : <>
          <label className="uis-upload uis-source-upload">{source ? <><img src={source.dataUrl} alt="待导入图片" /><span>{source.name}</span></> : <><b>{workflow === "mockup" ? "＋ 选择图片" : "＋ 选择图集"}</b><span>PNG / JPEG / WebP · 最高 1600 万像素</span></>}
            <input type="file" accept={accepted} onChange={e => pickFiles(e, "source")} disabled={busy} /></label>
          <button onClick={useSelectedImage} disabled={busy || !canvasReady}>使用选中图片</button>
        </>}
        {workflow === "atlas" && <ProcessingOptions options={options} setOptions={setOptions} />}
        <button className="uis-primary uis-submit" disabled={busy || !canvasReady || (kind === "generate" ? !prompt.trim() : !source)} onClick={submit}>
          {busy ? "正在提交…" : workflow === "mockup" ? kind === "generate" ? agent?.connected ? "生成" : "保存任务（待连接）" : "导入" : kind === "generate" ? "生成" : "提取"}</button>
        {displayedMessage && <div className="uis-message" role="status">{displayedMessage}{messageJob?.operation === "plan" && messageJob.status === "ready" && <button onClick={() => setPlanDialog(messageJob)}>查看方案</button>}<button aria-label="关闭提示" onClick={() => { setMessage(""); setMessageJobId(null); }}>×</button></div>}
      </div>
      <MockupWorkflow job={selectedJob} jobs={jobs} editor={editor} ready={canvasReady} busy={busy} agent={agent} onRun={run} onRefresh={refresh} onSelect={setSelectedId} onPlan={setPlanDialog} onCompare={setCompareJob} />
      <details className="uis-history"><summary><h2>素材任务 <span>{jobs.length}</span></h2></summary>
        {!jobs.length && <p className="uis-hint">暂无任务</p>}
        {jobs.map(job => <article className={`uis-job ${selectedId === job.id ? "is-selected" : ""}`} key={job.id}>
          <button className="uis-job-title" onClick={() => setSelectedId(job.id)}><strong>{job.prompt}</strong><small>{job.operation === "plan" && jobs.find(j=>j.id===job.continuationId)?.status === "failed" ? "方案已完成 · 图片拆分失败" : jobStateLabel(job)}</small></button>
          <span className="uis-badge">{job.operation === "plan" ? "拆解方案" : job.operation === "decompose" ? "独立图层" : job.operation === "classify" ? "组件分类" : job.workflow === "mockup" ? "完整效果图" : "素材图集"}</span>
          {sourceFile(job) && <img className="uis-job-atlas uis-checker" src={assetUrl(job, job.repairPreview?.atlasFile || job.atlasFile || sourceFile(job))} alt={job.repairPreview ? "拆分候选预览" : "UI 图集预览"} />}
          {job.error && <p className="uis-error" role="alert">{job.error}</p>}
          {job.method === "hybrid" && <p className="uis-hint">{sourcePixelMode(job.splitOptions) ? "原像素提取 · 局部补全" : job.maskPurpose === "reference" ? "Mask 参考 · 高清拆分" : "原像素提取"} · {job.status === "failed" ? "处理失败" : job.status === "cancelled" ? "已取消" : ({ segment: "正在识别边界", review_masks: "等待检查参考", repair: "正在处理图层", review_repairs: "等待逐层验收", done: "素材处理完成" })[job.stage] || "准备中"}</p>}
          {job.slices && <p className="uis-hint">{job.slices.length} 个组件 · {job.width} × {job.height}</p>}
          <div className="uis-job-actions">
            {job.operation==='decompose' && canvasResult(job).slices?.length>0 && <button disabled={!canvasReady || saveConflict} title={saveConflict ? '请先解决画布保存冲突' : '将拆图结果移到原组件右侧'} onClick={()=>run(()=>placeJobBesideSource(editor,job))}>移到原图旁</button>}
            <button onClick={()=>setDiagnosticJobId(job.id)}>检查回填链路</button>
            {job.hybridDraft && ["review_masks", "failed"].includes(job.status) && <button className="uis-primary" onClick={() => setMaskJob(job)}>调整边界参考</button>}
            {job.repairPreview && <><button className="uis-primary" onClick={() => setCompareJob(job)}>检查 / 重做图层</button><button disabled={!canvasReady} onClick={()=>{locateJob(editor,canvasResult(job));setSelectedId(job.id);}}>定位候选图层</button></>}
            {job.operation === "plan" && job.status === "ready" && <>
              <button onClick={() => setPlanDialog(job)}>查看 / 调整方案</button>
              {job.continuationId ? <button onClick={() => setSelectedId(job.continuationId)}>查看拆分任务</button> : <button className="uis-primary" disabled={busy} onClick={() => run(async () => {
                const child = await uiApi(`jobs/${job.id}/continue-split`, { dispatch: Boolean(agent?.connected) });
                setSelectedId(child.id); setMessage("已继续拆分，完成后自动显示候选图层，可在画布检查。"); await refresh();
              })}>继续拆分并回填</button>}
              {job.continuationError && <p role="alert" className="uis-error">继续拆分失败：{job.continuationError}</p>}
            </>}
            {job.operation === "decompose" && job.status === "ready" && <button onClick={() => setCompareJob(job)}>原图 / 拼回对照</button>}
            {job.parent && <button disabled={!canvasReady} onClick={() => {
              const sourceJob = jobs.find(j => j.id === job.parent.jobId);
              const slice = sourceJob?.revision === job.parent.revision ? sourceJob.slices?.find(s => s.id === job.parent.sliceId) : null;
              if (!selectUiNode(editor, { ...job.parent, slice })) setMessage("来源版本已不在画布上，可通过任务记录查看原组件图片。");
              else setSelectedId(job.parent.jobId);
            }}>定位原组件</button>}
            {job.parent && ["failed", "cancelled"].includes(job.status) && <button disabled={busy || !canvasReady} onClick={() => {
              const sourceJob = jobs.find(j => j.id === job.parent.jobId && j.revision === job.parent.revision && j.status === "ready");
              if (!sourceJob) { setMessage("来源版本已变化，请在图层树重新选择组件。"); return; }
              const slice = sourceJob.slices.find(s => s.id === job.parent.sliceId);
              if (job.parent.sliceId && !slice) { setMessage("来源组件已变化，请在图层树重新选择组件。"); return; }
              if (job.operation === "classify") { run(async () => { await uiApi(`jobs/${sourceJob.id}/classify`, { revision: sourceJob.revision, sliceId: slice?.id }); await refresh(); }); return; }
              if (job.operation === "plan") { run(async () => { await uiApi(`jobs/${sourceJob.id}/plan`, { revision: sourceJob.revision, sliceId: slice?.id, prompt: job.prompt, dispatch: Boolean(agent?.connected) }); await refresh(); }); return; }
              if (job.planId) { const plan = jobs.find(p => p.id === job.planId); if (plan) { setPlanDialog({ ...plan, regions: job.approvedRegions }); return; } }
              openRefine({ job: sourceJob, slice }); setRefinePrompt(job.prompt);
            }}>调整后重试</button>}
            {sourceFile(job) && <a href={assetUrl(job, sourceFile(job))} target="_blank" rel="noreferrer">查看原图</a>}
            {job.status === "awaiting_agent" && <button disabled={busy || !canvasReady} onClick={() => run(() => executeGeneration({ jobId: job.id }))}>{job.operation === "plan" ? "开始分析" : job.operation === "classify" ? "开始分类" : job.operation === "decompose" ? "开始细分" : "开始生成"}</button>}
            {(working(job) || ["awaiting_agent", "review_masks", "review_repairs"].includes(job.status)) && <button disabled={busy} onClick={() => run(async () => { await uiApi(`jobs/${job.id}/cancel`, {}); await refresh(); })}>取消任务</button>}
            {job.sourceFile && !working(job) && job.workflow !== "mockup" && !["decompose", "classify", "plan"].includes(job.operation) && <button onClick={() => { setProcessJob(job); setProcessOptions(job.options); }}>重新切图</button>}
            {job.status === "ready" && job.slices?.length && job.operation !== "decompose" && job.workflow !== "mockup" && <button onClick={() => setReview(job)}>校正切片</button>}
            {job.status === "ready" && job.slices?.length && <button disabled={!canvasReady} onClick={() => {
              locateJob(editor, job);
              setSelectedId(job.id);
            }}>{editor?.store.allRecords().some(s => s.typeName === "shape" && s.meta?.uiJobId === job.id && s.meta?.uiRevision === job.revision) ? "定位素材" : "回填画布"}</button>}
            {job.exportFile && <a href={assetUrl(job, job.exportFile)} download>下载 ZIP</a>}
          </div>
        </article>)}
      </details>
    </aside></div>
    {planDialog && <PlanDialog key={planDialog.id} plan={planDialog} agent={agent} onClose={() => setPlanDialog(null)} onStarted={async job => { setSelectedId(job.id); setMessage(job.status === "awaiting_agent" ? "拆解任务已保存，连接 Agent 后启动。" : "正在按方案拆解，完成后自动显示候选图层供检查。"); await refresh(); }} />}
    {compareJob && <CompareDialog job={compareJob} onClose={() => setCompareJob(null)} onRefresh={refresh} onCorrect={setMaskJob} />}
    {maskJob && <MaskReviewDialog key={maskJob.id} job={maskJob} agent={agent} onClose={() => setMaskJob(null)} onRefresh={refresh} />}
    {refineTarget && <div className="uis-modal-backdrop"><section className="uis-dialog" role="dialog" aria-modal="true" aria-labelledby="uis-refine-title">
      <h2 id="uis-refine-title">拆分</h2><p className="uis-hint">{refineTarget.slice?.name || "整个图层组"}</p>
      <img className="uis-refine-preview uis-checker" src={assetUrl(refineTarget.job, refineTarget.slice?.file || refineTarget.job.atlasFile)} alt="待拆分组件" />
      <div className="uis-switches">
        <label><input type="checkbox" checked={splitOptions.preserveAppearance} disabled={busy} onChange={e=>setSplitOptions(v=>({...v,preserveAppearance:e.target.checked}))} />保留外观</label>
        <label><input type="checkbox" checked={splitOptions.useMask} disabled={busy} onChange={e=>setSplitOptions(v=>({...v,useMask:e.target.checked}))} />边界参考</label>
        <label><input type="checkbox" checked={splitOptions.keepText} disabled={busy} onChange={e=>setSplitOptions(v=>({...v,keepText:e.target.checked}))} />保留文字</label>
      </div>
      <label>输出方式<select value={splitOptions.resolutionMode || "hd"} disabled={busy} onChange={e=>setSplitOptions(v=>({...v,resolutionMode:e.target.value}))}><option value="hd">高清重建</option><option value="source">原像素提取</option></select></label>
      <label>生成方式<select value={splitOptions.generationMode || "individual"} disabled={busy || splitOptions.resolutionMode === "source"} onChange={e=>setSplitOptions(v=>({...v,generationMode:e.target.value}))}><option value="individual">逐层生成</option><option value="sheet">合图切割</option></select></label>
      <label>拆分粒度<select value={splitOptions.granularity} disabled={busy} onChange={e=>setSplitOptions(v=>({...v,granularity:e.target.value}))}><option value="layers">独立图层</option><option value="components">完整组件</option></select></label>
      <label>补充要求<textarea rows={2} maxLength={10000} disabled={busy} placeholder="可选" value={splitOptions.notes} onChange={e=>setSplitOptions(v=>({...v,notes:e.target.value}))} /></label>
      {splitSaveError && <p role="alert" className="uis-error">{splitSaveError}</p>}
      {!agent?.connected && <p className="uis-hint">未连接，任务将等待执行。</p>}
      <div className="uis-dialog-actions"><button disabled={busy} onClick={() => setRefineTarget(null)}>关闭</button><button className="uis-primary" disabled={busy} onClick={() => run(async () => {
        const task = await uiApi(`jobs/${refineTarget.job.id}/${splitOptions.useMask ? "plan" : "refine"}`, { revision:refineTarget.job.revision, sliceId:refineTarget.slice?.id || null, prompt:"Process the selected component according to the split configuration, preserving the source image style.", splitOptions, autoContinue:true, reviewBeforePublish:true, ...(splitOptions.useMask ? {hybrid:true} : {}), dispatch:Boolean(agent?.connected) });
        setSelectedId(task.id); setRefineTarget(null); setMessage(splitOptions.useMask ? "正在分析拆分方案。" : "拆分任务已提交。"); setMessageJobId(task.id); await refresh();
      })}>{busy ? "正在提交…" : "拆分"}</button></div>{message && <p role="alert">{message}</p>}
    </section></div>}
    {review && <ReviewDialog job={review} onClose={() => setReview(null)} onSave={async slices => { await uiApi(`jobs/${review.id}/process`, { slices }); setReview(null); await refresh(); }} />}
    {diagnosticJobId && <DeliveryDialog jobId={diagnosticJobId} editor={editor} saveStatus={saveStatus} onSelect={setSelectedId} onClose={()=>setDiagnosticJobId(null)} />}
    {processJob && <div className="uis-modal-backdrop"><section className="uis-dialog" role="dialog" aria-modal="true" aria-label="重新切图"><h2>调整切图参数</h2><p>从保留的原始图集重新处理，完成后更新本任务组件。</p><ProcessingOptions options={processOptions} setOptions={setProcessOptions} compact />
      <div className="uis-dialog-actions"><button disabled={busy} onClick={() => setProcessJob(null)}>关闭</button><button className="uis-primary" disabled={busy} onClick={() => run(async () => { await uiApi(`jobs/${processJob.id}/process`, { options: processOptions }); setProcessJob(null); await refresh(); })}>重新切图</button></div>{message && <p role="alert">{message}</p>}</section></div>}
  </div>;
}
