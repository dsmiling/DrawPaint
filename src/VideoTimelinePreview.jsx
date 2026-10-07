import { useEffect, useRef, useState } from "react";
import { clipRate, endOf, exportable, sourceTime } from "../shared/video-editing.js";
import { sourceUrl } from "./VideoLayers.jsx";
import { FrameSequenceCanvas } from "./FrameSequencePreview.jsx";

function PreviewLayer({ clip, time, playing }) {
  const ref = useRef(null), target = sourceTime(clip, time);
  function sync() {
    const video = ref.current;
    if (!video) return;
    video.playbackRate = clipRate(clip); video.volume = clip.volume ?? 1;
    if (video.readyState >= 1 && Math.abs(video.currentTime - target) > (playing ? .15 : .02)) video.currentTime = Math.max(clip.in, Math.min(clip.out, target));
    if (playing && video.paused) video.play().catch(() => {}); else if (!playing) video.pause();
  }
  useEffect(sync, [time, playing, clip]);
  useEffect(() => { const video = ref.current; return () => video?.pause(); }, []);
  return <video ref={ref} src={sourceUrl(clip.source)} playsInline muted={Boolean(clip.muted)} onLoadedMetadata={sync} />;
}

export default function VideoTimelinePreview({ clips, time, playing, size, sequences = new Map() }) {
  const container = useRef(null), [bounds, setBounds] = useState({ width: 1, height: 1 });
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setBounds({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(container.current); return () => observer.disconnect();
  }, []);
  const [width, height] = size.split("x").map(Number), scale = Math.min(bounds.width / width, bounds.height / height);
  const visible = clips.map((clip, index) => ({ clip, index })).filter(({ clip }) => exportable(clip) && time >= clip.position && time < endOf(clip)).sort((a, b) => b.clip.track - a.clip.track || a.index - b.index);
  return <div ref={container} className="vs-composition-container"><div className="vs-composition" style={{ width: width * scale, height: height * scale }} aria-label="时间线合成预览">
    {visible.map(({ clip }) => {
      const sequence = sequences.get(clip.id);
      const frame = sequence ? Math.floor((sourceTime(clip, time) - sequence.range.in) * sequence.manifest.fps / sequence.range.playbackRate) : -1;
      return sequence && frame >= 0 && frame < sequence.manifest.frameCount ? <FrameSequenceCanvas key={clip.id} sequence={sequence} frame={frame} className="vs-sequence-composition-layer" /> : <PreviewLayer key={clip.id} clip={clip} time={time} playing={playing} />;
    })}{!visible.length && <span>此时刻没有可见的视频片段</span>}
  </div></div>;
}
