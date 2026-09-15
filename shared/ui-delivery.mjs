// Candidate files are already cut and keyed. Displaying them does not approve publication.
export function canvasResult(job) {
  const preview=job.operation === "decompose" && job.repairPreview;
  return preview?.revision && preview.slices?.length
    ? {...job,...preview,canvasCandidate:true,presetName:`待检查 · ${job.parent?.name || job.prompt}`}
    : job;
}

// Count actual image shapes and their assets, never the import-history marker or group alone.
export function canvasDelivery(job, records = []) {
  job=canvasResult(job);
  const assets = new Map(records.filter(r=>r.typeName === "asset" && r.props?.src).map(r=>[r.id,r.props.src]));
  const images = records.filter(r=>r.typeName === "shape" && r.type === "image" &&
    r.meta?.uiJobId === job.id && r.meta?.uiRevision === job.revision && assets.has(r.props?.assetId));
  const present = new Set(images.filter(r=>{
    const slice=job.slices?.find(s=>s.id===r.meta.uiSliceId);
    if(!slice?.file) return false;
    const expected=`/api/ui-studio/jobs/${job.id}/assets/${slice.file.split("/").map(encodeURIComponent).join("/")}`;
    try {return new URL(assets.get(r.props.assetId),"http://127.0.0.1").pathname===expected;} catch{return false;}
  }).map(r=>r.meta.uiSliceId));
  const missing = (job.slices || []).filter(s=>!present.has(s.id)).map(s=>({id:s.id,name:s.name}));
  return { ...(job.canvasCandidate ? {candidate:true} : {}), expected:job.slices?.length || 0, present:(job.slices?.length || 0)-missing.length,
    missing, complete:Boolean(job.slices?.length) && missing.length === 0 };
}

// An empty import group is a failed delivery, not evidence that its images exist.
// Fully deleted results stay deleted; only repair a surviving empty group.
export function orphanedCanvasDelivery(job, records = []) {
  job=canvasResult(job);
  const groups=records.filter(r=>r.typeName==='shape' && r.type==='group' &&
    r.meta?.uiJobId===job.id && r.meta?.uiRevision===job.revision);
  return groups.length>0 && groups.every(g=>!records.some(r=>r.typeName==='shape' && r.parentId===g.id)) &&
    !records.some(r=>r.typeName==='shape' && r.type==='image' && r.meta?.uiJobId===job.id && r.meta?.uiRevision===job.revision);
}
