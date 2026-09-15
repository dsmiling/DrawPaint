import { useState } from "react";
import { assetUrl } from "./api.js";
import { componentLabels } from "../../shared/ui-schema.mjs";

export default function ReviewDialog({ job, onClose, onSave }) {
  const [slices, setSlices] = useState(() => job.slices.map(s => ({ ...s })));
  const [selected, setSelected] = useState([]);
  const [drawing, setDrawing] = useState(false);
  const [drag, setDrag] = useState(null);
  const [original, setOriginal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(100);
  const active = selected.length === 1 ? slices.find(s => s.id === selected[0]) : null;
  function update(change) { setSlices(rows => rows.map(s => selected.includes(s.id) ? { ...s, ...change } : s)); }
  function point(e) {
    const box = e.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(job.width, Math.round((e.clientX - box.left) * job.width / box.width))),
      y: Math.max(0, Math.min(job.height, Math.round((e.clientY - box.top) * job.height / box.height))) };
  }
  function finish(e) {
    if (!drag) return;
    const end = point(e); const x = Math.min(drag.x, end.x), y = Math.min(drag.y, end.y), w = Math.abs(end.x - drag.x), h = Math.abs(end.y - drag.y);
    if (w > 0 && h > 0) {
      const id = crypto.randomUUID();
      setSlices(rows => [...rows, { id, name: `ui_custom_${rows.length + 1}`, x, y, w, h, componentIds: null }]);
      setSelected([id]);
    }
    setDrag(null); setDrawing(false);
  }
  function merge() {
    const rows = slices.filter(s => selected.includes(s.id));
    const x = Math.min(...rows.map(s => s.x)), y = Math.min(...rows.map(s => s.y));
    const id = crypto.randomUUID();
    const combined = { id, name: rows[0].name, x, y, w: Math.max(...rows.map(s => s.x + s.w)) - x,
      h: Math.max(...rows.map(s => s.y + s.h)) - y,
      componentIds: rows.every(s => s.componentIds?.length) ? [...new Set(rows.flatMap(s => s.componentIds))] : null };
    setSlices(rows => [...rows.filter(s => !selected.includes(s.id)), combined]); setSelected([id]);
  }
  function split(axis) {
    if (!active || active[axis] < 2) return;
    const first = { ...active, id: crypto.randomUUID(), name: `${active.name}_a`, [axis]: Math.floor(active[axis] / 2) };
    const second = { ...active, id: crypto.randomUUID(), name: `${active.name}_b`, [axis]: active[axis] - first[axis] };
    second[axis === "w" ? "x" : "y"] += first[axis];
    setSlices(rows => [...rows.filter(s => s.id !== active.id), first, second]); setSelected([first.id, second.id]);
  }
  return <div className="uis-modal-backdrop" onKeyDown={e => { if (e.key === "Escape" && !saving) onClose(); }}>
    <section className="uis-review" role="dialog" aria-modal="true" aria-label="校正 UI 切片">
      <header><div><h2>校正切片</h2><p>{job.width} × {job.height} · {slices.length} 个组件 · Shift 点击多选</p></div><button onClick={onClose} disabled={saving}>关闭</button></header>
      <div className="uis-review-tools">
        <button className={drawing ? "is-active" : ""} onClick={() => setDrawing(!drawing)}>框选新增</button>
        <button disabled={selected.length < 2} onClick={merge}>合并所选</button>
        <button disabled={!active || active.w < 2} onClick={() => split("w")}>左右拆分</button>
        <button disabled={!active || active.h < 2} onClick={() => split("h")}>上下拆分</button>
        <button disabled={!selected.length} onClick={() => { setSlices(rows => rows.filter(s => !selected.includes(s.id))); setSelected([]); }}>移除所选</button>
        <label><input type="checkbox" checked={original} onChange={e => setOriginal(e.target.checked)} />查看原图</label>
        <label>缩放 <select value={zoom} onChange={e => setZoom(Number(e.target.value))}><option>100</option><option>150</option><option>200</option><option>300</option></select>%</label>
      </div>
      <div className="uis-review-body"><div className="uis-review-scroll">
        <svg className={`uis-checker ${drawing ? "is-drawing" : ""}`} style={{ width: `${zoom}%` }} viewBox={`0 0 ${job.width} ${job.height}`}
          role="img" aria-label="切片范围预览"
          onPointerDown={e => { if (drawing) { e.currentTarget.setPointerCapture(e.pointerId); setDrag(point(e)); } }}
          onPointerMove={e => { if (drag) { const end = point(e); setDrag(start => ({ ...start, end })); } }} onPointerUp={finish} onPointerCancel={() => setDrag(null)}>
          <image href={assetUrl(job, original ? job.sourceFile : job.atlasFile)} width={job.width} height={job.height} />
          {slices.map(s => <g key={s.id} onClick={e => {
            if (drawing) return; e.stopPropagation(); setSelected(ids => e.shiftKey ? ids.includes(s.id) ? ids.filter(id => id !== s.id) : [...ids, s.id] : [s.id]);
          }}><rect x={s.x} y={s.y} width={s.w} height={s.h} fill={selected.includes(s.id) ? "#7461ef25" : "transparent"}
            stroke={selected.includes(s.id) ? "#7c3aed" : "#3296ed"} strokeWidth={selected.includes(s.id) ? 3 : 1} vectorEffect="non-scaling-stroke" />
            <text x={s.x + 3} y={s.y + 15} fontSize={Math.max(12, job.width / 100)} fill="#5526ad" stroke="white" strokeWidth="2" paintOrder="stroke">{s.name}</text></g>)}
          {drag?.end && <rect x={Math.min(drag.x, drag.end.x)} y={Math.min(drag.y, drag.end.y)} width={Math.abs(drag.end.x - drag.x)} height={Math.abs(drag.end.y - drag.y)} fill="#7461ef20" stroke="#7c3aed" strokeWidth="2" />}
        </svg></div>
        <aside className="uis-review-details">
          <h3>组件属性</h3>
          {active ? <><label>名称<input value={active.name} onChange={e => update({ name: e.target.value })} /></label>
            <label>组件类型<select value={active.layerType || "component"} onChange={e => update({ layerType: e.target.value, semanticSource: "manual" })}>{Object.entries(componentLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
            {active.layerType === "text" && <label>文字内容<input value={active.text || ""} onChange={e => update({ text: e.target.value, semanticSource: "manual" })} /></label>}
            <div className="uis-fields">{["x", "y", "w", "h"].map(key => <label key={key}>{({ x: "X", y: "Y", w: "宽", h: "高" })[key]}<input type="number" value={active[key]} min={key === "w" || key === "h" ? 1 : 0}
              onChange={e => update({ [key]: Number(e.target.value), componentIds: null })} /></label>)}</div>
            <p>调整范围后会提取矩形内全部可见像素。可用“框选新增”补选漏掉的组件。</p></> : <p>{selected.length ? `已选 ${selected.length} 个组件，可合并或移除。` : "点击蓝色切片框查看和修改属性。"}</p>}
          <div className="uis-slice-list">{slices.map(s => <button key={s.id} className={selected.includes(s.id) ? "is-active" : ""}
            onClick={e => setSelected(ids => e.shiftKey ? [...new Set([...ids, s.id])] : [s.id])}>{s.name}<small>{s.w} × {s.h}</small></button>)}</div>
        </aside></div>
      <footer><span role="alert">{error || "原图保留。修改只更新本次 UI 任务的切片。"}</span><button className="uis-primary" disabled={saving || !slices.length}
        onClick={async () => { setSaving(true); setError(""); try { await onSave(slices); } catch (e) { setError(e.message); setSaving(false); } }}>{saving ? "正在保存…" : "保存并更新 UI 画布"}</button></footer>
    </section>
  </div>;
}
