import { useEffect, useRef, useState } from "react";
import { videoFrameRange } from "../shared/video-frame-range.js";
import VideoBackgroundPreview from "./VideoBackgroundPreview.jsx";
import { FRAME_ANIMATION_GUIDE } from "../shared/frame-animation.js";
import { FRAME_ANIMATION_TEMPLATES } from "../shared/frame-animation-templates.js";
import { clipRate, durationOf, endOf, exportable } from "../shared/video-editing.js";

const palette = [{ value: "auto", name: "自动检测" }, { value: "#ff00ff", name: "品红色" }, { value: "#00ff00", name: "绿色" }, { value: "#ffffff", name: "白色" }, { value: "#000000", name: "黑色" }, { value: "#e5e7eb", name: "浅灰色" }];
const keyPrompt = FRAME_ANIMATION_GUIDE;

export default function VideoSequenceExport({ clips, initialClipId, initialFrameRange = false, job, submitting, onExport, onClose, onSave, error }) {
  const dialogRef = useRef(null);
  const [scope, setScope] = useState(initialClipId ? `${initialFrameRange ? "range:" : ""}${initialClipId}` : "timeline");
  const template = FRAME_ANIMATION_TEMPLATES.find(item => item.prompt === clips.find(clip => clip.id === initialClipId)?.prompt);
  const [fps, setFps] = useState(template?.fps || 12), [maxSize, setMaxSize] = useState(512);
  const [imageFormat, setImageFormat] = useState("png"), [loop, setLoop] = useState(template?.loop ?? true);
  const [resampling, setResampling] = useState("smooth");
  const [background, setBackground] = useState(() => {
    const preset = clips.find(clip => clip.id === initialClipId)?.frameAnimation;
    return { removeBackground: initialFrameRange, background: preset?.enabled ? preset.background : "auto", removalMode: preset?.enabled ? "color" : "edge", tolerance: 12, feather: 4, edgeDecontaminate: true, edgeTrim: 0 };
  });
  const [copyStatus, setCopyStatus] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const complete = clips.filter(clip => clip.status === "completed" && clip.source);
  const useFrameRange = scope.startsWith("range:");
  const chosen = complete.find(clip => clip.id === scope.replace(/^range:/, ""));
  const range = chosen && videoFrameRange(chosen);
  const duration = scope === "timeline" ? Math.max(0, ...complete.filter(exportable).map(endOf)) : chosen ? useFrameRange ? (range.end - range.start) / clipRate(chosen) : durationOf(chosen) : 0;
  const frameCount = duration > 0 ? Math.max(1, Math.ceil(duration * fps - 0.0001)) : 0;
  const running = submitting || job?.status === "running";
  const valid = duration > 0 && frameCount <= 1200 && (!useFrameRange || range?.valid);
  const changeBackground = (key, value) => setBackground(current => ({ ...current, [key]: value }));
  useEffect(() => { dialogRef.current?.showModal(); }, []);
  useEffect(() => { if (job?.status === "completed") setPreviewOpen(true); }, [job?.id, job?.status]);
  useEffect(() => {
    if (chosen?.frameAnimation?.enabled) setBackground(current => ({ ...current, background: chosen.frameAnimation.background, removalMode: "color" }));
  }, [chosen?.id, chosen?.frameAnimation]);
  return <dialog ref={dialogRef} className="vs-sequence-dialog" aria-labelledby="vs-sequence-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="vs-sequence-heading"><div><h2 id="vs-sequence-title">生成序列帧动画</h2><p>预览透明效果，生成逐帧图片和精灵图集，导出 ZIP 即可使用。</p></div><button type="button" aria-label="关闭序列帧导出" onClick={onClose}>×</button></div>
    {(!previewOpen || job?.status !== "completed") && <form onSubmit={event => { event.preventDefault(); setPreviewOpen(false); onExport({ format: "sequence", ...(chosen ? { clipId: chosen.id, useFrameRange } : {}), fps, maxSize, imageFormat, resampling, loop, backgroundRemoval: background }); }}>
      <div className="vs-sequence-setup"><div className="vs-sequence-settings">
        <label>生成范围<select value={scope} disabled={running} onChange={event => setScope(event.target.value)}><option value="timeline">整条时间线</option>{complete.map(clip => <optgroup key={clip.id} label={clip.name}><option value={`range:${clip.id}`}>{clip.name}（当前首尾帧）</option><option value={clip.id}>{clip.name}（当前裁切）</option></optgroup>)}</select></label>
        <div className="vs-sequence-fields">
          <label>动画帧率<select value={fps} disabled={running} onChange={event => setFps(Number(event.target.value))}>{[6, 8, 12, 15, 24, 30, 60].map(value => <option key={value} value={value}>{value} fps</option>)}</select></label>
          <label>图片格式<select value={imageFormat} disabled={running} onChange={event => setImageFormat(event.target.value)}><option value="png">PNG</option><option value="webp">WebP（无损）</option></select></label>
        </div>
        <label>单帧最长边<select value={maxSize} disabled={running} onChange={event => setMaxSize(Number(event.target.value))}>{[64, 128, 256, 512, 1024, 2048].map(value => <option key={value} value={value}>{value} px</option>)}</select><small>保持比例和帧对齐，不放大小尺寸素材。</small></label>
        <label>缩放方式<select aria-label="序列帧缩放方式" value={resampling} disabled={running} onChange={event => setResampling(event.target.value)}><option value="smooth">平滑</option><option value="nearest">像素（最近邻）</option></select><small>像素模式保留采样点颜色；需要硬边时将边缘过渡设为 0。</small></label>
        <div className="vs-sequence-switches"><label className="vs-sequence-loop"><input type="checkbox" checked={loop} disabled={running} onChange={event => setLoop(event.target.checked)} />循环播放</label><label className="vs-sequence-loop"><input type="checkbox" checked={background.removeBackground} disabled={running} onChange={event => changeBackground("removeBackground", event.target.checked)} />剔除背景（透明通道）</label></div>
        {background.removeBackground && <div className="vs-sequence-key-fields">
          <div className="vs-sequence-fields"><label>背景颜色<select value={palette.some(item => item.value === background.background) ? background.background : "custom"} disabled={running} onChange={event => changeBackground("background", event.target.value === "custom" ? "#1f2b42" : event.target.value)}>{palette.map(item => <option key={item.value} value={item.value}>{item.name}</option>)}<option value="custom">自选 / 原帧取色</option></select></label><label>去背景方式<select value={background.removalMode} disabled={running} onChange={event => changeBackground("removalMode", event.target.value)}><option value="edge">从外部移除</option><option value="color">移除全部同色区域</option></select></label></div>
          {background.background !== "auto" && <label className="vs-key-color">自选背景色 <input aria-label="自选背景色" type="color" value={background.background} disabled={running} onChange={event => changeBackground("background", event.target.value)} /><span>{background.background}</span></label>}
          <div className="vs-sequence-fields">{[["tolerance", "颜色容差", 150], ["feather", "边缘过渡", 60]].map(([key, label, max]) => <label key={key}>{label} · {background[key]}<input aria-label={label} type="range" min="0" max={max} step="1" value={background[key]} disabled={running} onChange={event => changeBackground(key, Number(event.target.value))} /></label>)}</div>
          <label className="vs-sequence-loop"><input type="checkbox" checked={background.edgeDecontaminate} disabled={running} onChange={event => changeBackground("edgeDecontaminate", event.target.checked)} />净化色边</label>
          <label className="vs-sequence-loop"><input type="checkbox" checked={background.hardAlpha === true} disabled={running} onChange={event => changeBackground("hardAlpha", event.target.checked)} />硬边透明（像素素材）</label><small>不透明度低于 50% 的像素清除，其余设为完全不透明。柔光和半透明细节会变为硬边。</small>
          <label>边缘收缩 · {background.edgeTrim} px<input aria-label="边缘收缩" type="range" min="0" max="3" step="1" value={background.edgeTrim} disabled={running} onChange={event => changeBackground("edgeTrim", Number(event.target.value))} /><small>0 保留细羽毛；有残边时尝试 1。数值过大会削薄描边。</small></label>
        </div>}
      </div><div className="vs-sequence-review">
        {chosen ? <VideoBackgroundPreview source={chosen.source} time={useFrameRange ? range.start : chosen.in} maxSize={maxSize} resampling={resampling} options={background} onChange={setBackground} disabled={running} /> : <p className="vs-key-help">整条时间线会按图层顺序合成。各片段建议使用相同纯色背景；生成完成后可预览整段透明动画。</p>}
        <div className={`vs-sequence-summary ${!valid ? "is-error" : ""}`}>{Math.max(0, duration).toFixed(2)} 秒 · 约 {frameCount} 帧{frameCount > 1200 ? " · 超过 1200 帧，请降低帧率或裁短片段" : useFrameRange && !range?.valid ? " · 首帧不能晚于尾帧" : ""}</div>
        <p className="vs-key-help">适合纯色背景视频。自动检测固定首帧背景色，所有帧使用同一组参数；复杂场景需要先准备干净背景。</p>
        <details className="vs-key-guide"><summary>生图底色规范</summary><p>{keyPrompt}</p><button type="button" onClick={async () => { try { await navigator.clipboard.writeText(keyPrompt); setCopyStatus("已复制"); } catch { setCopyStatus("复制失败，请选中文字复制"); } }}>复制底色提示词</button><small role="status">{copyStatus}</small></details>
      </div></div>
      <div className="vs-sequence-actions"><button type="button" onClick={onClose}>{running ? "后台生成" : "关闭"}</button><button type="submit" className="vs-primary" disabled={running || !valid}>{running ? job?.phase === "matting" ? `正在剔除背景… ${job.processedFrames || 0}/${job.frameCount}` : job?.phase === "packing" ? "正在生成图集…" : job?.phase === "archiving" ? "正在打包…" : "正在提取序列帧…" : "生成并预览"}</button></div>
    </form>}
    {job?.status === "failed" && <p className="vs-sequence-error" role="alert">{job.error}</p>}
    {error && <p className="vs-sequence-error" role="alert">{error}</p>}
    {job?.status === "completed" && <div className="vs-sequence-result" role="status"><strong>动画已生成{job.backgroundRemoval?.removeBackground ? " · 透明通道" : ""}</strong><p>{job.frameCount} 帧 · {job.fps} fps · {job.width} × {job.height} · {job.sheetCount} 张图集</p>{job.warnings?.map(warning => <p className="vs-sequence-error" key={warning}>{warning}</p>)}<div className="vs-sequence-actions"><button type="button" aria-expanded={previewOpen} onClick={() => setPreviewOpen(current => !current)}>{previewOpen ? "调整参数" : "预览动画"}</button>{typeof window.showSaveFilePicker === "function" && <button type="button" onClick={() => onSave(job)}>选择保存位置…</button>}<a className="vs-sequence-download" href={job.url} download={job.filename}>下载序列帧 ZIP</a></div>{previewOpen && <iframe className="vs-sequence-preview" title="序列帧动画预览" sandbox="allow-scripts" src={job.previewUrl} />}</div>}
  </dialog>;
}
