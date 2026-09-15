import { useEffect, useRef, useState } from "react";
import { sourcePixelMode } from "../../shared/split-options.mjs";
import { assetUrl, uiApi } from "./api.js";
import { useDialogFocus } from "./MockupWorkflow.jsx";

export default function MaskReviewDialog({ job: initial, agent, onClose, onRefresh }) {
  const [job, setJob] = useState(initial), [active, setActive] = useState(initial.hybridDraft.layers[0].regionId);
  const [edits, setEdits] = useState({}), [repairModes, setRepairModes] = useState({});
  const [repairPaddings, setRepairPaddings] = useState({});
  const [maskPurpose, setMaskPurpose] = useState(initial.maskPurpose || "cutout"), [layerNotes, setLayerNotes] = useState({});
  const reference = maskPurpose === "reference";
  const preserve = sourcePixelMode(initial.splitOptions);
  const [mode, setMode] = useState("erase"), [radius, setRadius] = useState(3), [background, setBackground] = useState("#20242c");
  const [view, setView] = useState(initial.maskPurpose === "reference" ? "overlay" : "isolated"), [error, setError] = useState(""), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(0);
  const [notice, setNotice] = useState("");
  const canvas = useRef(null), images = useRef(null), stroke = useRef(null);
  const dialogRef = useDialogFocus(onClose, busy), layer = job.hybridDraft.layers.find(l => l.regionId === active);
  useEffect(() => {
    let cancelled = false; images.current = null;
    const source = new Image(), mask = new Image();
    const load = image => new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error("素材加载失败，请重新打开校正窗口")); });
    const ready = Promise.all([load(source), load(mask)]);
    source.src = assetUrl(job, job.sourceFile); mask.src = assetUrl(job, layer.maskFile);
    ready.then(() => { if (!cancelled) { images.current = { source, mask }; setLoaded(n => n+1); } }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [job.id, job.hybridDraft.version, active]);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.clearRect(0, 0, layer.w, layer.h);
    if (!images.current) return;
    const maskCanvas = document.createElement("canvas"); maskCanvas.width = layer.w; maskCanvas.height = layer.h;
    const mc = maskCanvas.getContext("2d", { willReadFrequently: true }); mc.drawImage(images.current.mask, 0, 0);
    // Preview uses the same integer circles and line interpolation as the server.
    const mask = mc.getImageData(0, 0, layer.w, layer.h);
    for (const s of edits[active] || []) {
      const stamp = (x, y) => {
        for (let yy = Math.max(0, y-s.radius); yy <= Math.min(layer.h-1, y+s.radius); yy++) for (let xx = Math.max(0, x-s.radius); xx <= Math.min(layer.w-1, x+s.radius); xx++)
          if ((xx-x)**2+(yy-y)**2 <= s.radius**2) for (let c = 0; c < 3; c++) mask.data[(yy*layer.w+xx)*4+c] = s.mode === "keep" ? 255 : 0;
      };
      let previous = s.points[0]; stamp(...previous);
      for (const p of s.points.slice(1)) { const steps = Math.max(Math.abs(p[0]-previous[0]), Math.abs(p[1]-previous[1]), 1); for (let t = 1; t <= steps; t++) stamp(Math.round(previous[0]+(p[0]-previous[0])*t/steps), Math.round(previous[1]+(p[1]-previous[1])*t/steps)); previous = p; }
    }
    if (view === "mask") { ctx.putImageData(mask, 0, 0); return; }
    ctx.drawImage(images.current.source, layer.x, layer.y, layer.w, layer.h, 0, 0, layer.w, layer.h);
    if (view === "source") return;
    const pixels = ctx.getImageData(0, 0, layer.w, layer.h);
    for (let p = 0; p < layer.w*layer.h; p++) {
      if(view === "overlay") {
        const weight=mask.data[p*4]/255*.4;
        for(let c=0;c<3;c++) pixels.data[p*4+c]=Math.round(pixels.data[p*4+c]*(1-weight)+[58,210,166][c]*weight);
      } else pixels.data[p*4+3] = Math.round(pixels.data[p*4+3]*mask.data[p*4]/255);
    }
    ctx.putImageData(pixels, 0, 0);
  }, [loaded, edits, active, view, job.hybridDraft.version]);
  const point = e => { const rect = canvas.current.getBoundingClientRect(); return [Math.max(0, Math.min(layer.w-1, Math.round((e.clientX-rect.left)*layer.w/rect.width))), Math.max(0, Math.min(layer.h-1, Math.round((e.clientY-rect.top)*layer.h/rect.height)))]; };
  function draw(e, begin) {
    if (busy || !images.current) return;
    setNotice("");
    if (begin) { e.currentTarget.setPointerCapture(e.pointerId); stroke.current = { mode, radius, points: [point(e)] }; }
    else { if (!stroke.current || stroke.current.points.length >= 2000) return; stroke.current = { ...stroke.current, points: [...stroke.current.points, point(e)] }; }
    const current = stroke.current;
    setEdits(all => ({ ...all, [active]: begin ? [...(all[active] || []), current] : [...all[active].slice(0, -1), current] }));
  }
  async function save() {
    if (!Object.keys(edits).length && !Object.keys(layerNotes).length && maskPurpose === (job.maskPurpose || "cutout") && !Object.keys(repairModes).length && !Object.keys(repairPaddings).length && job.status === "review_masks") return job;
    const next = await uiApi(`jobs/${job.id}/masks`, { version: job.hybridDraft.version,
      maskPurpose, layerNotes:Object.entries(layerNotes).map(([regionId,notes])=>({regionId,notes})),
      edits: Object.entries(edits).map(([regionId, strokes]) => ({ regionId, strokes })),
      repairPaddings: Object.entries(repairPaddings).map(([regionId, padding]) => ({ regionId, padding })),
      repairModes: Object.entries(repairModes).map(([regionId, repairMode]) => ({ regionId, repairMode })) });
    setJob(next); setEdits({}); setLayerNotes({}); setRepairModes({}); setRepairPaddings({}); setNotice("标注已保存，可以关闭后继续处理。"); await onRefresh(); return next;
  }
  async function run(approve) {
    setBusy(true); setError("");
    try { const saved = await save(); if (approve) { await uiApi(`jobs/${job.id}/approve-masks`, { version: saved.hybridDraft.version, dispatch: Boolean(agent?.connected) }); await onRefresh(); onClose(); } }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <div className="uis-modal-backdrop"><section ref={dialogRef} className="uis-dialog uis-mask-dialog" role="dialog" aria-modal="true" aria-label="标注图层边界参考">
    <div className="uis-inspector-heading"><div><h2>标注图层边界参考</h2><p className="uis-hint">{reference ? "Mask 帮助 AI 识别元素。无需逐像素描边，AI 会优先复用匹配素材，再生成缺失图层并修正轮廓。" : "此历史任务使用原像素提取，可切换为 AI 参考模式。"}</p></div><button disabled={busy} onClick={onClose}>关闭</button></div>
    <label>Mask 用途<select disabled={busy} value={maskPurpose} onChange={e=>{setMaskPurpose(e.target.value);setView(e.target.value === "reference" ? "overlay" : "isolated");}}><option value="reference">{preserve ? "边界参考 · 原图保真" : "边界参考 · AI 完整生成"}</option><option value="cutout" disabled={job.splitOptions?.resolutionMode === "hd"}>精确裁切 · 保留原像素</option></select></label>
    {reference && preserve && <p className="uis-hint">AI 对照原图修正元素归属，保留可见原像素，只补全遮挡和去字区域。</p>}
    <div className="uis-mask-grid"><div>
      <div className="uis-layer-actions"><label>预览<select value={view} onChange={e => setView(e.target.value)}><option value="overlay">原图＋边界标注</option><option value="isolated">Mask 提取示意</option><option value="source">原图区域</option><option value="mask">黑白 Mask</option></select></label>
        <label>底色<select value={background} onChange={e => setBackground(e.target.value)}><option value="#20242c">深色</option><option value="#ffffff">白色</option><option value="#808080">灰色</option></select></label>
        <label>画笔<select value={mode} onChange={e => setMode(e.target.value)}><option value="erase">{reference ? "排除干扰内容" : "擦除"}</option><option value="keep">{reference ? "标记目标元素" : "保留"}</option></select></label>
        <label>半径 {radius}px<input aria-label="画笔半径" type="range" min="1" max="30" value={radius} onChange={e => setRadius(Number(e.target.value))} /></label>
        <button disabled={busy || !edits[active]?.length} onClick={() => setEdits(all => ({ ...all, [active]: all[active].slice(0, -1) }))}>撤销本层笔划</button>
      </div>
      <div className="uis-mask-image" style={{ background }}><canvas key={active} ref={canvas} width={layer.w} height={layer.h} style={{ width: `min(100%, ${52*layer.w/layer.h}vh)` }} aria-label="分割画笔区域" onPointerDown={e => draw(e, true)} onPointerMove={e => draw(e, false)} onPointerUp={() => { stroke.current = null; }} onPointerCancel={() => { stroke.current = null; }} /></div>
      <p className="uis-hint">布局范围 {layer.w} × {layer.h}。{reference ? preserve ? "标注帮助识别元素，AI 会对照原图修正归属，保留原始分辨率。" : "标注表达目标归属，不决定最终透明度；生成素材将保留高清分辨率。" : "白色保留，黑色去除。"}关闭前请保存标注。</p>
    </div><div className="uis-plan-editor"><div className="uis-plan-list">{job.hybridDraft.layers.map((l,i) => <button key={l.regionId} disabled={busy} className={active === l.regionId ? "is-active" : ""} onClick={() => { stroke.current = null; setActive(l.regionId); }}>{i+1}. {l.name}<small>{reference ? preserve ? "保留原图 · 局部补全" : "AI 完整生成" : l.repairPixels ? "有遮挡区域" : "直接提取原像素"}{l.warnings.length ? " · 待检查" : ""}</small></button>)}</div>
      {reference && <><label>本层生成要求<textarea rows={4} maxLength={2000} disabled={busy} value={layerNotes[active] ?? layer.reconstructionNotes ?? ""} placeholder="例如：保持原图金色细边；补全圆角；去掉数字和按钮；不要照着 Mask 的毛边生成。" onChange={e=>setLayerNotes(all=>({...all,[active]:e.target.value}))} /></label><p className="uis-hint">原图、边界标注和本层说明会一起交给 AI。先查找并复用匹配素材，仅生成缺失图层，最后按内容、比例、位置与画质验收。</p></>}
      {!reference && <>
      <label>遮挡修补<select value={repairModes[active] || layer.repairMode} disabled={busy} onChange={e => setRepairModes(all => ({ ...all, [active]: e.target.value }))}><option value="none">不修补（前景图层）</option><option value="surface">邻近颜色修补（纯色底板）</option><option value="image">AI 局部修补（纹理、场景）</option></select></label>
      <p className="uis-hint">仅遮挡区域会被修补，其他像素保持不变。修改笔划后保存可重新计算遮挡。</p>
      {layer.repairPixels > 0 && <label>修补扩边（去除字迹和图标残边）<input type="number" min="0" max="8" disabled={busy} value={repairPaddings[active] ?? layer.repairPadding ?? 0} onChange={e=>setRepairPaddings(all=>({...all,[active]:Number(e.target.value)}))} /><span className="uis-hint">0–8 像素。保存后检查更新的白色修补范围，再确认。</span></label>}
      {layer.repairPixels > 0 && <><img className="uis-repair-mask" src={assetUrl(job, layer.repairMaskFile)} alt="白色为当前需修补区域" /><p className="uis-hint">白色：需补全的遮挡区域</p></>}
      </>}
      {layer.warnings.map(w => <p className="uis-hint" key={w}>{w}</p>)}
    </div></div>
    {error && <p className="uis-error" role="alert">{error}</p>}
    {notice && <p className="uis-hint" role="status">{notice}</p>}
    <div className="uis-dialog-actions"><button disabled={busy} onClick={() => run(false)}>保存标注</button><button className="uis-primary" disabled={busy} onClick={() => run(true)}>{busy ? "正在处理…" : reference ? preserve ? "保真拆分" : "使用参考生成完整图层" : "确认边缘并完成拆解"}</button></div>
  </section></div>;
}
