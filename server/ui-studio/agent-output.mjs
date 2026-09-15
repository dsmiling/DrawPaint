// Compact CLI transport only: server jobs, prompts, images and validation stay intact.
const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]]));
export const cliHelp='Usage: ui-studio.mjs list | claim <jobId> | request <jobId> | diagnose <jobId> | complete <jobId> <imagePath> | complete-plan <jobId> <manifestPath> | complete-layers <jobId> <manifestPath> | complete-repairs <jobId> <manifestPath> | complete-classification <jobId> <manifestPath> | metadata <jobId> <manifestPath> | fail <jobId> <reason> | vision. Append --full for the unabridged JSON response.';

export function compactAgentOutput(command,result) {
  if(['claim','request'].includes(command) && result?.generationPrompt) {
    // Preserve the authoritative prompt verbatim, all reference paths, all reuse
    // candidates and the full approved plan. Omit only stored execution/history data.
    const {candidateHistory,repairPreview,hybridDraft,quality,agentThread, ...request}=result;
    return {...request,executionGuidance:
      'Use this claim response as the authoritative brief; do not request it again unless the attempt or plan changes. Keep all fidelity, resolution and alpha requirements. Read each relevant reference once and reuse your inspection within this attempt. Prefer exact matching reusable assets; do not trade quality for fewer calls or pack extra layers into a sheet. Inspect final layers on light and dark backgrounds. Fix local processing, submission or canvas-delivery failures without regenerating artwork. A successful completion response needs one diagnose call, not another claim/request or repeated full job dumps. Use --help for CLI syntax; --full is available for omitted history/debug fields.'};
  }
  if(command.startsWith('complete') || ['metadata','fail'].includes(command)) {
    const preview=result.repairPreview;
    const slices=preview?.slices || result.slices || [];
    return {...pick(result,['id','operation','status','stage','attempt','revision','metadataRevision','error','continuationId','continuationError','reusedImages','reusedLayers']),
      ...(preview ? {candidateRevision:preview.revision}:{}),layerCount:slices.length,
      layers:slices.map(s=>pick(s,['id','regionId','name','layerType','file','x','y','w','h','imageWidth','imageHeight','warnings'])),
      warnings:[...new Set([...(result.quality?.warnings || []),...(preview?.quality?.warnings || [])])],
      detailCommand:`request ${result.id} --full`};
  }
  return result;
}
