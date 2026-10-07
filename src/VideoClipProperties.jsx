import { useRef, useState } from "react";
import { durationOf, endOf, VIDEO_TRACKS } from "../shared/video-editing.js";

export function VideoNumberField({ label, value, onCommit, disabled, min, max, step = 1, onBegin, onEnd }) {
  const [draft, setDraft] = useState(null);
  const cancelled = useRef(false);
  const commit = () => {
    if (!cancelled.current && draft !== null && draft.trim() && Number.isFinite(Number(draft))) onCommit(Number(draft));
    setDraft(null); onEnd?.();
  };
  return <label>{label}<input aria-label={label} type="number" value={draft ?? Math.round(value * 1000000) / 1000000} min={min} max={max} step={step} disabled={disabled}
    onFocus={() => { cancelled.current = false; setDraft(String(Math.round(value * 1000000) / 1000000)); onBegin?.(); }} onChange={event => setDraft(event.target.value)} onBlur={commit}
    onKeyDown={event => { event.stopPropagation(); if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { cancelled.current = true; event.currentTarget.blur(); } }} /></label>;
}

export default function VideoClipProperties({ clip, onChange, onBegin, onEnd }) {
  const disabled = Boolean(clip.locked);
  const field = (key, label, value, min, max, step = 1) => <VideoNumberField key={key} label={label} value={value} min={min} max={max} step={step} disabled={disabled} onBegin={onBegin} onEnd={onEnd} onCommit={value => onChange({ [key]: value })} />;
  return <section className="vs-properties" aria-label="所选视频片段属性">
    <div className="vs-property-heading"><strong>片段属性</strong><span>{({ draft: "待生成", running: "生成中", failed: "失败", completed: "已完成" })[clip.status]}</span></div>
    <label>片段名称<input aria-label="片段名称" maxLength={100} value={clip.name} disabled={disabled} onFocus={onBegin} onBlur={onEnd} onChange={event => onChange({ name: event.target.value })} /></label>
    <div className="vs-property-flags">{[["hidden", "隐藏", clip.hidden], ["locked", "锁定", clip.locked], ["muted", "静音", clip.muted]].map(([key, label, checked]) => <label key={key}><input type="checkbox" checked={Boolean(checked)} onChange={event => onChange({ [key]: event.target.checked })} />{label}</label>)}</div>
    <div className="vs-property-grid">{field("position", "时间线起点（秒）", clip.position, 0, 3600, 1 / 24)}<label>轨道<select aria-label="片段轨道" value={clip.track} disabled={disabled} onChange={event => onChange({ track: Number(event.target.value) })}>{Array.from({ length: VIDEO_TRACKS }, (_, i) => <option key={i} value={i}>V{i + 1}</option>)}</select></label></div>
    {clip.source && <>
      <div className="vs-property-grid">{field("in", "裁剪起点（秒）", clip.in, 0, clip.out - 1 / (clip.fps || 24), 1 / (clip.fps || 24))}{field("out", "裁剪终点（秒）", clip.out, clip.in + 1 / (clip.fps || 24), clip.mediaDuration, 1 / (clip.fps || 24))}</div>
      <div className="vs-property-grid"><label>播放速度<select aria-label="播放速度" value={clip.playbackRate ?? 1} disabled={disabled} onChange={event => onChange({ playbackRate: Number(event.target.value) })}>{[.25, .5, .75, 1, 1.25, 1.5, 2, 4].map(rate => <option value={rate} key={rate}>{rate}×</option>)}</select></label><label>音量 · {Math.round((clip.volume ?? 1) * 100)}%<input aria-label="片段音量" type="range" min="0" max="100" value={Math.round((clip.volume ?? 1) * 100)} disabled={disabled || clip.muted} onPointerDown={onBegin} onPointerUp={onEnd} onChange={event => onChange({ volume: Number(event.target.value) / 100 })} /></label></div>
      <p className="vs-property-note">片段 {durationOf(clip).toFixed(2)} 秒 · 时间线终点 {endOf(clip).toFixed(2)} 秒</p>
    </>}
  </section>;
}
