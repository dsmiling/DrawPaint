import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const candidateInstructions = "CANDIDATE REVIEW CONTRACT overrides automatic publication and visual rejection instructions above. Submit generated candidates even when resolution, proportions or small style details need improvement. Report visual concerns as warnings; do not call fail merely for visual differences. Preserve native pixels; never upscale to hide low resolution. The server stores candidates in review_repairs and only the USER may approve publication. Stop after candidate submission; never call approve-repairs. Fail only for execution, unreadable files or invalid protocol. For a targeted retry, return ONLY requested regionIds, exactly once. Other layers are retained byte-for-byte by the server; do not regenerate or return them.";

export function reviewCandidates(service,id,input) {
  const job=service.get(id), preview=job.repairPreview;
  if(!job.reviewBeforePublish || !preview || input.revision!==preview.revision || !["review_repairs","failed"].includes(job.status)) throw new Error("候选版本已变化，请重新打开验收");
  const ids=input.regionIds || [];
  if(!Array.isArray(ids)||new Set(ids).size!==ids.length||ids.some(id=>!preview.slices.some(s=>s.regionId===id))) throw new Error("重做图层选择无效");
  const notes=input.notes || {};
  if(!notes || typeof notes!=="object" || Array.isArray(notes) || Object.entries(notes).some(([id,n])=>!preview.slices.some(s=>s.regionId===id)||typeof n!=="string"||n.length>2000)) throw new Error("图层修改说明无效");
  return service.save({...job,candidateReview:{revision:preview.revision,regionIds:ids,notes}});
}

export async function retryCandidates(service,id,input) {
  let job=service.get(id);
  if(service.running.has(id)) throw new Error("任务仍在处理");
  if(!["review_repairs","failed"].includes(job.status) && job.retrySourceRevision===input.revision) return job;
  job=reviewCandidates(service,id,input);
  if(!job.candidateReview.regionIds.length) throw new Error("请至少选择一个需要重做的图层");
  const parent=service.get(job.parent.jobId);
  if(parent.status!=="ready" || parent.revision!==job.parent.revision) throw new Error("来源版本已变化，请重新拆分");
  const approvedRegions=job.approvedRegions || job.repairPreview.slices.map(s=>({...s,...s.plannedRect,id:s.regionId}));
  const next=service.save({...job,approvedRegions,retryRegionIds:job.candidateReview.regionIds,
    retrySourceRevision:job.repairPreview.revision,attempt:(job.attempt || 0)+1,
    candidateHistory:[...(job.candidateHistory || []),job.repairPreview],
    status:"awaiting_agent",stage:job.method === "hybrid" ? "repair" : "generate",error:null});
  return input.dispatch===false ? next : service.dispatchAgent(id);
}

export function mergeCandidateInputs(service,job,entries) {
  if(!Array.isArray(entries)) throw new Error("缺少图层清单");
  if(entries.some(e=>e._candidateKeep)) throw new Error("不能提交内部保留图层标记");
  if(!job.retryRegionIds) return entries;
  const ids=entries.map(e=>e.regionId);
  if(ids.length!==job.retryRegionIds.length || new Set(ids).size!==ids.length || ids.some(id=>!job.retryRegionIds.includes(id))) throw new Error("仅返回本次选中的重做图层，每层一次");
  return job.repairPreview.slices.map(s=>entries.find(e=>e.regionId===s.regionId) || {
    ...s,...s.plannedRect,reuse:undefined,background:undefined,_candidateKeep:true,dataUrl:`data:image/png;base64,${fs.readFileSync(service.asset(job.id,s.file)).toString("base64")}`,
  });
}

export function retainSubmission(service,job,input) {
  if(!job.reviewBeforePublish) return;
  const folder=path.join(service.directory(job.id),"candidate-submissions");
  fs.mkdirSync(folder,{recursive:true});
  // Preserve uploaded candidates even when a later technical validation fails.
  fs.writeFileSync(path.join(folder,`${randomUUID()}.json`),JSON.stringify(input));
}

export function validateCandidateAttempt(job,input) {
  if(job.reviewBeforePublish && (input.attempt ?? 0)!==(job.attempt || 0)) throw new Error("重做批次已变化，不能提交旧批次结果");
}

export function approveCandidates(service,id,input) {
  const job=service.get(id);
  if(job.status!=="review_repairs" || input.revision!==job.repairPreview?.revision || service.running.has(id)) throw new Error("候选版本已变化或仍在处理");
  const parent=service.get(job.parent.jobId);
  if(parent.status!=="ready" || parent.revision!==job.parent.revision) throw new Error("来源版本已变化，请重新拆分");
  return service.save({...job,...job.repairPreview,repairPreview:null,status:"ready",stage:"done",error:null,retryRegionIds:null});
}

export function restoreCandidates(service,id,input) {
  if(service.running.has(id)) throw new Error("任务仍在处理");
  const job=reviewCandidates(service,id,input);
  return service.save({...job,status:"review_repairs",stage:"review_repairs",retryRegionIds:null,error:null});
}
