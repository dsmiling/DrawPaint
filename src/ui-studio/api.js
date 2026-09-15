export async function uiApi(route, value) {
  let response;
  try { response = await fetch(`/api/ui-studio/${route}`, value === undefined ? { signal: AbortSignal.timeout(15000) } : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
    signal: AbortSignal.timeout(60000),
  }); } catch { throw new Error("本地服务暂时不可用或请求超时。画布仍保留，请检查服务后重试。"); }
  let result;
  try { result = await response.json(); } catch { throw new Error("本地服务未返回完整数据。未加载空画布，请稍后重试。"); }
  if (!response.ok) { const error = new Error(result.error || `HTTP ${response.status}`); error.status = response.status; throw error; }
  return result;
}
export const assetUrl = (job, file) => `/api/ui-studio/jobs/${job.id}/assets/${file.split("/").map(encodeURIComponent).join("/")}`;
export function dataUrl(file) {
  if (file.size > 32 * 1024 * 1024) return Promise.reject(new Error("图片不能超过 32 MB"));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file);
  });
}
export const stateLabel = { queued: "排队中", awaiting_agent: "待启动", agent_dispatching: "正在通知 Agent", agent_queued: "已提交给 Agent", agent_generating: "Agent 正在生图", agent_unknown: "等待 Agent 确认", generating: "正在生成图集", processing: "正在去背景 / 切图", ready: "素材已就绪", failed: "任务失败", cancelled: "已取消" };
stateLabel.review_masks = "待检查边界参考";
stateLabel.review_repairs = "待验收图层效果";
stateLabel.processing = "本地处理中";
stateLabel.agent_generating = "Agent 正在处理";

export function jobStateLabel(job) {
  if (job.operation === "plan") {
    if (job.status === "ready") return job.continuationError ? "拆分待重试" : job.continuationId ? "已进入图片拆分" : job.autoContinue ? "正在继续拆分" : "方案完成 · 尚未拆图";
    if (["agent_generating", "generating", "processing"].includes(job.status)) return "正在分析拆分方案";
  }
  return stateLabel[job.status] || job.status;
}
