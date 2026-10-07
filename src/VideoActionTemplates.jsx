import { FRAME_ANIMATION_TEMPLATES } from "../shared/frame-animation-templates.js";

export default function VideoActionTemplates({ prompt, onApply, disabled }) {
  const selected = FRAME_ANIMATION_TEMPLATES.find(template => template.prompt === prompt);
  return <div className="vs-action-templates">
    <label>帧动画动作模板<select aria-label="帧动画动作模板" value={selected?.id || ""} disabled={disabled} onChange={event => {
      const template = FRAME_ANIMATION_TEMPLATES.find(item => item.id === event.target.value);
      if (template) onApply(template);
    }}><option value="">选择模板填入动作描述…</option>{FRAME_ANIMATION_TEMPLATES.map(template => <option key={template.id} value={template.id}>{template.name}{template.loop ? " · 循环" : " · 单次"}</option>)}</select></label>
    <p className="vs-help">{selected ? `建议 ${selected.seconds} 秒 · ${selected.fps} fps 导出 · ${selected.loop ? "循环播放，检查首尾接缝" : "单次播放，导出时关闭循环"}。可继续修改动作描述。` : "选择后填入动作描述并启用帧动画用途。行走和跑步保持原地，朝向沿用首帧。"}</p>
  </div>;
}
