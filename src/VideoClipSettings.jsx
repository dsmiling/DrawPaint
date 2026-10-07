import { useEffect, useRef } from "react";
import { nodePosition, nodeSize } from "../shared/video-editing.js";
import VideoClipProperties, { VideoNumberField } from "./VideoClipProperties.jsx";
import { IconButton } from "./UiIcon.jsx";

export default function VideoClipSettings({ clip, index, onChange, onBegin, onEnd, onClose }) {
  const dialog = useRef(null);
  const point = nodePosition(clip, index), size = nodeSize(clip);
  useEffect(() => { dialog.current.showModal(); }, []);
  const field = (key, label, value, min, max) => <VideoNumberField key={key} label={label} value={value} min={min} max={max} disabled={Boolean(clip.locked)} onBegin={onBegin} onEnd={onEnd} onCommit={value => onChange({ [key]: value })} />;
  return <dialog ref={dialog} className="vs-canvas-dialog vs-node-dialog vs-clip-settings-dialog" aria-labelledby="vs-clip-settings-title" onCancel={onClose}>
    <div className="vs-clip-settings-heading"><h2 id="vs-clip-settings-title">片段设置</h2><IconButton icon="close" label="关闭片段设置" onClick={onClose} /></div>
    <VideoClipProperties clip={clip} onChange={onChange} onBegin={onBegin} onEnd={onEnd} />
    <details className="vs-clip-layout"><summary>画布节点位置与尺寸</summary>
      <div className="vs-property-grid">{field("nodeX", "节点 X", point.x, -10000, 10000)}{field("nodeY", "节点 Y", point.y, -10000, 10000)}{field("nodeWidth", "节点宽度", size.width, 180, 600)}{field("nodeHeight", "节点高度", size.height, 180, 600)}</div>
      <p>节点位置用于整理画布；视频播放顺序和层级由时间线决定。</p>
      {clip.source && <p>{clip.source.type === "asset" ? "导入视频" : "生成视频"} · {clip.mediaWidth && clip.mediaHeight ? `${clip.mediaWidth} × ${clip.mediaHeight} · ` : ""}{clip.fps || 24} fps · 原片 {Number(clip.mediaDuration || clip.out).toFixed(2)} 秒</p>}
    </details>
    <div className="vs-node-dialog-actions"><button type="button" autoFocus onClick={onClose}>完成</button></div>
  </dialog>;
}
