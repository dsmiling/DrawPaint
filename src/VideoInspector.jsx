import { useEffect, useState } from "react";
import { blobToDataUrl } from "./api.js";
import useVideoPromptModels from "./useVideoPromptModels.js";
import VideoRangePreview from "./VideoRangePreview.jsx";
import FrameSequencePreview from "./FrameSequencePreview.jsx";
import { VIDEO_PROMPT_PROVIDERS } from "../shared/video-prompt-options.js";
import VideoAnimationSettings from "./VideoAnimationSettings.jsx";
import VideoActionTemplates from "./VideoActionTemplates.jsx";
import { clipRate } from "../shared/video-editing.js";

const timeLabel = time => `${Math.floor(time / 60).toString().padStart(2, "0")}:${Math.floor(time % 60).toString().padStart(2, "0")}.${Math.floor((time % 1) * 100).toString().padStart(2, "0")}`;
const roundFrame = (time, fps) => Math.round(time * fps) / fps;
const frameUrl = (source, time) => `/api/video/frame?type=${source.type}&id=${source.id}&time=${(Math.floor(time * 1000) / 1000).toFixed(3)}`;
const operations = [{ id: "polish", name: "优化润色" }, { id: "motion", name: "细化动作" }, { id: "camera", name: "镜头表达" }];

async function frameData(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("读取首尾帧失败");
  return blobToDataUrl(await response.blob());
}

export default function VideoInspector({ selected, sequence, frameTime, setFrameTime, setPlayhead, setPlaying, playing, updateClip, prompt, setPrompt, seconds, setSeconds, regenerate, busy, ready, videoModel, createFrameAnimation, generationSettings, setGenerationSettings, onBegin, onEnd }) {
  const [showSource, setShowSource] = useState(false);
  const [compact, setCompact] = useState(() => { try { return localStorage.getItem("drawpaint.video-inspector.compact") === "true"; } catch { return false; } });
  const { provider, setProvider, models, model, setModel, loading: modelsLoading, ready: promptReady, error: modelError } = useVideoPromptModels();
  const [refining, setRefining] = useState(false), [suggestion, setSuggestion] = useState(""), [recognition, setRecognition] = useState(null), [refineError, setRefineError] = useState("");
  const fps = selected.fps || 24, step = 1 / fps;
  const first = selected.startFrame ?? selected.in;
  const last = selected.endFrame ?? Math.max(selected.in, selected.out - step);
  const current = Math.max(selected.in, Math.min(frameTime, selected.out - step));

  useEffect(() => { try { localStorage.setItem("drawpaint.video-inspector.compact", String(compact)); } catch { /* mode still works */ } }, [compact]);

  function seek(value) {
    setFrameTime(value);
    setPlayhead(selected.position + (value - selected.in) / clipRate(selected));
    setPlaying(false);
  }

  async function refine(operation) {
    setRefining(true); setRefineError(""); setSuggestion(""); setRecognition(null);
    try {
      const [startImage, endImage] = await Promise.all([frameData(frameUrl(selected.source, first)), frameData(frameUrl(selected.source, last))]);
      const response = await fetch("/api/video/refine-prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, model, operation, prompt, startImage, endImage }) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || "润色失败");
      setSuggestion(value.prompt);
      setRecognition({ start: value.start, end: value.end });
    } catch (error) { setRefineError(error.message); }
    finally { setRefining(false); }
  }

  return <div className="vs-inspector">
    {selected.status === "completed" ? <>
      {sequence && <><FrameSequencePreview key={sequence.id} sequence={sequence} onCreate={createFrameAnimation} onStart={() => setPlaying(false)} timelinePlaying={playing} /><button type="button" className="vs-original-toggle" aria-expanded={showSource} onClick={() => setShowSource(!showSource)}>{showSource ? "收起原视频" : "查看原视频与首尾帧"}</button></>}
      {(!sequence || showSource) && <>
      <div className="vs-inspector-mode" role="group" aria-label="详情模式"><button type="button" className={compact ? "is-current" : ""} onClick={() => setCompact(true)}>简略</button><button type="button" className={!compact ? "is-current" : ""} onClick={() => setCompact(false)}>完整</button></div>
      {compact ? <VideoRangePreview selected={selected} timelinePlaying={playing} onStart={() => setPlaying(false)} onCreate={createFrameAnimation} /> : <><div className="vs-frame-pair"><div><small>首帧</small><img src={frameUrl(selected.source, first)} alt="首帧" /><span>{timeLabel(first)}</span></div><div><small>尾帧</small><img src={frameUrl(selected.source, last)} alt="尾帧" /><span>{timeLabel(last)}</span></div></div><button type="button" className="vs-primary" onClick={createFrameAnimation}>生成透明帧动画</button></>}
      {!compact && <div className="vs-frame-picker"><strong>逐帧选取</strong>{!playing && <img className="vs-current-frame" src={frameUrl(selected.source, current)} alt="当前选中帧" />}<input aria-label="选择视频帧" type="range" min={selected.in} max={Math.max(selected.in, selected.out - step)} step={step} value={current} onChange={event => seek(Number(event.target.value))} /><div className="vs-frame-controls"><button onClick={() => seek(Math.max(selected.in, roundFrame(frameTime - step, fps)))}>◀ 一帧</button><span>{timeLabel(frameTime)} · 第 {Math.round(frameTime * fps) + 1} 帧</span><button onClick={() => seek(Math.min(selected.out - step, roundFrame(frameTime + step, fps)))}>一帧 ▶</button></div><div className="vs-frame-actions"><button disabled={selected.locked} onClick={() => updateClip(selected.id, { startFrame: frameTime })}>设为首帧</button><button disabled={selected.locked} onClick={() => updateClip(selected.id, { endFrame: frameTime })}>设为尾帧</button></div></div>}
      </>}
      <div className="vs-inspector-fields"><VideoActionTemplates prompt={prompt} disabled={selected.locked || busy} onApply={template => {
        setPrompt(template.prompt); setSuggestion("");
        setGenerationSettings({ ...generationSettings, enabled: true });
        setSeconds(videoModel?.durations.includes(template.seconds) ? template.seconds : videoModel?.durations[0] || template.seconds);
      }} /><label>动作描述<textarea rows={compact ? 3 : 4} maxLength={2000} value={prompt} disabled={selected.locked} onFocus={onBegin} onBlur={onEnd} onChange={event => { setPrompt(event.target.value); setSuggestion(""); }} placeholder="描述两帧之间的运动…" /></label>
        <div className="vs-refine"><div className="vs-refine-heading"><strong>AI 提示词优化</strong><small>结合首尾帧识别画面元素</small></div><label>模型<select aria-label="提示词优化服务" value={provider} onChange={event => { setProvider(event.target.value); setSuggestion(""); setRecognition(null); setRefineError(""); }} disabled={refining}>{VIDEO_PROMPT_PROVIDERS.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{provider !== "gpt" && <label>{provider === "cursor" ? "Cursor 模型" : "本地视觉模型"}<select aria-label={provider === "cursor" ? "Cursor 提示词模型" : "本地提示词模型"} value={model} onChange={event => { setModel(event.target.value); setSuggestion(""); setRefineError(""); }} disabled={modelsLoading || !models.length || refining}>{!models.length && <option value="">{modelsLoading ? "读取模型…" : "模型不可用"}</option>}{models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}<div className="vs-refine-actions">{operations.map(item => <button key={item.id} type="button" disabled={!promptReady || modelsLoading || refining} onClick={() => refine(item.id)}>{refining ? "处理中…" : item.name}</button>)}</div>{modelError && <p className="vs-refine-error" role="status">{modelError}</p>}{refineError && <p className="vs-refine-error" role="alert">{refineError}</p>}{suggestion && <div className="vs-refine-result"><strong>画面识别</strong><small>首帧：{recognition?.start}</small><small>尾帧：{recognition?.end}</small><strong>润色建议</strong><p>{suggestion}</p><div><button type="button" onClick={() => setSuggestion("")}>放弃</button><button type="button" className="vs-primary" disabled={selected.locked} onClick={() => { setPrompt(suggestion); setSuggestion(""); }}>采用建议</button></div></div>}</div>
        <VideoAnimationSettings value={generationSettings} onChange={setGenerationSettings} disabled={busy} /><label>新片段时长<select value={seconds} onChange={event => setSeconds(Number(event.target.value))}>{(videoModel?.durations || [2, 3, 5]).map(value => <option key={value} value={value}>{value} 秒</option>)}</select></label>{videoModel && !videoModel.supportsEndFrame && <p className="vs-help">{videoModel.name} 不支持尾帧约束。请在“模型设置”中选择 MiniMax H3 后重生成。</p>}<button className="vs-primary" onClick={regenerate} disabled={busy || !ready || !prompt.trim()}>用首尾帧重生成</button></div>
    </> : <p className="vs-help">{selected.status === "running" ? "模型正在生成视频。完成后可逐帧选定首尾帧。" : "生成失败，可创建新片段重试。"}</p>}
  </div>;
}
