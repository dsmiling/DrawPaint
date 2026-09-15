import { useEffect, useRef, useState } from "react";
import { useValue } from "tldraw";
import { componentLabels } from "../../shared/ui-schema.mjs";
import { uiApi, assetUrl } from "./api.js";
import { nodePreview, resizeUiNode, uiNodeVisible, setUiNodeVisible } from "./canvas.js";
import { nodeCoordinates, setNodeCoordinate } from "./coordinates.js";
import { updateCopyMetadata } from "./layer-actions.js";
import { captureCanvasPreset } from "./canvas-export.js";

function GeometryField({ label, shortLabel, value, dimension, disabled, onCommit, onScrubBoundary, editor }) {
  const [draft, setDraft] = useState(""), [editing, setEditing] = useState(false);
  const editingRef = useRef(false);
  const handleRef = useRef(null), gesture = useRef(null), latest = useRef(null);
  const [scrubbing, setScrubbing] = useState(false);
  latest.current = { onCommit, onScrubBoundary, disabled };
  const adjust = (delta, event) => {
    const current = gesture.current;
    if (!current || latest.current.disabled) return;
    const step = event.altKey ? 0.1 : event.shiftKey ? 10 : 1;
    const next = Math.round((current.value + delta * step) * 100) / 100;
    const bounded = dimension ? Math.max(1, Math.min(32768, next)) : next;
    if (bounded !== current.value && latest.current.onCommit(bounded, false) !== false) current.value = bounded;
  };
  const adjustRef = useRef(adjust); adjustRef.current = adjust;
  useEffect(() => {
    const handle = handleRef.current;
    const wheel = event => {
      if (!gesture.current) return;
      event.preventDefault(); event.stopPropagation();
      if (event.deltaY) adjustRef.current(-Math.sign(event.deltaY), event);
    };
    handle.addEventListener("wheel", wheel, { passive: false });
    return () => { handle.removeEventListener("wheel", wheel); if (gesture.current) latest.current.onScrubBoundary?.(); };
  }, []);
  const finish = event => {
    if (!gesture.current) return;
    const pointerId = gesture.current.pointerId;
    gesture.current = null; setScrubbing(false); latest.current.onScrubBoundary?.();
    if (event.currentTarget.hasPointerCapture(pointerId)) event.currentTarget.releasePointerCapture(pointerId);
  };
  const displayed = Number.isFinite(value) ? String(Math.round(value * 100) / 100) : "";
  const commit = () => { if (!editingRef.current) return; editingRef.current = false; setEditing(false); if (draft.trim() && Number(draft) !== Number(displayed)) onCommit(Number(draft)); };
  return <label className="uis-axis-field" title={`${label} · 像素；回车应用，Esc 取消`}><span ref={handleRef} tabIndex={disabled ? -1 : 0} className={`uis-axis-scrubber${scrubbing ? " is-scrubbing" : ""}`} aria-disabled={disabled}
    title="按住左右拖动或滚轮微调；Alt 精细，Shift 加速"
    onKeyDown={event => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      event.preventDefault(); event.stopPropagation();
      if (gesture.current) finish(event);
      if (key === "y" || event.shiftKey) editor?.redo(); else editor?.undo();
    }}
    onClick={event => event.preventDefault()}
    onPointerDown={event => {
      if (disabled || event.button !== 0 || !Number.isFinite(value)) return;
      event.preventDefault(); event.stopPropagation();
      editingRef.current = false; setEditing(false);
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = { value, x: event.clientX, remainder: 0, pointerId: event.pointerId };
      onScrubBoundary?.(); setScrubbing(true);
    }}
    onPointerMove={event => {
      const current = gesture.current; if (!current) return;
      current.remainder += event.clientX - current.x; current.x = event.clientX;
      const delta = Math.trunc(current.remainder / 4);
      if (delta) { current.remainder -= delta * 4; adjust(delta, event); }
    }}
    onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}>{shortLabel || label}</span><input aria-label={label} type="number" step="1" min={dimension ? 1 : undefined} max={dimension ? 32768 : undefined} disabled={disabled}
    value={editing ? draft : displayed} onFocus={() => { setDraft(displayed); setEditing(true); editingRef.current = true; }} onChange={e => setDraft(e.target.value)} onBlur={commit}
    onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") { commit(); e.currentTarget.blur(); } if (e.key === "Escape") { editingRef.current = false; setEditing(false); e.currentTarget.blur(); } }} /></label>;
}

export default function NodeInspector({ job, slice, treeNode, parentNode, editor, onChange, onError, onRefine, busy }) {
  const node = treeNode || { jobId: job.id, revision: job.revision, sliceId: slice?.id, slice };
  const preview = useValue("selected node preview", () => nodePreview(editor, node), [editor, node]);
  const visible = useValue("selected node visibility", () => uiNodeVisible(editor, node), [editor, node]);
  const coordinates = useValue("node world and local coordinates", () => nodeCoordinates(editor, node, parentNode), [editor, node, parentNode]);
  const [draft, setDraft] = useState(() => ({ ...(slice || {}), name: treeNode?.name || slice?.name || job.presetName || job.prompt }));
  const [working, setWorking] = useState(false), [variant, setVariant] = useState("canvas");
  const [dirty, setDirty] = useState(false);
  const [psdScale,setPsdScale] = useState(1);
  const metadataRevision = useRef(job.metadataRevision || 0);
  useEffect(() => {
    if (!dirty) { metadataRevision.current = job.metadataRevision || 0; setDraft({ ...(slice || {}), name: treeNode?.name || slice?.name || job.presetName || job.prompt }); }
  }, [job.metadataRevision, job.presetName, job.prompt, slice, treeNode?.name, dirty]);
  const [result, setResult] = useState(null), [expanded, setExpanded] = useState(false);
  const change = (key, value) => { setDraft(d => ({ ...d, [key]: value })); setDirty(true); };
  async function run(action) { setWorking(true); try { await action(); } catch (e) { onError(e.message); } finally { setWorking(false); } }
  async function save() { if (!dirty) return; if (node.instanceKey) updateCopyMetadata(editor, node, draft); else await uiApi(`jobs/${job.id}/metadata`, { revision: job.revision, metadataRevision: metadataRevision.current,
    ...(slice ? { slices: [{ ...draft, id: slice.id }] } : { presetName: draft.name }) }); setDirty(false); await onChange(); }
  const previewImage = <svg className="uis-node-preview uis-checker" viewBox={preview ? `${preview.x} ${preview.y} ${preview.w || 1} ${preview.h || 1}` : `0 0 ${slice?.w || job.width} ${slice?.h || job.height}`} aria-label="所选节点当前图像" role="img">
    {preview ? preview.images.map(s => <image key={s.id} href={s.src} x={s.bounds.x} y={s.bounds.y} width={s.bounds.w} height={s.bounds.h} opacity={s.opacity} />) : <image href={assetUrl(job, slice?.file || job.atlasFile)} width={slice?.w || job.width} height={slice?.h || job.height} />}
  </svg>;
  return <>
    <div className="uis-inspector-heading"><strong>{slice ? "组件属性" : "预设属性"}</strong><div className="uis-inspector-tools"><a href={assetUrl(job, slice?.file || job.exportFile)} download title={slice ? "下载 PNG" : "下载图层包"}>下载</a><button onClick={() => setExpanded(true)}>放大</button></div></div>
    {previewImage}
    {slice?.imageWidth && <p className="uis-hint">素材 {slice.imageWidth} × {slice.imageHeight} 像素 · 布局 {slice.w} × {slice.h}</p>}
    <section className="uis-transform" aria-label="变换">
      <div className="uis-inspector-heading"><strong>变换</strong><label className="uis-visible-toggle"><input type="checkbox" checked={visible} disabled={busy || !preview} onChange={e => setUiNodeVisible(editor, node, e.target.checked)} />显示</label></div>
      {[["world", "世界坐标"], ["local", "局部坐标"]].map(([space, title]) => <div className="uis-transform-row" key={space} role="group" aria-label={title}>
        <span className="uis-transform-label" title={space === "world" ? "相对于画布原点，X 向右、Y 向下" : parentNode ? `父节点：${parentNode.name}${!coordinates.parentWorld ? "（当前页缺少父节点图片）" : ""}` : "无父节点，与世界坐标一致"}>{title}</span>
        {[["x", "X"], ["y", "Y"]].map(([axis, label]) => <GeometryField editor={editor} key={axis} shortLabel={label} label={`${title} ${label}`} value={coordinates[space]?.[axis]} disabled={busy || !preview || !coordinates[space]} onScrubBoundary={() => editor.markHistoryStoppingPoint("微调坐标")} onCommit={(value, mark = true) => { try { setNodeCoordinate(editor, node, parentNode, space, axis, value, mark); } catch (e) { onError(e.message); return false; } }} />)}
      </div>)}
      <div className="uis-transform-row" role="group" aria-label="尺寸"><span className="uis-transform-label">尺寸</span>{[["w", "宽度", "W"], ["h", "高度", "H"]].map(([key, label, shortLabel]) => <GeometryField editor={editor} key={key} shortLabel={shortLabel} label={label} value={preview?.[key]} dimension disabled={busy || !preview} onScrubBoundary={() => editor.markHistoryStoppingPoint("微调尺寸")} onCommit={(value, mark = true) => { try { resizeUiNode(editor, node, { [key]: value }, mark); } catch (e) { onError(e.message); return false; } }} />)}</div>
    </section>
    <label className="uis-property-row"><span>名称</span><input aria-label={slice ? "组件名称" : "预设名称"} value={draft.name} onChange={e => change("name", e.target.value)} /></label>
    {slice && <><label className="uis-property-row"><span>类型</span><select aria-label="组件类型" title={slice.semanticSource === "ai" ? "AI 已分类，可人工校正" : slice.semanticSource === "manual" ? "已人工分类" : "类型待确认"} value={draft.layerType || "component"} onChange={e => change("layerType", e.target.value)}>{Object.entries(componentLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      {draft.layerType === "text" && <><label>文字内容<input value={draft.text || ""} onChange={e => change("text", e.target.value)} /></label>
        <label>字体 / TMP 字体资源名<input placeholder="未知可留空" value={draft.fontFamily || ""} onChange={e => change("fontFamily", e.target.value)} /></label>
        <div className="uis-fields"><label>字号<input type="number" min="1" max="512" value={draft.fontSize || 24} onChange={e => change("fontSize", Number(e.target.value))} /></label><label>字色<input type="color" value={draft.textColor || "#ffffff"} onChange={e => change("textColor", e.target.value)} /></label></div>
        <label>文字对齐<select value={draft.textAlign || "center"} onChange={e => change("textAlign", e.target.value)}><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label>
        <label>Unity 文字显示<select value={draft.textRender || "image"} onChange={e => change("textRender", e.target.value)}><option value="image">保留图片外观</option><option value="editable">可编辑文字（需对应 TMP 字体）</option></select></label></>}
    </>}
    <div className="uis-layer-actions"><button disabled={working || busy || job.canvasCandidate || !dirty} onClick={() => run(save)}>保存属性</button><button disabled={working || busy || job.canvasCandidate || Boolean(node.instanceKey)} title={node.instanceKey ? "请在原始节点进行 AI 分类" : undefined} onClick={() => run(async () => { await save(); await uiApi(`jobs/${job.id}/classify`, { revision: job.revision, sliceId: slice?.id }); await onChange(); })}>AI 识别类型</button></div>
    <button className="uis-primary" title={node.instanceKey ? "请在原始节点继续细分" : undefined} disabled={working || busy || job.canvasCandidate || Boolean(node.instanceKey)} onClick={() => onRefine({ job, slice })}>拆分</button>
    <details className="uis-node-export"><summary>导出预设 · PSD / Unity</summary>
      <label>导出内容<select value={variant} onChange={e => { setVariant(e.target.value); setResult(null); }}><option value="canvas">当前画布布局（含副本、层级和显隐）</option><option value="latest">使用最新成功的子图层</option><option value="source">使用当前节点原图</option></select></label>
      <p className="uis-hint">{variant === "canvas" ? "按所选节点当前的画布位置、尺寸和层级导出，包含其子节点。建议选择拼回结果组，避免把旁边的原图也纳入预设。支持直角旋转和翻转；任意旋转、裁剪须先恢复。" : "按原始像素布局导出。最新分层会替换原图；不包含画布编辑。"} PSD 保留图片图层，文字和字体信息随清单保存。</p>
      <label>PSD 输出倍率<select value={psdScale} onChange={e=>setPsdScale(Number(e.target.value))}><option value={1}>1× 布局尺寸</option><option value={2}>2×</option><option value={4}>4×</option></select></label><p className="uis-hint">PNG 和 Unity 保留素材分辨率。PSD 按所选倍率生成，清晰度取决于素材本身。</p>
      <div className="uis-layer-actions">{[["psd", "生成 PSD"], ["unity", "生成 Unity 包"]].map(([format, label]) => <button key={format} disabled={working || busy || job.canvasCandidate} onClick={() => run(async () => {
        const canvas = variant === "canvas" ? captureCanvasPreset(editor, { ...node, name: draft.name, ...(slice && dirty ? { slice: { ...slice, ...draft } } : {}) }) : undefined;
        await save(); const output = await uiApi(`jobs/${job.id}/export`, { revision: job.revision, sliceId: slice?.id, variant, format, canvas, scale:psdScale }); setResult(output);
      })}>{label}</button>)}</div>
      {result && <><img className="uis-node-preview uis-checker" src={assetUrl(job, result.previewFile)} alt="本次导出预览" /><div className="uis-layer-actions"><a href={assetUrl(job, result.file)} download>下载导出文件</a><a href={assetUrl(job, result.manifestFile)} download>组件清单</a></div></>}
    </details>
    {expanded && <div className="uis-modal-backdrop"><section className="uis-dialog uis-preview-dialog" role="dialog" aria-label="节点预览"><h2>{draft.name}</h2>{previewImage}<button onClick={() => setExpanded(false)}>关闭预览</button></section></div>}
  </>;
}
