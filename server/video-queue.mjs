// ComfyUI executes its priority queue serially. Read the actual pending order
// instead of presenting every submitted prompt as currently generating.
export function indexVideoQueue(queue) {
  if (!Array.isArray(queue?.queue_running) || !Array.isArray(queue?.queue_pending)) throw new Error("生成队列返回格式无效");
  const running = new Set(queue.queue_running.map(entry => entry[1]));
  const ordered = [...queue.queue_pending].sort((a, b) => Number(a[0]) - Number(b[0]));
  return { running, pending: new Map(ordered.map((entry, index) => [entry[1], index + 1])) };
}

export function createVideoQueueReader({ jobIds, jobOptions, generatedStore, comfyJson }) {
  async function engineQueue() {
    try { return { ...indexVideoQueue(await comfyJson("/queue")), connected: true, error: null }; }
    catch { return { running: new Set(), pending: new Map(), connected: false, error: "暂时无法读取生成队列，连接恢复后自动更新。" }; }
  }

  async function readJob(id, queue) {
    const base = { ...jobOptions[id], id, url: null, queuePosition: null };
    if (queue.running.has(id)) return { ...base, status: "running", queueState: "running", error: null };
    if (queue.pending.has(id)) return { ...base, status: "running", queueState: "queued", queuePosition: queue.pending.get(id), error: null };
    try {
      const { file, history, processing, processingError, processedFrames } = await generatedStore.resolve(id, { wait: false });
      if (processingError) return { ...base, status: "failed", queueState: "failed", error: `固定底色失败：${processingError}` };
      if (processing) return { ...base, status: "running", queueState: "processing", processedFrames, error: null };
      if (file) return { ...base, status: "completed", queueState: "completed", error: null, url: `/api/video/jobs/${id}/file` };
      const executionError = (history?.status?.messages || []).find(item => item[0] === "execution_error")?.[1];
      if (history?.status?.status_str === "error" || history?.status?.completed === true) {
        return { ...base, status: "failed", queueState: "failed", error: executionError?.exception_message || "任务已结束，但没有生成可播放的视频。" };
      }
      // Keep the job pending when its state cannot be confirmed. A temporary
      // disconnect must not mark clips failed or stop their completion polling.
      return { ...base, status: "running", queueState: "unknown", error: queue.error || "正在确认任务状态。" };
    } catch {
      return { ...base, status: "running", queueState: "unknown", error: "暂时无法读取任务状态，连接恢复后自动更新。" };
    }
  }

  async function read(limit = 30, includeActive = false) {
    const queue = await engineQueue();
    const ids = [...jobIds].slice(-limit).reverse();
    if (includeActive) for (const id of [...queue.running, ...queue.pending.keys()]) if (jobIds.has(id) && !ids.includes(id)) ids.push(id);
    const jobs = await Promise.all(ids.map(id => readJob(id, queue)));
    return { jobs, connected: queue.connected, error: queue.error };
  }

  return { read, get: async id => readJob(id, await engineQueue()) };
}
