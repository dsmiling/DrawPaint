import VideoAnimationSettings from "./VideoAnimationSettings.jsx";
import VideoActionTemplates from "./VideoActionTemplates.jsx";
import { videoQueueLabel } from "../shared/video-queue.js";

const imageUrl = id => `/api/video/reference-images/${id}.png`;
export default function VideoDraftEditor({ clip, generationJob, setup, busy, onChange, onImage, onGenerate, onModels, onImport, onLibrary, onBegin, onEnd }) {
  const generating = clip.status === "running";
  const model = setup?.models.find(item => item.id === clip.modelId), disabled = Boolean(clip.locked || busy || generating);
  return <form className="vs-draft-editor" onSubmit={event => { event.preventDefault(); if (!disabled) onGenerate(); }}>
    <div className="vs-property-heading"><strong>{generating ? generationJob?.queueState === "queued" ? "已加入生成队列" : "正在生成这个片段" : "生成这个片段"}</strong><button type="button" disabled={generating} onClick={onModels}>模型设置</button></div>
    <label>视频生成模型<select aria-label="片段生成模型" value={clip.modelId || "minimax-h3"} disabled={disabled} onChange={event => {
      const choice = setup?.models.find(item => item.id === event.target.value), length = choice?.durations.includes(clip.out) ? clip.out : choice?.durations[0] || 2;
      onChange({ modelId: event.target.value, in: 0, out: length, mediaDuration: length, ...(choice?.supportsEndFrame ? {} : { lastImageId: null }) });
    }}>{(setup?.models || [{ id: "minimax-h3", name: "MiniMax H3" }]).map(item => <option key={item.id} value={item.id}>{item.name} · {item.ready ? "可生成" : "需设置"}</option>)}</select></label>
    <VideoAnimationSettings value={clip.frameAnimation} onChange={frameAnimation => onChange({ frameAnimation })} disabled={disabled} />
    <VideoActionTemplates prompt={clip.prompt} disabled={disabled} onApply={template => {
      const length = model?.durations.includes(template.seconds) ? template.seconds : model?.durations[0] || template.seconds;
      onChange({ prompt: template.prompt, frameAnimation: { ...clip.frameAnimation, enabled: true }, in: 0, out: length, mediaDuration: length });
    }} />
    <div className="vs-draft-frames">{[["firstImageId", "首帧图片", true], ["lastImageId", "尾帧图片（可选）", model?.supportsEndFrame]].filter(([, , allowed]) => allowed).map(([key, label]) => <div className="vs-draft-frame" key={key}>
      <label>{label}<span className="vs-draft-image">{clip[key] ? <img src={imageUrl(clip[key])} alt={label} /> : <span>＋ 选择图片</span>}<input aria-label={label} type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled} onChange={event => { onImage(key, event.target.files?.[0]); event.target.value = ""; }} /></span></label>
      {clip[key] && <button type="button" disabled={disabled} onClick={() => onChange({ [key]: null })}>清除{key === "firstImageId" ? "首帧" : "尾帧"}</button>}
    </div>)}</div>
    <label>动作描述<textarea aria-label="待生成片段动作描述" rows="5" maxLength={2000} required value={clip.prompt || ""} disabled={disabled} onFocus={onBegin} onBlur={onEnd} onChange={event => onChange({ prompt: event.target.value })} placeholder="描述角色动作、镜头与场景变化…" /></label>
    <label>生成时长<select aria-label="生成时长" value={clip.out} disabled={disabled} onChange={event => { const length = Number(event.target.value); onChange({ in: 0, out: length, mediaDuration: length }); }}>{(model?.durations || [2, 3, 5]).map(length => <option key={length} value={length}>{length} 秒</option>)}</select></label>
    {!model?.ready && <p className="vs-help">先在模型设置中检查并启动视频模型。</p>}
    <button type="submit" className="vs-primary" disabled={disabled || !model?.ready || !clip.firstImageId || !clip.prompt.trim()}>{generating ? videoQueueLabel(generationJob) : busy ? "正在提交…" : clip.frameAnimation?.enabled ? "生成帧动画视频" : "生成正常视频"}</button>
    <p className="vs-property-note">{generating ? "已保存以上生成参数，完成后会自动填入这个片段。可在右上角查看队列。" : "片段和关键帧会随画布保存。也可以直接填入已有视频。"}</p>
    <div className="vs-property-actions"><button type="button" disabled={disabled} onClick={onImport}>导入到这个片段</button><button type="button" disabled={disabled} onClick={onLibrary}>从素材库选取</button></div>
  </form>;
}
