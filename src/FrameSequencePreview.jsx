import { useEffect, useRef, useState } from "react";

export function FrameSequenceCanvas({ sequence, playing = false, frame, loop = false, onFrame, onEnd, playbackRate = 1, className = "" }) {
  const canvas = useRef(null), callbacks = useRef({ onFrame, onEnd }), current = useRef(0);
  const [images, setImages] = useState([]), [index, setIndex] = useState(0), [error, setError] = useState("");
  const { manifest, baseUrl } = sequence;
  const visible = Math.max(0, Math.min(manifest.frameCount - 1, frame ?? index));
  current.current = visible; callbacks.current = { onFrame, onEnd };
  useEffect(() => {
    let cancelled = false;
    setImages([]); setIndex(0); setError("");
    Promise.all(manifest.sheets.map(sheet => new Promise((resolve, reject) => {
      const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error("无法读取动画图集")); image.src = baseUrl + sheet.file;
    }))).then(loaded => { if (!cancelled) setImages(loaded); }).catch(cause => { if (!cancelled) setError(cause.message); });
    return () => { cancelled = true; };
  }, [sequence.id, baseUrl]);
  useEffect(() => {
    const context = canvas.current?.getContext("2d"), rect = manifest.frames[visible];
    if (!context || !rect || !images[rect.sheet]) return;
    context.clearRect(0, 0, manifest.width, manifest.height); context.imageSmoothingEnabled = false;
    context.drawImage(images[rect.sheet], rect.x, rect.y, rect.w, rect.h, 0, 0, manifest.width, manifest.height);
  }, [images, visible, manifest]);
  useEffect(() => {
    if (!playing || !images.length) return;
    let raf, previous = current.current;
    const origin = performance.now() - previous * 1000 / (manifest.fps * playbackRate);
    const tick = now => {
      const elapsed = Math.floor((now - origin) * manifest.fps * playbackRate / 1000);
      const next = loop ? elapsed % manifest.frameCount : Math.min(elapsed, manifest.frameCount - 1);
      if (next !== previous) { setIndex(next); callbacks.current.onFrame?.(next); previous = next; }
      if (!loop && elapsed >= manifest.frameCount) { callbacks.current.onEnd?.(); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, [playing, images, manifest.fps, manifest.frameCount, loop, playbackRate]);
  return <div className={`vs-frame-sequence ${className}`}><canvas ref={canvas} width={manifest.width} height={manifest.height} role="img" aria-label={`${sequence.name}，透明序列帧`} data-sequence-id={sequence.id} data-frame-index={visible} />{error && <span role="alert">{error}</span>}</div>;
}

export default function FrameSequencePreview({ sequence, onCreate, onStart, timelinePlaying }) {
  const [frame, setFrame] = useState(0), [playing, setPlaying] = useState(false);
  const { manifest } = sequence;
  useEffect(() => { setFrame(0); setPlaying(false); }, [sequence.id]);
  useEffect(() => { if (timelinePlaying) setPlaying(false); }, [timelinePlaying]);
  const seek = value => { setPlaying(false); setFrame(Math.max(0, Math.min(manifest.frameCount - 1, value))); };
  return <div className="vs-sequence-attached" aria-label="已生成的帧动画">
    <div className="vs-range-heading"><strong>透明帧动画</strong><small>{manifest.frameCount} 帧 · {manifest.fps} fps · {manifest.width} × {manifest.height}</small></div>
    <button type="button" className="vs-sequence-player" aria-label={playing ? "暂停帧动画" : "播放帧动画"} aria-pressed={playing} onClick={() => { if (!playing) { onStart?.(); if (frame === manifest.frameCount - 1) setFrame(0); } setPlaying(!playing); }}>
      <FrameSequenceCanvas sequence={sequence} frame={frame} playing={playing} loop={manifest.loop} onFrame={setFrame} onEnd={() => setPlaying(false)} />
      <span className="vs-sequence-play-hint">{playing ? "播放中 · 点击暂停" : "点击播放"}</span>
    </button>
    <input aria-label="选择动画帧" type="range" min="0" max={manifest.frameCount - 1} step="1" value={frame} onChange={event => seek(Number(event.target.value))} />
    <div className="vs-frame-controls"><button type="button" disabled={frame === 0} onClick={() => seek(frame - 1)}>◀ 一帧</button><span>第 {frame + 1} / {manifest.frameCount} 帧</span><button type="button" disabled={frame === manifest.frameCount - 1} onClick={() => seek(frame + 1)}>一帧 ▶</button></div>
    <div className="vs-sequence-attached-actions"><a href={sequence.url} download={sequence.filename}>下载 PNG 帧</a><a href={baseSheet(sequence)} download>查看图集</a><button type="button" onClick={onCreate}>重新导出</button></div>
  </div>;
}
function baseSheet(sequence) { return sequence.baseUrl + sequence.manifest.sheets[0].file; }
