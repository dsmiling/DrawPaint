import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic.mjs";

export function toolPayload(result) {
  if (result?.isError) throw new Error(result.content?.filter(c => c.type === "text").map(c => c.text).join("\n") || "Codex 操作失败");
  if (result?.structuredContent) return result.structuredContent;
  for (const item of result?.content || []) {
    if (item.type !== "text") continue;
    try { return JSON.parse(item.text); } catch { /* Skip non-JSON display text. */ }
  }
  throw new Error("Codex 返回了无法识别的结果");
}

const finishedJobs = new Set(["ready", "review_repairs", "failed", "cancelled"]);
const finishedTurns = new Set(["completed", "failed", "interrupted"]);

// Keep execution tasks available for inspection, including failed/cancelled jobs.
export class AgentThreads {
  constructor(root, { call, request, ownerThreadId, messageFor, now = () => new Date().toISOString() }) {
    this.file = path.join(root, "agent-threads.local.json");
    this.call = call; this.request = request; this.ownerThreadId = ownerThreadId;
    this.messageFor = messageFor; this.now = now; this.polling = false;
    this.cursor = new Map();
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (saved.schema !== "drawpaint.agent-threads.v1" || !Array.isArray(saved.jobs)) throw new Error("Invalid registry");
      this.jobs = new Map(saved.jobs.map(job => [job.recordKey || job.jobId, job]));
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error("独立对话记录损坏，已停止派发，避免重复生图或误归档");
      this.jobs = new Map();
    }
  }
  save() { writeJsonAtomic(this.file, { schema: "drawpaint.agent-threads.v1", jobs: [...this.jobs.values()] }); }
  async dispatch(job) {
    const recordKey=job.attempt ? `${job.id}/retry-${job.attempt}` : job.id;
    if (this.jobs.has(recordKey)) throw new Error("该任务已有独立对话记录，不能重复创建；请先确认原任务结果");
    const record = { jobId: job.id, recordKey, kind: job.kind || "ui", attempt:job.attempt || 0,state: "creating", createdAt: this.now() };
    this.jobs.set(recordKey, record);
    this.save(); // Persist BEFORE the non-idempotent create call, including across restarts.
    try {
      const result = toolPayload(await this.call("create_thread", {
        title: `DrawPaint · ${job.kind === "canvas" ? "画布生图" : job.operation === "plan" ? "拆解方案" : job.operation === "decompose" ? "AI 细分" : job.operation === "classify" ? "组件分类" : job.workflow === "mockup" ? "界面效果图" : "UI 生图"} · ${job.id.slice(0, 8)}${job.attempt ? ` · 重做 ${job.attempt}` : ""}`,
        target: { type: "projectless", directoryName: `drawpaint-${job.kind === "canvas" ? "canvas" : "ui"}-${job.id}${job.attempt ? `-retry-${job.attempt}` : ""}` },
        prompt: this.messageFor(job),
      }));
      if (typeof result.threadId !== "string" || !result.threadId || result.threadId === this.ownerThreadId) throw new Error("未取得新对话 ID，请检查 Codex，不能自动重建");
      Object.assign(record, { state: "active", threadId: result.threadId, hostId: result.hostId || "local" });
      this.save();
      return { accepted: true, threadId: record.threadId, hostId: record.hostId, dispatchMode: "new-thread", autoArchive: false };
    } catch (error) {
      record.state = record.threadId ? "active" : "unknown";
      record.error = String(error.message).slice(0, 1000);
      this.save();
      throw error;
    }
  }
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const records = [...this.jobs.values()].filter(r => r.state === "active" && r.threadId && r.threadId !== this.ownerThreadId);
      for (let offset = 0; offset < records.length; offset += 8) {
        const batch = records.slice(offset, offset + 8);
        const result = toolPayload(await this.call("wait_threads", {
          targets: batch.map(r => ({ threadId: r.threadId, hostId: r.hostId,
            ...(this.cursor.has(r.threadId) ? { afterCursor: this.cursor.get(r.threadId) } : {}) })), timeoutMs: 0,
        }));
        for (const record of batch) {
          const snapshot = result.polls?.find(p => p.thread?.id === record.threadId);
          if (!snapshot) continue; // Missing/failed reads and pending approvals are not completion.
          if (snapshot.cursor) this.cursor.set(record.threadId, snapshot.cursor);
          if (!finishedTurns.has(snapshot.latestTurn?.status) || snapshot.thread?.status?.type === "active") continue;
          try {
            const job = await this.request(`jobs/${record.jobId}`, record);
            Object.assign(record, { turnStatus: snapshot.latestTurn.status, outcome: job.status,
              error: job.error || null,
              attention: !finishedJobs.has(job.status) ? "执行对话已结束，素材任务尚未完成，请检查回填。" : null });
            if (finishedJobs.has(job.status)) Object.assign(record, { state: "retained", completedAt: this.now() });
          } catch (error) {
            record.error = String(error.message).slice(0, 1000); // Retry reads only, never generation or archival.
          }
          this.save();
        }
      }
    } finally { this.polling = false; }
  }
}
