import { useEffect, useRef } from "react";
import UiIcon, { IconButton } from "./UiIcon.jsx";
import { sortVideoQueue, videoQueueLabel } from "../shared/video-queue.js";

export default function VideoGenerationQueue({ queue, open, onOpen, clips, onSelect }) {
  const ref = useRef(null);
  const running = queue.jobs.filter(job => ["running", "processing"].includes(job.queueState)).length;
  const waiting = queue.jobs.filter(job => job.queueState === "queued").length;
  const jobs = sortVideoQueue(queue.jobs.filter(job => (job.queueState || job.status) !== "completed"));
  useEffect(() => {
    if (!open) return;
    const close = event => { if (!ref.current?.contains(event.target)) onOpen(false); };
    const escape = event => { if (event.key === "Escape") { event.stopPropagation(); onOpen(false); } };
    window.addEventListener("pointerdown", close); window.addEventListener("keydown", escape, true);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", escape, true); };
  }, [open, onOpen]);
  return <div className="vs-generation-queue" ref={ref}>
    <button type="button" className="vs-queue-trigger" aria-label="视频生成队列" aria-expanded={open} aria-controls="video-generation-queue" title={queue.connected ? `生成中 ${running} · 等待 ${waiting}` : "正在重新连接生成队列"} onClick={() => onOpen(!open)}><UiIcon name="queue" /><span>生成队列</span><b>{queue.connected ? running + waiting : "…"}</b></button>
    {open && <section className="vs-queue-panel" id="video-generation-queue" aria-label="视频生成队列详情">
      <div className="vs-queue-heading"><strong>生成队列</strong><span className="vs-queue-summary" aria-live="polite">{queue.connected ? `生成 ${running} · 等待 ${waiting}` : "连接中…"}</span><IconButton icon="close" label="关闭生成队列" onClick={() => onOpen(false)} /></div>
      {queue.error && <p className="vs-queue-error" role="status" title={queue.error}>队列连接中断</p>}
      {jobs.length ? <ol className="vs-queue-list">{jobs.map(job => {
        const clip = clips.find(item => item.source?.type === "job" && item.source.id === job.id);
        const Row = clip ? "button" : "div";
        return <li key={job.id} className={`vs-queue-item is-${job.queueState || job.status || "unknown"}`}><Row className="vs-queue-row" type={clip ? "button" : undefined} title={job.error || (clip ? "点击定位片段" : undefined)} onClick={clip ? () => { onSelect(clip); onOpen(false); } : undefined}><strong title={job.name}>{job.name || "生成视频"}</strong><span className="vs-queue-status">{job.queueState === "queued" ? `等待 · ${job.queuePosition}` : videoQueueLabel(job)}</span></Row></li>;
      })}</ol> : queue.connected && <p className="vs-queue-empty">暂无排队任务</p>}
    </section>}
  </div>;
}
