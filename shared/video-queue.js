export function videoQueueLabel(job) {
  if (job?.queueState === "queued") return `等待中 · 第 ${job.queuePosition} 位`;
  return { running: "生成中", processing: "固定底色中", completed: "已完成", failed: "失败", unknown: "确认状态中" }[job?.queueState || job?.status] || "确认状态中";
}

export function sortVideoQueue(jobs) {
  const order = { running: 0, processing: 0, queued: 1, unknown: 2, failed: 3, completed: 4 };
  return [...jobs].sort((a, b) => {
    const aState = a.queueState || a.status, bState = b.queueState || b.status;
    return (order[aState] ?? 2) - (order[bState] ?? 2)
      || (aState === "queued" ? a.queuePosition - b.queuePosition : 0)
      || String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  });
}

export async function enqueueVideoDrafts(clips, submit) {
  let added = 0;
  const failures = [];
  for (const clip of clips) {
    try { await submit(clip); added++; }
    catch (error) { failures.push({ id: clip.id, name: clip.name, error: error.message }); }
  }
  return { added, failures };
}
