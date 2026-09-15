import { useEffect, useRef, useState } from "react";
import { assetUrl, uiApi, stateLabel } from "./api.js";
import { componentLabels } from "../../shared/ui-schema.mjs";
import { sourcePixelMode } from "../../shared/split-options.mjs";
import { validatePlan } from "../../shared/ui-plan.mjs";
import { locateJob } from "./canvas.js";

export function useDialogFocus(onClose, busy = false) {
  const ref = useRef(null), latest = useRef({ onClose, busy });
  latest.current = { onClose, busy };
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.querySelector("button")?.focus();
    const key = event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!latest.current.busy) latest.current.onClose(); }
      if (event.key === "Tab") {
        const elements = [...ref.current.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]")].filter(e => e.getClientRects().length);
        const index = elements.indexOf(document.activeElement);
        if (index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === elements.length - 1) { event.preventDefault(); elements[event.shiftKey ? elements.length - 1 : 0]?.focus(); }
      }
    };
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("keydown", key, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  return ref;
}

export function PlanDialog({ plan, agent, onClose, onStarted }) {
  const [method, setMethod] = useState(plan.hybrid ? "hybrid" : "redraw"), [vision, setVision] = useState(null), [pointTool, setPointTool] = useState("move");
  useEffect(() => { let live = true; uiApi("vision").then(v => { if (live) setVision(v); }).catch(() => { if (live) setVision({ ready: false }); }); return () => { live = false; }; }, []);
  const [regions, setRegions] = useState(() => {
    try { const draft = JSON.parse(localStorage.getItem(`drawpaint.plan.${plan.id}`)); return Array.isArray(draft) && draft.length && draft.every(r => r && typeof r.id === "string") ? draft : plan.regions; } catch { return plan.regions; }
  });
  const [active, setActive] = useState(regions[0]?.id), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const dialogRef = useDialogFocus(onClose, busy);
  const svgRef = useRef(null), drag = useRef(null);
  useEffect(() => { try { localStorage.setItem(`drawpaint.plan.${plan.id}`, JSON.stringify(regions)); } catch { /* Editing remains available when local storage is full. */ } }, [plan.id, regions]);
  const selected = regions.find(r => r.id === active);
  const change = (key, value) => setRegions(rows => rows.map(r => r.id === active ? { ...r, [key]: value } : r));
  function beginDrag(event, region, resize = false) {
    if (busy) return;
    if (pointTool !== "move" && selected) {
      event.preventDefault(); event.stopPropagation();
      const rect = svgRef.current.getBoundingClientRect();
      const p = [Math.max(0, Math.min(plan.width-1, Math.round((event.clientX-rect.left)*plan.width/rect.width))), Math.max(0, Math.min(plan.height-1, Math.round((event.clientY-rect.top)*plan.height/rect.height)))];
      const key = pointTool === "keep" ? "positivePoints" : "negativePoints";
      if ((selected[key] || []).length < 20) change(key, [...(selected[key] || []), p]);
      return;
    }
    event.preventDefault(); event.stopPropagation(); setActive(region.id);
    const rect = svgRef.current.getBoundingClientRect();
    drag.current = { region, resize, x: event.clientX, y: event.clientY, scale: plan.width / rect.width };
    svgRef.current.setPointerCapture(event.pointerId);
  }
  function moveDrag(event) {
    if (!drag.current) return;
    const { region, resize, x, y, scale } = drag.current;
    const dx = Math.round((event.clientX - x) * scale), dy = Math.round((event.clientY - y) * scale);
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    const update = resize ? { w: clamp(region.w + dx, 1, plan.width - region.x), h: clamp(region.h + dy, 1, plan.height - region.y) }
      : { x: clamp(region.x + dx, 0, plan.width - region.w), y: clamp(region.y + dy, 0, plan.height - region.h) };
    setRegions(rows => rows.map(r => r.id === region.id ? { ...r, ...update } : r));
  }
  async function start() {
    setBusy(true); setError("");
    try {
      const approved = validatePlan(regions, plan.width, plan.height);
      const job = await uiApi(`jobs/${plan.parent.jobId}/${method === "hybrid" ? "hybrid" : "refine"}`, { revision: plan.parent.revision, sliceId: plan.parent.sliceId,
        planId: plan.id, regions: approved, autoContinue:true, reviewBeforePublish:true, splitOptions:plan.splitOptions ? {...plan.splitOptions,useMask:method === "hybrid"} : undefined, dispatch: Boolean(agent?.connected) });
      await onStarted(job); onClose();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <div className="uis-modal-backdrop"><section ref={dialogRef} className="uis-dialog uis-plan-dialog" role="dialog" aria-modal="true" aria-label="校正拆解方案">
    <div className="uis-inspector-heading"><div><h2>校正拆解方案</h2><p className="uis-hint">{plan.width} × {plan.height} · {regions.length} 个组件 · 点击标框或列表编辑</p></div><button disabled={busy} onClick={onClose}>关闭</button></div>
    <div className="uis-layer-actions"><label>拆解方式<select disabled={busy} value={method} onChange={e => setMethod(e.target.value)}><option value="hybrid" disabled={!vision?.ready}>{sourcePixelMode(plan.splitOptions) ? "原像素提取（Mask 参考）" : "Mask 边界参考 · 高清拆分"}</option><option value="redraw">{sourcePixelMode(plan.splitOptions) ? "原像素提取（无 Mask 参考）" : "高清拆分（无 Mask 参考）"}</option></select></label>{!vision?.ready && <span className="uis-hint">{vision ? "本地分割环境尚未就绪" : "正在检查分割环境…"}</span>}
    {method === "hybrid" && <label>标注工具<select value={pointTool} onChange={e => setPointTool(e.target.value)}><option value="move">移动范围</option><option value="keep">目标点（保留）</option><option value="exclude">排除点</option></select></label>}</div>
    <div className="uis-plan-grid"><div className="uis-plan-image">
      <svg ref={svgRef} viewBox={`0 0 ${plan.width} ${plan.height}`} aria-label="效果图组件范围" style={{ touchAction: "none" }} onPointerMove={moveDrag} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
        <image href={assetUrl(plan, plan.sourceFile)} width={plan.width} height={plan.height} />
        {[...regions].sort((a, b) => b.w * b.h - a.w * a.h).map(r => <g key={r.id} onPointerDown={e => beginDrag(e, r)} className={r.id === active ? "is-active" : ""}>
          <rect x={r.x} y={r.y} width={r.w} height={r.h} /><text x={r.x + 5} y={r.y + 22} fontSize={Math.max(14, plan.width / 65)}>{r.name}</text>
        </g>)}
        {selected && <rect className="uis-plan-handle" x={selected.x + selected.w - plan.width / 120} y={selected.y + selected.h - plan.width / 120} width={plan.width / 60} height={plan.width / 60} onPointerDown={e => beginDrag(e, selected, true)} />}
        {method === "hybrid" && selected && ["positivePoints", "negativePoints"].flatMap(key => (selected[key] || []).map((p, i) => <circle key={`${key}-${i}`} cx={p[0]} cy={p[1]} r={Math.max(3, plan.width/180)} fill={key === "positivePoints" ? "#33c997" : "#e75c66"} stroke="white" pointerEvents="none" />))}
      </svg><p className="uis-hint">拖动标框移动，拖动右下角调整大小，也可输入像素坐标。重叠内容由 AI 分离，底图会补全。</p>
    </div><div className="uis-plan-editor">
      <div className="uis-plan-list" role="listbox" aria-label="拆解组件">{regions.map(r => <button role="option" aria-selected={r.id === active} key={r.id} onClick={() => setActive(r.id)}>{r.name}<small>{componentLabels[r.layerType]} · 层序 {r.zIndex}</small></button>)}</div>
      {selected && <><label>组件名称<input value={selected.name} maxLength={120} onChange={e => change("name", e.target.value)} /></label>
        <div className="uis-fields"><label>类型<select value={selected.layerType} onChange={e => change("layerType", e.target.value)}>{Object.entries(componentLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>用途分组（拆解参考）<input value={selected.group || ""} onChange={e => change("group", e.target.value)} /></label></div>
        <div className="uis-fields">{[["x", "X"], ["y", "Y"], ["w", "宽度"], ["h", "高度"], ["zIndex", "层序（越大越靠前）"]].map(([key, label]) => <label key={key}>{label}<input type="number" value={selected[key]} onChange={e => change(key, Number(e.target.value))} /></label>)}</div>
        {selected.layerType === "text" && <label>文字内容<input value={selected.text || ""} onChange={e => change("text", e.target.value)} /></label>}
        <label>拆解要求<textarea rows={2} value={selected.notes || ""} onChange={e => change("notes", e.target.value)} /></label>
        {method === "hybrid" && <>
          <label>承载此组件的父层<select value={selected.parentId || ""} onChange={e => change("parentId", e.target.value || null)}><option value="">无（根图层）</option>{regions.filter(r => r.id !== active && r.zIndex < selected.zIndex).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
          <p className="uis-hint">先查找已有素材并复用匹配图层，仅对缺失部分完整生成。Mask 只标注目标和边界，不裁切输出。</p>
          {selected.layerType === "background" && <label><input type="checkbox" checked={selected.maskMode === "rectangle"} onChange={e => change("maskMode", e.target.checked ? "rectangle" : "sam")} />完整矩形背景</label>}
          <button onClick={() => setRegions(rows => rows.map(r => r.id === active ? { ...r, positivePoints: [], negativePoints: [] } : r))}>清空本层提示点</button>
        </>}
      </>}
      <div className="uis-layer-actions"><button onClick={() => { const id = `region-${crypto.randomUUID()}`; setRegions(rows => [...rows, { id, name: "新组件", layerType: "component", x: 0, y: 0, w: Math.min(200, plan.width), h: Math.min(100, plan.height), zIndex: regions.length, group: "", notes: "" }]); setActive(id); }} disabled={regions.length >= 64 || busy}>添加组件</button><button disabled={!selected || regions.length <= 2 || busy} onClick={() => { setRegions(rows => rows.filter(r => r.id !== active)); setActive(regions.find(r => r.id !== active)?.id); }}>移除组件</button></div>
    </div></div>
    {error && <p className="uis-error" role="alert">{error}</p>}
    <div className="uis-dialog-actions"><span className="uis-hint">关闭保留草稿 · 拆分完成后检查候选图层，确认后回填画布</span><button disabled={busy} onClick={() => { setRegions(plan.regions); setActive(plan.regions[0]?.id); setError(""); }}>恢复原方案</button><button className="uis-primary" disabled={busy || method === "hybrid" && !vision?.ready} onClick={start}>{busy ? "正在提交…" : "拆分"}</button></div>
  </section></div>;
}

export function CompareDialog({ job: originalJob, onClose, onRefresh, onCorrect }) {
  const reviewing = Boolean(originalJob.repairPreview);
  const editable=["review_repairs","failed"].includes(originalJob.status);
  const candidateMode=originalJob.reviewBeforePublish;
  const job = reviewing ? { ...originalJob, ...originalJob.repairPreview } : originalJob;
  const [mix, setMix] = useState(50);
  const [difference, setDifference] = useState(false), [background, setBackground] = useState("#20242c");
  const [layerId, setLayerId] = useState(reviewing ? job.slices[0]?.id || "" : "");
  const [nativeSize,setNativeSize] = useState(false);
  const [redoIds,setRedoIds]=useState(originalJob.candidateReview?.regionIds || []);
  const [notes,setNotes]=useState(originalJob.candidateReview?.notes || {});
  const [notice,setNotice]=useState("");
  const reference = job.maskPurpose === "reference";
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const layer = job.slices?.find(s => s.id === layerId);
  const dialogRef = useDialogFocus(onClose, busy);
  async function finish(approve) {
    setBusy(true); setError("");
    try {
      const next = await uiApi(`jobs/${job.id}/${approve ? "approve-repairs" : "masks"}`, approve ? { revision: job.revision } : { version: job.hybridDraft.version, edits: [] });
      await onRefresh(); onClose(); if (!approve) onCorrect(next);
    } catch(e) { setError(e.message); } finally { setBusy(false); }
  }
  async function candidateAction(action) {
    setBusy(true);setError("");setNotice("");
    try {
      await uiApi(`jobs/${job.id}/${action}`,{revision:job.revision,regionIds:redoIds,notes});
      await onRefresh();
      if(action !== "review-candidates") onClose(); else setNotice("验收标记已保存，关闭或刷新后仍可继续。");
    } catch(e) {setError(e.message);} finally {setBusy(false);}
  }
  const slide = event => { const rect = event.currentTarget.getBoundingClientRect(); setMix(Math.max(0, Math.min(100, (event.clientX - rect.left) / rect.width * 100))); };
  return <div className="uis-modal-backdrop"><section ref={dialogRef} className="uis-dialog uis-compare-dialog" role="dialog" aria-modal="true" aria-label="原图与拼回结果对照">
    <h2>{reviewing ? "检查图层生成效果" : "原图与拼回结果"}</h2><p className="uis-hint">逐层检查内容与文字、比例位置、细线镂空、透明边缘和底板完整性，再查看整体回拼。整体对照左侧为原图，右侧为拆解结果。</p>
    {reviewing && <p role="status" className="uis-hint">切图与去背景已完成，候选图层会自动显示到画布，标记为“待检查”。可逐层检查和重做，确认后作为正式素材。</p>}
    {reviewing && originalJob.error && <p className="uis-error">本次重做未完成：{originalJob.error}。上一次候选仍保留，可重新选择问题层。</p>}
    {reviewing && candidateMode && <p>标记需要重做的图层并填写修改要求；未选中的层保留原文件。已选 {redoIds.length} 层重做。</p>}
    <div className="uis-layer-actions"><label>查看图层<select value={layerId} onChange={e => {setLayerId(e.target.value);setDifference(false);}}><option value="">整体回拼对照</option>{job.slices?.map(s => <option key={s.id} value={s.id}>{s.name}{s.reuse ? " · 已复用" : s.preservation ? " · 原图保真" : reference ? " · 已生成" : s.repairPixels ? " · 已修补" : ""}</option>)}</select></label><label>底色<select value={background} onChange={e => setBackground(e.target.value)}><option value="#20242c">深色</option><option value="#ffffff">白色</option><option value="#808080">灰色</option></select></label>{!layer && job.quality?.differenceFile && <label><input type="checkbox" checked={difference} onChange={e => setDifference(e.target.checked)} />显示像素差异</label>}</div>
    {layer ? <><label><input type="checkbox" checked={nativeSize} onChange={e=>setNativeSize(e.target.checked)} />以素材原始分辨率查看（可滚动）</label><div className="uis-layer-pair"><figure><div className="uis-layer-review" style={{background}}><svg viewBox={`${layer.x} ${layer.y} ${layer.w} ${layer.h}`} role="img" aria-label={`原图参考：${layer.name}`}><image href={assetUrl(job,job.sourceFile)} width={job.width} height={job.height}/></svg></div><figcaption>原图区域 · 含原始遮挡</figcaption></figure><figure><div className={`uis-layer-review ${nativeSize ? "is-native" : ""}`} style={{background}}><img src={assetUrl(job, layer.file)} style={nativeSize ? {width:layer.imageWidth||layer.w,maxWidth:"none",maxHeight:"none"}:undefined} alt={`独立图层：${layer.name}`} /></div><figcaption>独立图层 · <a href={assetUrl(job,layer.file)} download={`${layer.name}.png`}>下载原始 PNG</a></figcaption></figure></div></> : difference ? <img className="uis-difference-image" src={assetUrl(job, job.quality.differenceFile)} alt="回拼像素差异，亮处表示变化" /> : <div className="uis-compare-image" style={{ background, aspectRatio: `${job.width}/${job.height}`, touchAction: "none", cursor: "ew-resize" }} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); slide(e); }} onPointerMove={e => { if (e.buttons === 1) slide(e); }}>
      <img draggable={false} src={assetUrl(job, job.atlasFile)} alt="拆解拼回结果" />
      <img draggable={false} src={assetUrl(job, job.sourceFile)} alt="原始效果图" style={{ clipPath: `inset(0 ${100 - mix}% 0 0)` }} />
      <div style={{ left: `${mix}%` }} /><span>原效果图</span><span>拼回结果</span>
    </div>}{!layer && !difference && <label>原图 / 结果分界<input aria-label="对比分界" type="range" min="0" max="100" value={mix} onChange={e => setMix(Number(e.target.value))} /></label>}
    {layer && <p className="uis-hint">素材 {layer.imageWidth||layer.w} × {layer.imageHeight||layer.h} 像素 · 布局 {layer.w} × {layer.h} · 位置 {layer.x}, {layer.y}。{layer.preservation ? "可见原像素保留，仅局部补全缺失内容；参考 Mask 经 AI 对照原图修正后确定元素归属。" : reference && "最终轮廓与透明度来自生成素材，未用参考 Mask 裁切。"}{layer.repairMapping && "修补区域已从生成图明确映射，请检查材质和接缝。"}</p>}
    {layer?.warnings?.map(w=><p className="uis-hint" key={w}>{w}</p>)}
    {reviewing && candidateMode && layer && <div className="uis-fields"><label><input type="checkbox" disabled={busy || !editable} checked={redoIds.includes(layer.regionId)} onChange={e=>setRedoIds(ids=>e.target.checked ? [...ids,layer.regionId] : ids.filter(id=>id!==layer.regionId))} />需要重做此层</label><label>本层修改要求<textarea disabled={busy || !editable} maxLength={2000} value={notes[layer.regionId] || ""} onChange={e=>setNotes(n=>({...n,[layer.regionId]:e.target.value}))} placeholder="例如：边框与端头保持相连，轮廓更清晰，保留原配色" /></label></div>}
    {notice && <p role="status">{notice}</p>}
    {job.quality?.differenceFile && <p className="uis-hint">变化像素 {(job.quality.changedFraction*100).toFixed(2)}%（阈值 {job.quality.threshold}/255）。包含重建和半透明叠加变化，不代表准确率；回拼相似也不表示被遮挡的底层补全正确。</p>}
    {error && <p className="uis-error" role="alert">{error}</p>}
    <div className="uis-dialog-actions"><button disabled={busy} onClick={onClose}>关闭对照</button>{reviewing && <>
      {candidateMode ? <><button disabled={busy || !editable} onClick={()=>candidateAction("review-candidates")}>保存验收标记</button><button disabled={busy || !editable || !redoIds.length} onClick={()=>candidateAction("retry-candidates")}>只重做选中图层</button></> : <button disabled={busy} onClick={() => finish(false)}>调整参考 / 重新生成</button>}
      {candidateMode && originalJob.status === "failed" && <button disabled={busy} onClick={()=>candidateAction("restore-candidates")}>恢复上次候选继续验收</button>}
      <button className="uis-primary" disabled={busy || originalJob.status!=="review_repairs" || candidateMode && redoIds.length>0} onClick={() => finish(true)}>{busy ? "正在保存…" : "确认图层"}</button></>}</div>
  </section></div>;
}

export default function MockupWorkflow({ job, jobs, editor, ready, busy, agent, onRun, onRefresh, onSelect, onPlan, onCompare }) {
  const [vision, setVision] = useState(null);
  useEffect(() => { let live = true; uiApi("vision").then(v => { if (live) setVision(v); }).catch(() => {}); return () => { live = false; }; }, []);
  let source = job, visited = new Set();
  while (source?.parent && !visited.has(source.id)) { visited.add(source.id); source = jobs.find(j => j.id === source.parent.jobId && j.revision === source.parent.revision); }
  if (source?.workflow !== "mockup") return null;
  const plans = jobs.filter(j => j.operation === "plan" && j.parent?.jobId === source.id && j.parent.revision === source.revision);
  const plan = plans[0];
  const result = jobs.find(j => j.operation === "decompose" && j.status === "ready" && j.parent?.jobId === source.id && j.parent.revision === source.revision);
  const pending = jobs.find(j => j.parent?.jobId === source.id && !["ready", "failed", "cancelled"].includes(j.status));
  return <section className="uis-workflow" aria-label="效果图工作流">
    <strong>效果图 → 拆解方案 → 候选验收 → 回填</strong>
    <div className="uis-workflow-steps"><span className={source.status === "ready" ? "is-done" : ""}>① 效果图</span><span className={plan?.status === "ready" ? "is-done" : ""}>② 拆解方案</span><span className={result ? "is-done" : ""}>③ 验收与回填</span></div>
    {source.atlasFile && <img src={assetUrl(source, source.atlasFile)} alt="当前工作流效果图" />}
    <p className="uis-hint">先审阅整体效果，再分析组件。拆解后先逐层验收，可只重做问题层；确认后回填画布。</p>
    {pending && <p role="status">{pending.operation === "plan" ? "分析方案" : "拆解组件"} · {stateLabel[pending.status]}</p>}
    <div className="uis-layer-actions"><button disabled={busy || !ready || source.status !== "ready" || Boolean(pending)} onClick={() => onRun(async () => {
      const task = await uiApi(`jobs/${source.id}/plan`, { revision: source.revision, reviewBeforePublish:true, hybrid: Boolean(vision?.ready), dispatch: Boolean(agent?.connected) }); onSelect(task.id); await onRefresh();
    })}>{plan ? "重新分析" : "分析拆解方案"}</button>
      {plan?.status === "ready" && <button className="uis-primary" disabled={busy || Boolean(pending)} onClick={() => onPlan(plan)}>校正方案并拆解</button>}
      {result && <><button onClick={() => onCompare(result)}>原图 / 结果对照</button><button disabled={!ready} onClick={() => { locateJob(editor, result); onSelect(result.id); }}>编辑拼回结果</button></>}
    </div>
  </section>;
}
