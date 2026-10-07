import { useEffect, useRef, useState } from "react";
import { detectBackground } from "../shared/background-removal.mjs";
import { matteVideoFrame } from "../shared/video-matting.mjs";

export default function VideoBackgroundPreview({ source, time, maxSize, resampling = "smooth", options, onChange, disabled }) {
  const originalRef = useRef(null), resultRef = useRef(null);
  const [frame, setFrame] = useState(null), [error, setError] = useState("");
  const [detected, setDetected] = useState(""), [transparent, setTransparent] = useState(0), [empty, setEmpty] = useState(false);
  const [previewBackground, setPreviewBackground] = useState("checker");
  const src = source ? `/api/video/frame?type=${source.type}&id=${source.id}&time=${(Math.floor(time * 1000) / 1000).toFixed(3)}&maxSize=2048${options.removeBackground ? "&transparent=1" : ""}` : "";
  useEffect(() => {
    setFrame(null); setError("");
    if (!src) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      const width = image.naturalWidth, height = image.naturalHeight;
      const canvas = originalRef.current;
      if (!canvas) return;
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height);
      const rgb = detectBackground(pixels.data, width, height);
      setDetected(`#${rgb.map(c => c.toString(16).padStart(2, "0")).join("")}`);
      setFrame(pixels);
    };
    image.onerror = () => { if (!cancelled) setError("首帧预览读取失败，可重新打开窗口重试。"); };
    image.src = src;
    return () => { cancelled = true; };
  }, [src]);
  useEffect(() => {
    if (!frame || !resultRef.current) return;
    const { data } = matteVideoFrame(frame.data, frame.width, frame.height, options);
    const canvas = resultRef.current;
    const scale = Math.min(1, maxSize / Math.max(frame.width, frame.height));
    canvas.width = Math.max(1, Math.round(frame.width * scale)); canvas.height = Math.max(1, Math.round(frame.height * scale));
    const native = document.createElement("canvas");
    native.width = frame.width; native.height = frame.height;
    native.getContext("2d").putImageData(new ImageData(data, frame.width, frame.height), 0, 0);
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = resampling !== "nearest";
    canvas.style.imageRendering = resampling === "nearest" ? "pixelated" : "auto";
    context.drawImage(native, 0, 0, canvas.width, canvas.height);
    let visible = 0, clear = 0;
    for (let p = 3; p < data.length; p += 4) { if (data[p]) visible++; if (data[p] < 255) clear++; }
    setTransparent(clear / (frame.width * frame.height)); setEmpty(visible === 0);
  }, [frame, options, maxSize, resampling]);
  function pick(event) {
    if (!frame || disabled) return;
    const rect = originalRef.current.getBoundingClientRect();
    const x = Math.min(frame.width - 1, Math.max(0, Math.floor((event.clientX - rect.left) / rect.width * frame.width)));
    const y = Math.min(frame.height - 1, Math.max(0, Math.floor((event.clientY - rect.top) / rect.height * frame.height)));
    const offset = (y * frame.width + x) * 4;
    onChange({ ...options, background: `#${Array.from(frame.data.slice(offset, offset + 3)).map(c => c.toString(16).padStart(2, "0")).join("")}` });
  }
  const keyRgb = [1, 3, 5].map(i => parseInt((options.background === "auto" ? detected : options.background).slice(i, i + 2), 16));
  return <div className="vs-key-preview">
    <strong>首帧效果预览</strong>
    <div className="vs-key-comparison">
      <div><small>原帧 · 点击背景取色</small><button type="button" className="vs-key-original" aria-label="从原帧选取背景色" disabled={disabled || !frame} onClick={pick}><canvas ref={originalRef} role="img" aria-label="原始首帧" /></button></div>
      <div><small>{options.removeBackground ? "透明效果" : "保留原背景"}</small><div className="vs-key-checker" style={previewBackground === "checker" ? undefined : { background: previewBackground }}><canvas ref={resultRef} role="img" aria-label="首帧背景剔除预览" /></div></div>
    </div>
    <label className="vs-key-preview-background">检查底色<select aria-label="首帧检查底色" value={previewBackground} onChange={event => setPreviewBackground(event.target.value)}><option value="checker">透明棋盘</option><option value="#ffffff">白色</option><option value="#111827">深色</option></select></label>
    {!frame && <small role="status">{error || "正在读取首帧…"}</small>}
    {frame && <small role="status">{options.background === "auto" ? `检测背景色 ${detected} · ` : ""}透明区域 {(transparent * 100).toFixed(1)}%</small>}
    {frame && options.removeBackground && (empty || transparent === 0) && <p className="vs-sequence-error" role="status">{empty ? "画面已全部透明，请降低容差或重新取色。" : "尚未剔除背景，请重新取色或提高容差。"}</p>}
    <p className="vs-key-help">棋盘格用于检查真实透明通道。容差过大会移除角色的相近颜色，可用“从外部移除”保护内部细节。</p>
    {frame && options.removeBackground && Math.max(...keyRgb) - Math.min(...keyRgb) < 80 && <p className="vs-key-help">当前底色与深色描边可能接近。先降低容差保护细节，再尝试收缩 1 px；下次生图建议使用纯品红或纯绿底。</p>}
  </div>;
}
