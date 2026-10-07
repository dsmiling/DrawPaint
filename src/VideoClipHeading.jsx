import UiIcon from "./UiIcon.jsx";
import { videoQueueLabel } from "../shared/video-queue.js";

export default function VideoClipHeading({ clip, generationJob, onChange, onBegin, onEnd }) {
  const status = clip.status === "running" ? videoQueueLabel(generationJob) : { draft: "待生成", failed: "失败" }[clip.status];
  return <div className="vs-clip-heading">
    <span title={clip.frameAnimation?.enabled ? "帧动画视频" : "正常视频"}><UiIcon name={clip.status === "draft" ? "newVideo" : clip.frameAnimation?.enabled ? "frames" : "video"} /></span>
    <input aria-label="片段名称" title="片段名称" placeholder="片段名称" maxLength={100} value={clip.name} disabled={Boolean(clip.locked)} onFocus={onBegin} onBlur={onEnd} onChange={event => onChange({ name: event.target.value })} />
    {status && <small>{status}</small>}
  </div>;
}
