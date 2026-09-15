import fs from "node:fs/promises";
import path from "node:path";
import { runVision, visionHealth } from "./vision-runtime.mjs";
import { prepareHybridDraft, finishHybrid } from "./hybrid.mjs";
import { expandSheets } from "./sheets.mjs";
import { retainSubmission, mergeCandidateInputs, validateCandidateAttempt } from "./candidates.mjs";

function launch(service, id, stage, operation) {
  if (service.running.has(id) || service.running.size >= 2) throw new Error("已有任务运行，请稍后重试");
  const token = { controller: new AbortController(), worker: null };
  service.running.set(id, token);
  service.save({ ...service.get(id), status: "processing", stage, error: null });
  token.promise = operation(token.controller.signal).catch(error => {
    if (!token.controller.signal.aborted) service.save({ ...service.get(id), status: "failed", error: error.message });
  }).finally(() => service.running.delete(id));
  return service.get(id);
}

export function preparePlanOcr(service, job, dispatch) {
  return launch(service, job.id, "ocr", async signal => {
    const directory = service.directory(job.id);
    const ocr = await runVision("ocr", { source: path.join(directory, job.sourceFile), output: path.join(directory, "ocr") }, signal);
    if (signal.aborted) return;
    service.save({ ...service.get(job.id), ocr, hybrid: true, status: "awaiting_agent", stage: "plan",
      references: [job.sourceFile, `ocr/${ocr.cleanedFile}`,...(job.sourceMasterFile?[job.sourceMasterFile]:[])] });
    if (dispatch) await service.dispatchAgent(job.id);
  });
}

export async function createHybrid(service, id, input) {
  const health = await visionHealth();
  if (!health.ready) throw new Error(health.reason || "本地视觉环境尚未就绪");
  if (!input.planId || !input.regions) throw new Error("请先分析并确认拆解方案");
  if (service.running.size >= 2) throw new Error("已有两个任务运行，请稍后重试");
  const child = await service.refine(id, { ...input, dispatch: false, autoDispatch: input.autoDispatch ?? input.dispatch !== false });
  service.save({ ...child, method: "hybrid", hybrid: true, maskPurpose:"reference", status: "processing", stage: "segment" });
  return launch(service, child.id, "segment", async signal => {
    const job = service.get(child.id), directory = service.directory(child.id);
    await fs.writeFile(path.join(directory, "vision-plan.json"), JSON.stringify({ regions: job.approvedRegions }));
    const segments = await runVision("segment", { source: path.join(directory, job.sourceFile), output: path.join(directory, "segments"), plan: path.join(directory, "vision-plan.json") }, signal);
    const hybridDraft = await prepareHybridDraft(directory, job, segments);
    if (!signal.aborted) await finishHybridSegmentation(service, job.id, hybridDraft);
  });
}

export async function finishHybridSegmentation(service, id, hybridDraft) {
  const job = service.get(id);
  if (job.status === "cancelled") return job;
  service.save({ ...job, hybridDraft, status: "review_masks", stage: "review_masks" });
  if (job.autoContinue) return approveHybridMasks(service, id, { version: hybridDraft.version, dispatch: job.autoDispatch });
  return service.get(id);
}

export async function editHybridMasks(service, id, input) {
  const job = service.get(id);
  if (job.method !== "hybrid" || !["review_masks", "review_repairs", "failed"].includes(job.status) || !job.hybridDraft || service.running.has(id)) throw new Error("任务当前不能校正掩膜");
  if (input.version !== job.hybridDraft.version) throw new Error("掩膜已更新，请重新打开校正窗口");
  if (service.running.size >= 2) throw new Error("已有两个任务运行，请稍后重试");
  // Lock before the first asynchronous file read; two browsers cannot publish over each other.
  const token = { controller: new AbortController() };
  service.running.set(id, token);
  try {
    let approvedRegions = job.approvedRegions;
    const maskPurpose = input.maskPurpose ?? job.maskPurpose ?? "cutout";
    if (!["reference","cutout"].includes(maskPurpose)) throw new Error("Mask 用途无效");
    if (maskPurpose === "cutout" && job.splitOptions?.resolutionMode === "hd") throw new Error("高清拆分使用边界参考，不能切换为原像素裁切；请新建原像素提取任务");
    if (input.layerNotes) {
      if(!Array.isArray(input.layerNotes)||input.layerNotes.length>approvedRegions.length||new Set(input.layerNotes.map(n=>n.regionId)).size!==input.layerNotes.length||input.layerNotes.some(n=>!approvedRegions.some(r=>r.id===n.regionId)||typeof n.notes!=="string"||n.notes.length>2000)) throw new Error("图层生成说明无效");
      approvedRegions=approvedRegions.map(r=>({...r,reconstructionNotes:input.layerNotes.find(n=>n.regionId===r.id)?.notes ?? r.reconstructionNotes ?? ""}));
    }
    if (input.repairModes) {
      if (!Array.isArray(input.repairModes) || input.repairModes.length > approvedRegions.length || input.repairModes.some(r => !approvedRegions.some(a => a.id === r.regionId) || !["none", "surface", "image"].includes(r.repairMode))) throw new Error("修补方式无效");
      approvedRegions = approvedRegions.map(r => ({ ...r, repairMode: input.repairModes.find(m => m.regionId === r.id)?.repairMode || r.repairMode }));
    }
    if (input.repairPaddings) {
      if (!Array.isArray(input.repairPaddings) || input.repairPaddings.length > approvedRegions.length || input.repairPaddings.some(r => !approvedRegions.some(a => a.id === r.regionId) || !Number.isInteger(r.padding) || r.padding < 0 || r.padding > 8)) throw new Error("修补扩边须为 0–8 像素");
      approvedRegions = approvedRegions.map(r => ({...r, repairPadding:input.repairPaddings.find(p=>p.regionId===r.id)?.padding ?? r.repairPadding ?? 0}));
    }
    const hybridDraft = await prepareHybridDraft(service.directory(id), { ...job, approvedRegions, maskPurpose }, null, job.hybridDraft, input.edits);
    if (token.controller.signal.aborted) return service.get(id);
    return service.save({ ...job, approvedRegions, maskPurpose, hybridDraft, repairPreview: null, status: "review_masks", stage: "review_masks", error: null });
  } finally { service.running.delete(id); }
}

export function approveHybridMasks(service, id, input) {
  const job = service.get(id);
  if (job.method !== "hybrid" || job.status !== "review_masks" || input.version !== job.hybridDraft?.version) throw new Error("请重新校正并确认当前版本的掩膜");
  for (const layer of job.maskPurpose === "reference" ? [] : job.hybridDraft.layers) {
    if (!layer.visiblePixels) throw new Error(`“${layer.name}”没有可见像素，请校正`);
    if (layer.repairPixels && layer.repairMode === "none") throw new Error(`“${layer.name}”有遮挡，请选择修补方式`);
  }
  const needsImage = job.maskPurpose === "reference" || job.hybridDraft.layers.some(l => l.repairPixels && l.repairMode === "image");
  if (needsImage) {
    service.save({ ...job, status: "awaiting_agent", stage: "repair", masksApproved: job.hybridDraft.version });
    return input.dispatch ? service.dispatchAgent(id) : service.get(id);
  }
  return launch(service, id, "repair", async signal => {
    const result = await finishHybrid(service, job, [], signal);
    if (!signal.aborted) service.save({ ...service.get(id), ...result, status: "ready", stage: "done", masksApproved: job.hybridDraft.version });
  });
}

export async function completeHybridRepairs(service, id, input) {
  const job = service.get(id);
  if (job.method !== "hybrid" || job.stage !== "repair" || !["awaiting_agent", "agent_generating", "agent_queued", "agent_unknown", "agent_dispatching"].includes(job.status) || job.masksApproved !== job.hybridDraft.version) throw new Error("该任务不等待修补结果");
  validateCandidateAttempt(job,input);
  launch(service, id, "repair", async signal => {
    retainSubmission(service,job,input);
    const repairs = mergeCandidateInputs(service,job,await expandSheets(service, job, input.repairs, input.sheets));
    const result = await finishHybrid(service, job, repairs, signal);
    if (!signal.aborted) {
      service.save({ ...service.get(id), repairPreview: result, status: "review_repairs", stage: "review_repairs",retryRegionIds:null,candidateReview:null });
      if (job.autoContinue && !job.reviewBeforePublish) approveHybridRepairs(service, id, { revision: result.revision });
    }
  });
  await service.running.get(id).promise;
  const result = service.get(id);
  if (result.status === "failed") throw new Error(result.error);
  return result;
}

export function approveHybridRepairs(service, id, input) {
  const job = service.get(id);
  if (job.status !== "review_repairs" || !job.repairPreview || input.revision !== job.repairPreview.revision || job.masksApproved !== job.hybridDraft?.version) throw new Error("修补预览已变化，请重新打开并确认");
  const parent = service.get(job.parent.jobId);
  if (parent.status !== "ready" || parent.revision !== job.parent.revision) throw new Error("来源版本已变化，请从当前组件重新拆解");
  return service.save({ ...job, ...job.repairPreview, repairPreview: null, status:"ready", stage:"done", error:null });
}
