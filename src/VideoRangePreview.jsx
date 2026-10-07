import { useEffect, useRef, useState } from "react";
import { videoFrameRange } from "../shared/video-frame-range.js";
import { clipRate } from "../shared/video-editing.js";

const timeLabel = time => `${Math.floor(time / 60).toString().padStart(2, "0")}:${Math.floor(time % 60).toString().padStart(2, "0")}.${Math.floor((time % 1) * 100).toString().padStart(2, "0")}`;
const sourceUrl = source => source.type === "job" ? `/api/video/jobs/${source.id}/file` : `/api/video/assets/${source.id}.${source.ext || "mp4"}`;

export default function VideoRangePreview({ selected, timelinePlaying, onStart, onCreate }) {
  const videoRef = useRef(null);
  const [playing, setPlaying] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState("");
  const { start, last, end, step, valid } = videoFrameRange(selected);
  const src = sourceUrl(selected.source);

  useEffect(() => {
    const video = videoRef.current;
    setPlaying(false); setError("");
    video?.pause();
    if (video?.readyState >= 1) video.currentTime = Math.min(start, Math.max(0, video.duration - step));
  }, [src, start, end, step]);
  useEffect(() => { if (videoRef.current) { videoRef.current.playbackRate = clipRate(selected); videoRef.current.volume = selected.volume ?? 1; } }, [selected.playbackRate, selected.volume]);

  useEffect(() => {
    if (!timelinePlaying) return;
    videoRef.current?.pause(); setPlaying(false);
  }, [timelinePlaying]);

  useEffect(() => {
    const video = videoRef.current;
    if (!playing || !video || !valid) return;
    let frame;
    const tick = () => {
      const stop = Math.min(end, video.duration);
      if (!video.seeking && (video.currentTime >= stop - Math.min(0.005, step / 4) || video.currentTime < start)) video.currentTime = start;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); video.pause(); };
  }, [playing, start, end, step, valid]);

  async function toggle() {
    const video = videoRef.current;
    if (!video || !valid || !loaded) return;
    if (playing) { video.pause(); setPlaying(false); return; }
    if (video.duration <= start) { setError("所选首帧超出视频范围，请在完整模式调整。"); return; }
    setError(""); onStart();
    if (video.currentTime < start || video.currentTime >= Math.min(end, video.duration)) video.currentTime = start;
    setPlaying(true);
    try { await video.play(); }
    catch (cause) { if (cause.name !== "AbortError") { setPlaying(false); setError("动画播放失败，请重新点击播放。"); } }
  }

  return <div className="vs-range-preview">
    <div className="vs-range-heading"><strong>当前动画</strong><small>{timeLabel(start)} → {timeLabel(last)} · {(Math.max(0, end - start) / clipRate(selected)).toFixed(2)} 秒</small></div>
    <button type="button" className={`vs-range-player ${playing ? "is-playing" : ""}`} aria-label={playing ? "暂停当前首尾帧动画" : "循环播放当前首尾帧动画"} aria-pressed={playing} disabled={!valid || !loaded} onClick={toggle}>
      <video ref={videoRef} src={src} muted={Boolean(selected.muted)} playsInline preload="auto" data-range-start={start} data-range-end={end}
        onLoadedMetadata={event => { event.currentTarget.currentTime = Math.min(start, Math.max(0, event.currentTarget.duration - step)); event.currentTarget.playbackRate = clipRate(selected); event.currentTarget.volume = selected.volume ?? 1; setLoaded(true); }}
        onEnded={event => { if (playing) { event.currentTarget.currentTime = start; event.currentTarget.play().catch(() => { setPlaying(false); setError("动画播放失败，请重新点击播放。"); }); } }}
        onError={() => { setLoaded(false); setPlaying(false); setError("无法读取当前动画，请检查视频素材。"); }} />
      <span className="vs-range-play-icon" aria-hidden="true">{playing ? "Ⅱ" : "▶"}</span>
      <span className="vs-range-play-hint">{!valid ? "请在完整模式调整首尾帧" : error || (!loaded ? "加载预览…" : playing ? "循环播放中 · 点击暂停" : "点击循环播放")}</span>
    </button>
    <button type="button" className="vs-primary" disabled={!valid} onClick={() => { videoRef.current?.pause(); setPlaying(false); onCreate(); }}>生成透明帧动画</button>
    {!valid && <p className="vs-refine-error" role="status">首帧不能晚于尾帧，请在完整模式调整。</p>}
  </div>;
}
