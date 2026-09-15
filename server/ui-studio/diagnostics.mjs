import fs from "node:fs";
import path from "node:path";
import { canvasDelivery } from "../../shared/ui-delivery.mjs";

export function jobDiagnostics(service, id) {
  const start=service.get(id), chain=[];
  const visited=new Set();
  let job=start;
  while(job && !visited.has(job.id)) {
    visited.add(job.id);chain.push(job);
    if(job.operation !== "plan" || !job.continuationId) break;
    job=service.get(job.continuationId);
  }
  let registry=[],registryError=null,snapshot={},snapshotError=null;
  try { registry=JSON.parse(fs.readFileSync(path.join(service.root,"agent-threads.local.json"),"utf8")).jobs || []; }
  catch(e) { if(e.code!=="ENOENT") registryError="执行对话记录读取失败"; }
  try { snapshot=service.snapshot(); } catch(e) { snapshotError=e.message; }
  const records=Object.values(snapshot.document?.store || {});
  return { checkedAt:new Date().toISOString(), registryError,snapshotError,
    snapshotRevision:snapshot.revision || 0,snapshotUpdatedAt:snapshot.updatedAt || null,
    stages:chain.map(j=>{
      const record=registry.filter(r=>r.jobId===j.id).at(-1);
      const files=(j.slices || []).map(s=>({id:s.id,name:s.name,file:s.file,
        exists:Boolean(s.file && fs.existsSync(service.asset(j.id,s.file)))}));
      return {jobId:j.id,operation:j.operation || j.workflow || "atlas",status:j.status,
        stage:j.stage,revision:j.revision,error:j.error || j.continuationError || null,
        planId:j.planId || null,continuationId:j.continuationId || null,
        sourceFile:j.sourceFile,atlasFile:j.atlasFile,exportFile:j.exportFile,
        candidates:j.repairPreview ? {revision:j.repairPreview.revision,files:j.repairPreview.slices.map(s=>({id:s.id,name:s.name,file:s.file,exists:fs.existsSync(service.asset(j.id,s.file)),warnings:s.warnings || []}))} : null,
        files,canvas:canvasDelivery(j,records),
        thread:record ? {threadId:record.threadId,hostId:record.hostId,state:record.state,
          turnStatus:record.turnStatus,outcome:record.outcome,attention:record.attention,error:record.error} : null};
    }) };
}
