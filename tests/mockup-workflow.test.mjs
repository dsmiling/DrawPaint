import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import http from "node:http";
import { once } from "node:events";
import { readPsd, initializeCanvas } from "ag-psd";
import { UiStudioService } from "../server/ui-studio/service.mjs";
import { buildAtlasPrompt } from "../server/ui-studio/provider.mjs";
import { buildPreset } from "../server/ui-studio/preset.mjs";
import { buildCanvasPreset } from "../server/ui-studio/canvas-preset.mjs";
import { validatePlan, buildPlanPrompt } from "../shared/ui-plan.mjs";
import { buildLayerPrompt } from "../server/ui-studio/layers.mjs";
import { jobDiagnostics } from "../server/ui-studio/diagnostics.mjs";
import { canvasDelivery, canvasResult, orphanedCanvasDelivery } from "../shared/ui-delivery.mjs";
import { execFileSync } from "node:child_process";
import { verifiedDelivery } from "../src/ui-studio/delivery-transaction.js";
import { compactAgentOutput } from "../server/ui-studio/agent-output.mjs";

test('compact agent transport preserves quality contracts and references while removing repeated history',()=>{
  const request={id:'job',status:'agent_generating',attempt:2,generationPrompt:'Full fidelity, exact text, 1024 native pixels, fractional alpha.',
    instructions:'Review before publication',referencePaths:['source.png','guide.png'],repairRequests:[{regionId:'one',notes:'preserve glow',maskPath:'mask.png'}],
    reusableComponents:[{jobId:'old',imagePath:'reusable.png'}],approvedRegions:[{id:'one',notes:'all details'}],splitOptions:{resolutionMode:'hd'},retryRegionIds:['one'],
    hybridDraft:{layers:Array(100).fill({mask:'repeated'})},candidateHistory:Array(50).fill({old:'history'}),repairPreview:{revision:'old'}};
  const compact=compactAgentOutput('claim',request);
  for(const key of ['generationPrompt','instructions','referencePaths','repairRequests','reusableComponents','approvedRegions','splitOptions','retryRegionIds','attempt']) assert.deepEqual(compact[key],request[key]);
  for(const key of ['hybridDraft','candidateHistory','repairPreview']) assert.equal(key in compact,false);
  assert.ok(request.candidateHistory.length===50,'source record is unchanged');
  const result={...request,status:'review_repairs',repairPreview:{revision:'new',slices:[{id:'slice-1',file:'new/a.png',imageWidth:1024,imageHeight:1024,warnings:['edge concern']}],quality:{warnings:['edge concern']}}};
  const summary=compactAgentOutput('complete-repairs',result);
  assert.equal(summary.status,'review_repairs');assert.equal(summary.candidateRevision,'new');assert.equal(summary.layerCount,1);
  assert.deepEqual(summary.layers[0].warnings,['edge concern']);assert.deepEqual(summary.warnings,['edge concern']);
  assert.equal(summary.continuationId,undefined);assert.equal('generationPrompt' in summary,false);
  assert.match(summary.detailCommand,/--full/);
});

test("delivery transaction rolls back silent omissions, missing assets and post-transaction removal", () => {
  const job={id:'job',status:'ready',revision:'r',slices:[{id:'slice-1',file:'r/a.png'},{id:'slice-2',file:'r/b.png'}]};
  const complete=job.slices.flatMap((slice,i)=>[
    {id:`asset:${i}`,typeName:'asset',props:{src:`/api/ui-studio/jobs/job/assets/${slice.file}`}},
    {id:`shape:${i}`,typeName:'shape',type:'image',props:{assetId:`asset:${i}`},meta:{uiJobId:'job',uiRevision:'r',uiSliceId:slice.id}},
  ]);
  const baseline=[{id:'shape:original',typeName:'shape',type:'image',props:{w:100,h:80}}];
  for(const mode of ['empty-group','partial','missing-asset','wrong-asset','post-transaction','success']) {
    let records=structuredClone(baseline),markedImported=false;
    const editor={store:{allRecords:()=>records},run:fn=>{fn();if(mode==='post-transaction')records=records.filter(r=>r.id!=='shape:1');}};
    const run=()=>{
      verifiedDelivery(editor,job,()=>{
        records.push({id:'shape:group',typeName:'shape',type:'group',meta:{uiJobId:'job',uiRevision:'r'}});
        if(mode!=='empty-group')records.push(...structuredClone(complete));
        if(mode==='partial')records=records.filter(r=>r.id!=='shape:1');
        if(mode==='missing-asset')records=records.filter(r=>r.id!=='asset:1');
        if(mode==='wrong-asset')records.find(r=>r.id==='asset:1').props.src='/wrong.png';
      },()=>structuredClone(records),snapshot=>{records=snapshot;});
      markedImported=true;
    };
    if(mode==='success') {run();assert.equal(markedImported,true);assert.equal(canvasDelivery(job,records).complete,true);}
    else {assert.throws(run,/回填不完整/);assert.deepEqual(records,baseline);assert.equal(markedImported,false);}
  }
});

test("candidate canvas delivery uses cut PNGs without approving or duplicating a revision", () => {
  const candidate={id:"candidate-job",operation:"decompose",status:"review_repairs",parent:{name:"入口"},repairPreview:{revision:"v1",slices:[{id:"slice-1",file:"v1/icon.png",w:10,h:12}]}};
  const display=canvasResult(candidate);
  assert.equal(display.status,"review_repairs"); assert.equal(display.canvasCandidate,true);
  assert.equal(candidate.revision,undefined); assert.equal(candidate.slices,undefined);
  assert.equal(display.presetName,"待检查 · 入口");
  const records=[{id:"asset:1",typeName:"asset",props:{src:"/api/ui-studio/jobs/candidate-job/assets/v1/icon.png"}},
    {id:"shape:1",typeName:"shape",type:"image",props:{assetId:"asset:1"},meta:{uiJobId:candidate.id,uiRevision:"v1",uiSliceId:"slice-1"}}];
  assert.equal(canvasDelivery(candidate,records).complete,true);
  assert.equal(canvasDelivery(candidate,records).candidate,true);
  assert.equal(canvasDelivery(candidate,records.slice(1)).complete,false);
  const approved={...candidate,...candidate.repairPreview,repairPreview:null,status:"ready"};
  assert.equal(canvasResult(approved).revision,display.revision);
  assert.equal(canvasResult(approved).canvasCandidate,undefined);
  assert.equal(canvasDelivery(approved,records).complete,true);
});

test("empty candidate groups are repaired despite import history, without restoring intentional deletions", () => {
  const job={id:'job',operation:'decompose',repairPreview:{revision:'r',slices:[{id:'slice-1',file:'r/a.png'}]}};
  const group={id:'shape:group',typeName:'shape',type:'group',meta:{uiJobId:'job',uiRevision:'r'}};
  assert.equal(orphanedCanvasDelivery(job,[group]),true);
  assert.equal(orphanedCanvasDelivery(job,[]),false);
  const image={id:'shape:image',parentId:group.id,typeName:'shape',type:'image',meta:{uiJobId:'job',uiRevision:'r'}};
  assert.equal(orphanedCanvasDelivery(job,[group,image]),false);
  assert.equal(orphanedCanvasDelivery(job,[{...group,meta:{...group.meta,uiRevision:'old'}}]),false);
});

test("candidate retries update textures in place and approval keeps shape IDs and placement", () => {
  execFileSync(process.execPath,["--input-type=module","-e",`
    import assert from 'node:assert/strict';
    import {insertJob} from './src/ui-studio/canvas.js';
    const image={id:'shape:icon',typeName:'shape',type:'image',parentId:'shape:group',x:123,y:456,rotation:.3,props:{assetId:'asset:old',w:30,h:40},meta:{uiJobId:'job',uiRevision:'v1',uiSliceId:'slice-1',uiCandidate:true}};
    const group={id:'shape:group',typeName:'shape',type:'group',x:5,y:8,parentId:'page:one',props:{},meta:{uiJobId:'job',uiRevision:'v1',uiCandidate:true,uiName:'待检查 · 入口'}};
    const records=[image,group],assets=[];
    const editor={store:{allRecords:()=>[...records,...assets]},complete:()=>{},setCurrentTool:()=>{},markHistoryStoppingPoint:()=>structuredClone({records,assets}),bailToMark:()=>{throw Error('unexpected rollback')},run:fn=>fn(),createAssets:rows=>assets.push(...rows),updateShapes:rows=>rows.forEach(u=>{const s=records.find(r=>r.id===u.id);Object.assign(s,{...u,props:{...s.props,...u.props},meta:{...s.meta,...u.meta}});})};
    const job={id:'job',operation:'decompose',status:'review_repairs',parent:{name:'入口'},repairPreview:{revision:'v2',slices:[{id:'slice-1',name:'图标',file:'v2/icon.png',w:10,h:12,imageWidth:800,imageHeight:960}]}};
    insertJob(editor,job);
    assert.equal(records.length,2);assert.equal(assets.length,1);
    assert.equal(image.x,123);assert.equal(image.y,456);assert.equal(image.rotation,.3);assert.equal(image.parentId,'shape:group');assert.equal(image.props.w,30);assert.equal(image.props.h,40);
    assert.equal(image.meta.uiRevision,'v2');assert.equal(assets[0].props.w,800);
    insertJob(editor,job);assert.equal(assets.length,1);
    insertJob(editor,{...job,...job.repairPreview,repairPreview:null,status:'ready'});
    assert.equal(image.meta.uiCandidate,false);assert.equal(group.meta.uiCandidate,false);assert.equal(group.meta.uiName,'入口');assert.equal(assets.length,1);
    process.exit(0);
  `],{cwd:process.cwd(),timeout:20000,stdio:"pipe"});
});
import { createUiStudioHandler } from "../server/ui-studio/http.mjs";
import { loadSplitOptions, normalizeSplitOptions, splitStorageKey, splitInstructions } from "../shared/split-options.mjs";

fs.mkdirSync("tmp", { recursive: true });
const dataUrl = image => `data:image/png;base64,${image.toString("base64")}`;
async function setup() {
  const service = new UiStudioService(fs.mkdtempSync(path.resolve("tmp/mockup-test-")));
  const bg = await sharp({ create: { width: 100, height: 60, channels: 4, background: "#102030" } }).png().toBuffer();
  const icon = await sharp({ create: { width: 20, height: 10, channels: 4, background: "#ffcc00" } }).extend({ top: 1, bottom: 1, left: 1, right: 1, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const source = await sharp(bg).composite([{ input: icon, left: 39, top: 24 }]).png().toBuffer();
  const pending = await service.create({ kind: "extract", workflow: "mockup", dataUrl: dataUrl(source), options: { removeBackground: true, autoSplit: true } });
  await service.running.get(pending.id).promise;
  const parent = service.get(pending.id);
  assert.equal(parent.status, "ready");
  const regions = [
    { id: "background", name: "洞窟底图", layerType: "background", x: 0, y: 0, w: 100, h: 60, zIndex: 0, notes: "移除全部前景后补全" },
    { id: "marker", name: "选中标记", layerType: "icon", x: 40, y: 25, w: 20, h: 10, zIndex: 1 },
  ];
  const outputs = [{ ...regions[0], regionId: "background", allowOpaque: true, dataUrl: dataUrl(bg) }, { ...regions[1], regionId: "marker", dataUrl: dataUrl(icon) }];
  return { service, parent, source, regions, outputs };
}

test("delivery diagnostics separate plan success, generation failure, disk files and persisted canvas layers",async()=>{
  const {service,parent,regions,outputs}=await setup();
  const plan=await service.plan(parent.id,{revision:parent.revision,dispatch:false});
  service.completePlan(plan.id,{regions});
  const child=await service.refine(parent.id,{revision:parent.revision,planId:plan.id,dispatch:false});
  service.save({...service.get(plan.id),continuationId:child.id});
  service.save({...child,status:'failed',error:'生成图片不符合要求'});
  let report=jobDiagnostics(service,plan.id);
  assert.equal(report.stages[0].status,'ready');assert.equal(report.stages[1].status,'failed');
  assert.equal(report.stages[1].error,'生成图片不符合要求');assert.equal(report.stages[1].canvas.complete,false);
  service.save({...child,status:'awaiting_agent'});
  const done=await service.completeLayers(child.id,{layers:outputs});
  const s=done.slices[0];
  const asset={id:'asset:a',typeName:'asset',props:{src:`/api/ui-studio/jobs/${done.id}/assets/${s.file}`}};
  const shape={id:'shape:a',typeName:'shape',type:'image',props:{assetId:asset.id},meta:{uiJobId:done.id,uiRevision:done.revision,uiSliceId:s.id}};
  service.snapshot({document:{store:{[asset.id]:asset,[shape.id]:shape}},importedRevisions:[`${done.id}/${done.revision}`]});
  report=jobDiagnostics(service,done.id);
  assert.equal(report.stages[0].files.filter(f=>f.exists).length,2);
  assert.deepEqual([report.stages[0].canvas.present,report.stages[0].canvas.expected,report.stages[0].canvas.complete],[1,2,false]);
  assert.equal(canvasDelivery(done,[asset,{...shape,type:'group'}]).present,0);
  assert.equal(canvasDelivery(done,[{...asset,props:{src:'/wrong.png'}},shape]).present,0);
  assert.equal(canvasDelivery(done,[asset,shape,{...shape,id:'shape:copy'}]).present,1);
  fs.unlinkSync(service.asset(done.id,done.slices[1].file));
  assert.equal(jobDiagnostics(service,done.id).stages[0].files.filter(f=>!f.exists).length,1);
});

test("split preferences retain false values, granularity and custom notes across reopening", () => {
  const saved={useMask:false,keepText:false,granularity:"components",notes:"保持金色细边"};
  const store=new Map([[splitStorageKey,JSON.stringify(saved)]]);
  assert.deepEqual(loadSplitOptions({getItem:key=>store.get(key)}),{...saved,preserveAppearance:true,resolutionMode:"hd",generationMode:"individual"});
  assert.equal(normalizeSplitOptions({...saved,preserveAppearance:false}).preserveAppearance,false);
  assert.match(splitInstructions(saved),/Remove all readable text/);
  assert.match(splitInstructions(saved),/Split into complete components/);
  assert.match(splitInstructions(saved),/保持金色细边/);
  assert.equal(loadSplitOptions({getItem:()=>'{broken'}).keepText,true);
  assert.equal(normalizeSplitOptions({useMask:"false"}).useMask,true);
});

test("one-click split automatically continues a plan once and reuses its receipt after reload", async () => {
  const {service,parent,regions,outputs}=await setup();
  const plan=await service.plan(parent.id,{revision:parent.revision,dispatch:false,autoContinue:true,
    splitOptions:{useMask:false,resolutionMode:"hd",generationMode:"sheet",keepText:false}});
  assert.equal(plan.autoContinue,true); assert.equal(plan.autoDispatch,false);
  service.completePlan(plan.id,{regions});
  await new Promise(resolve=>queueMicrotask(resolve));
  const [child,duplicate]=await Promise.all([service.continueSplit(plan.id),service.continueSplit(plan.id)]);
  assert.equal(child.id,duplicate.id); assert.equal(child.autoContinue,true);
  assert.equal(child.splitOptions.generationMode,"sheet"); assert.equal(child.splitOptions.keepText,false);
  assert.equal(service.get(plan.id).continuationId,child.id);
  assert.equal(service.list().filter(j=>j.planId===plan.id).length,1);
  const reloaded=new UiStudioService(path.dirname(service.root));
  assert.equal((await reloaded.continueSplit(plan.id)).id,child.id);
  const result=await reloaded.completeLayers(child.id,{layers:await hdOutputs(outputs)});
  assert.equal(result.status,"ready"); assert.equal(result.slices.length,2);
});

test("old browser preferences migrate once to individual HD without losing text or granularity choices",()=>{
  const old={resolutionMode:"source",generationMode:"sheet",useMask:false,keepText:false,granularity:"components",notes:"保留圆框"};
  const store=new Map([["drawpaint.ui-studio.split-options.v1",JSON.stringify(old)]]);
  const migrated=loadSplitOptions({getItem:key=>store.get(key)});
  assert.deepEqual(migrated,{...old,resolutionMode:"hd",generationMode:"individual",preserveAppearance:true});
  const explicit={...migrated,resolutionMode:"source",generationMode:"sheet"};
  store.set(splitStorageKey,JSON.stringify(explicit));
  assert.deepEqual(loadSplitOptions({getItem:key=>store.get(key)}),explicit);
});

test("planning and direct generation keep connected frame ornaments together while allowing deblurring",()=>{
  const splitOptions=normalizeSplitOptions({});
  for(const hybrid of [false,true]) {
    const prompt=buildPlanPrompt({width:200,height:200,hybrid,splitOptions});
    assert.match(prompt,/ONE region covering the full frame/);
    assert.match(prompt,/Do not cut at connections/);
    assert.match(prompt,/do not silently merge regionId/);
  }
  for(const generationMode of ["individual","sheet"]) {
    const prompt=buildLayerPrompt({width:200,height:200,splitOptions:{...splitOptions,generationMode}});
    assert.match(prompt,/Do not cut at connections/);
    assert.match(prompt,/small local detail differences are allowed/);
  }
});

test("HD refuses tiny new sprites, low-resolution reuse and source-pixel bypass without publishing",async()=>{
  const {service,parent,outputs}=await setup();
  const legacy=await service.refine(parent.id,{revision:parent.revision,dispatch:false});
  const old=await service.completeLayers(legacy.id,{layers:outputs});
  for(const kind of ["new","reuse","sourcePixels"]) {
    const child=await service.refine(parent.id,{revision:parent.revision,dispatch:false,splitOptions:{resolutionMode:"hd"}});
    assert.ok(!service.reusableComponents(child).some(c=>c.jobId===old.id));
    let layers=outputs;
    if(kind==="reuse") layers=old.slices.map(s=>({...s,reuse:{jobId:old.id,revision:old.revision,sliceId:s.id}}));
    if(kind==="sourcePixels") layers=outputs.map(s=>({...s,sourcePixels:{alphaDataUrl:s.dataUrl}}));
    await assert.rejects(service.completeLayers(child.id,{layers}),/分辨率不足|不能回填原像素/);
    assert.equal(service.get(child.id).status,"failed");
    assert.equal(service.get(child.id).revision,undefined);
    assert.equal(service.get(old.id).revision,old.revision);
  }
});

test("connected one-click planning carries dispatch authorization to the image task", async () => {
  const {service,parent,regions}=await setup();
  const dispatched=[];
  service.agentConnection={status:async()=>({connected:true}),dispatch:async id=>{dispatched.push(id);}};
  const plan=await service.plan(parent.id,{revision:parent.revision,dispatch:true,autoContinue:true});
  assert.equal(plan.autoDispatch,true);
  service.completePlan(plan.id,{regions});
  const child=await service.continueSplit(plan.id);
  assert.equal(child.status,"agent_queued"); assert.equal(child.autoDispatch,true);
  assert.deepEqual(dispatched,[plan.id,child.id]);
  assert.equal((await service.continueSplit(plan.id)).id,child.id);
  assert.equal(dispatched.length,2);
});

test("split configuration survives plan approval, service reload and direct generation", async () => {
  const {service,parent,regions}=await setup();
  const splitOptions={useMask:true,keepText:false,granularity:"components",notes:"保持金色细边"};
  const plan=await service.plan(parent.id,{revision:parent.revision,dispatch:false,splitOptions,prompt:"按配置拆分"});
  assert.match(service.claimAgent(plan.id).generationPrompt,/Remove all readable text/);
  service.completePlan(plan.id,{regions});
  const child=await service.refine(parent.id,{revision:parent.revision,planId:plan.id,dispatch:false});
  assert.deepEqual(child.splitOptions,{...splitOptions,preserveAppearance:true,resolutionMode:"hd",generationMode:"individual"});assert.equal(child.prompt,"按配置拆分");
  const reload=new UiStudioService(path.dirname(service.root));
  assert.deepEqual(reload.get(child.id).splitOptions,{...splitOptions,preserveAppearance:true,resolutionMode:"hd",generationMode:"individual"});
  assert.match(reload.claimAgent(child.id).generationPrompt,/Split into complete components/);
  service.cancel(child.id);
  const direct=await service.refine(parent.id,{revision:parent.revision,dispatch:false,splitOptions:{...splitOptions,useMask:false}});
  assert.match(service.claimAgent(direct.id).generationPrompt,/Remove all readable text/);
});

test("mockup import preserves every pixel; generation prompt requests an assembled screen", async () => {
  const { service, parent, source } = await setup();
  assert.equal(parent.slices.length, 1);
  assert.equal(parent.options.removeBackground, false);
  assert.equal(parent.options.autoSplit, false);
  assert.deepEqual(await sharp(service.asset(parent.id, parent.atlasFile)).raw().toBuffer(), await sharp(source).raw().toBuffer());
  assert.match(buildAtlasPrompt(parent), /fully assembled screen/);
  assert.throws(() => service.reprocess(parent.id, {}), /保留完整构图/);
  const generated = await service.create({ workflow: "mockup", prompt: "菜单" });
  assert.equal(generated.status, "awaiting_agent");
  assert.match(service.claimAgent(generated.id).instructions, /完整界面效果图|complete interface mockup/);
  await service.completeAgent(generated.id, source);
  await service.running.get(generated.id).promise;
  assert.equal(service.get(generated.id).slices.length, 1);
});

test("direct preservation retains source RGB and transparent frame without whole-layer generation",async()=>{
  const {service,parent,source}=await setup();
  const child=await service.refine(parent.id,{revision:parent.revision,dispatch:false,splitOptions:{useMask:false,preserveAppearance:true,resolutionMode:"source"}});
  const original=await sharp(source).ensureAlpha().raw().toBuffer();
  const alpha=await sharp({create:{width:100,height:60,channels:3,background:"white"}}).png().toBuffer();
  const matte=Buffer.alloc(100*60*3);matte.fill(255,0,30);
  const result=await service.completeLayers(child.id,{layers:[
    {name:"底图",layerType:"background",x:0,y:0,w:100,h:60,zIndex:0,sourcePixels:{alphaDataUrl:dataUrl(alpha)}},
    {name:"保留边距的局部",layerType:"icon",x:0,y:0,w:100,h:60,zIndex:1,sourcePixels:{alphaDataUrl:dataUrl(await sharp(matte,{raw:{width:100,height:60,channels:3}}).png().toBuffer())}},
  ]});
  assert.equal(result.status,"ready");
  const output=await sharp(service.asset(result.id,result.slices[0].file)).ensureAlpha().raw().toBuffer();
  assert.deepEqual(output,original);
  assert.equal(result.slices[1].imageWidth,100,"transparent frame is not trimmed and stretched");
});

// Synthetic flat-color fixtures test the native-resolution transport, not AI quality.
async function hdOutputs(outputs) {
  return Promise.all(outputs.map(async l=>({...l,dataUrl:dataUrl(await sharp(Buffer.from(l.dataUrl.split(',')[1],'base64')).resize({width:1100,height:Math.round(1100*l.h/l.w),fit:'fill'}).png().toBuffer())})));
}

test("HD fidelity keeps generated and reused PNG detail while preserving layout dimensions",async()=>{
  const {service,parent,outputs}=await setup();
  const child=await service.refine(parent.id,{revision:parent.revision,dispatch:false,splitOptions:{useMask:false,preserveAppearance:true}});
  const request=service.claimAgent(child.id);
  assert.equal(child.splitOptions.resolutionMode,"hd");
  assert.doesNotMatch(request.generationPrompt,/SOURCE-PIXEL PRESERVATION/);
  assert.match(request.generationPrompt,/Do not shrink HD images back to layout dimensions/);
  const layers=await hdOutputs(outputs);
  const done=await service.completeLayers(child.id,{layers});
  const detail=done.slices[1];
  assert.equal(detail.w,20);assert.equal(detail.h,10);
  assert.ok(detail.imageWidth>100);assert.ok(detail.imageHeight>50);
  const duplicate=await service.refine(parent.id,{revision:parent.revision,dispatch:false,splitOptions:{useMask:false,preserveAppearance:true}});
  const reused=await service.completeLayers(duplicate.id,{layers:done.slices.map(s=>({...s,reuse:{jobId:done.id,revision:done.revision,sliceId:s.id}}))});
  assert.equal(reused.slices[1].imageWidth,detail.imageWidth);
  assert.equal(reused.slices[1].contentHash,detail.contentHash);
});

test("direct sheet completion preserves crop margins and PNG resolution independently of placement",async()=>{
  const {service,parent}=await setup();
  const child=await service.refine(parent.id,{revision:parent.revision,dispatch:false,splitOptions:{useMask:false}});
  const crop=await sharp({create:{width:800,height:400,channels:4,background:'#ffcc00'}}).extend({left:80,right:80,top:40,bottom:40,background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer();
  const sheet=await sharp({create:{width:2000,height:480,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite([{input:crop,left:0,top:0},{input:crop,left:1040,top:0}]).png().toBuffer();
  const result=await service.completeLayers(child.id,{sheets:[{dataUrl:dataUrl(sheet)}],layers:[{name:'a',layerType:'icon',x:0,y:0,w:24,h:12,zIndex:0,sheetIndex:0,sheetRect:{x:0,y:0,w:960,h:480}},{name:'b',layerType:'icon',x:30,y:0,w:24,h:12,zIndex:1,sheetIndex:0,sheetRect:{x:1040,y:0,w:960,h:480}}]});
  assert.equal(result.status,'ready');assert.equal(result.slices[0].imageWidth,960);assert.equal(result.slices[0].w,24);
  assert.deepEqual(await sharp(service.asset(result.id,result.slices[0].file)).raw().toBuffer(),await sharp(crop).raw().toBuffer());
});

test("plan analysis, edited approval, reconstruction, root export and reload preserve the workflow", async () => {
  const { service, parent, regions, outputs } = await setup();
  const plan = await service.plan(parent.id, { revision: parent.revision, dispatch: false });
  const request = service.claimAgent(plan.id);
  assert.match(request.generationPrompt, /analysis only/);
  assert.match(request.instructions, /complete-plan/);
  await assert.rejects(service.completeAgent(plan.id, Buffer.alloc(1)), /complete-plan/);
  await assert.rejects(service.plan(parent.id, { revision: parent.revision, dispatch: false }), /已有细分任务/);
  service.completePlan(plan.id, { regions });
  assert.throws(() => service.completePlan(plan.id, { regions }), /不等待/);
  const edited = regions.map(r => r.id === "marker" ? { ...r, x: 42 } : r);
  const child = await service.refine(parent.id, { revision: parent.revision, planId: plan.id, regions: edited, dispatch: false });
  assert.match(service.claimAgent(child.id).generationPrompt, /Approved decomposition plan/);
  const result = await service.completeLayers(child.id, { layers: outputs.map(r => r.regionId === "marker" ? { ...r, x: 42 } : r) });
  assert.equal(result.slices[1].regionId, "marker");
  assert.equal(result.slices[1].x, 42);
  const preset = buildPreset(service, parent.id, { revision: parent.revision, variant: "latest" });
  assert.equal(preset.root.children.length, 2, "root decomposition replaces complete mockup in latest export");
  assert.equal(preset.root.children[1].jobId, child.id);
  const restarted = new UiStudioService(path.dirname(service.root));
  assert.deepEqual(restarted.get(child.id).approvedRegions, validatePlan(edited, 100, 60));
  const exported = await service.exportPreset(parent.id, { revision: parent.revision, variant: "latest", format: "psd" });
  assert.equal(exported.layers, 2);
});

test("invalid, stale and mismatched plans cannot silently alter source or published layers", async () => {
  const { service, parent, regions, outputs } = await setup();
  assert.throws(() => validatePlan([regions[0], { ...regions[1], x: 99 }], 100, 60), /范围/);
  assert.throws(() => validatePlan([regions[0], regions[0]], 100, 60), /重复/);
  const plan = await service.plan(parent.id, { revision: parent.revision, dispatch: false });
  service.completePlan(plan.id, { regions });
  const child = await service.refine(parent.id, { revision: parent.revision, planId: plan.id, dispatch: false });
  await assert.rejects(service.completeLayers(child.id, { layers: outputs.map(r => ({ ...r, regionId: "background" })) }), /方案不一致/);
  assert.equal(service.get(child.id).status, "failed");
  assert.equal(service.get(parent.id).revision, parent.revision);
  const retry = await service.refine(parent.id, { revision: parent.revision, planId: plan.id, dispatch: false });
  service.cancel(retry.id);
  await assert.rejects(service.completeLayers(retry.id, { layers: outputs }), /不等待/);
  service.save({ ...parent, revision: "changed" });
  await assert.rejects(service.refine(parent.id, { revision: "changed", planId: plan.id, dispatch: false }), /来源已变化/);
});

test("canvas export uses current geometry, groups, hidden copies and alpha; never accepts arbitrary file paths", async () => {
  const { service, parent, outputs } = await setup();
  const child = await service.refine(parent.id, { revision: parent.revision, dispatch: false });
  const result = await service.completeLayers(child.id, { layers: outputs });
  const leaf = (sliceId, rest = {}) => ({ name: "画布副本", layerType: "icon", x: 5, y: 4, w: 40, h: 20, opacity: .5,
    ref: { jobId: result.id, revision: result.revision, sliceId }, children: [], ...rest });
  const canvas = { width: 80, height: 50, root: { name: "已调整界面", layerType: "component", x: 0, y: 0, w: 80, h: 50, children: [
    { name: "菜单组", layerType: "component", x: 10, y: 10, w: 60, h: 30, children: [leaf("slice-2"), leaf("slice-2", { hidden: true, x: 8, y: 8, w: 40, h: 20 })] },
  ] } };
  const input = { revision: result.revision, variant: "canvas", format: "psd", canvas };
  const exported = await service.exportPreset(result.id, input);
  const manifest = JSON.parse(fs.readFileSync(service.asset(result.id, exported.manifestFile)));
  assert.equal(manifest.variant, "canvas");
  assert.equal(manifest.root.opacity, 1, "Unity receives explicit group alpha instead of a missing float");
  assert.equal(manifest.root.children[0].children.length, 2);
  initializeCanvas(() => { throw new Error("No canvas required"); }, (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }));
  const psd = readPsd(fs.readFileSync(service.asset(result.id, exported.file)), { useImageData: true });
  const layer = psd.children[0].children[0].children[0];
  assert.equal(layer.left, 15); assert.equal(layer.top, 14);
  assert.equal(layer.imageData.width, 40); assert.equal(layer.imageData.height, 20);
  assert.ok(Math.abs(layer.opacity - .5) < .01);
  assert.equal(psd.children[0].children[0].children[1].hidden, true);
  const preview = await sharp(service.asset(result.id, exported.previewFile)).raw().toBuffer();
  assert.equal(preview[(14 * 80 + 15) * 4 + 3], 128);
  assert.equal(preview[(5 * 80 + 5) * 4 + 3], 0);
  const tampered = structuredClone(input);
  tampered.canvas.root.children[0].children[0].ref.sliceId = "missing";
  assert.throws(() => buildCanvasPreset(service, result.id, tampered), /来源不存在/);
  tampered.canvas.root.children[0].children[0] = { ...leaf("slice-2"), x: 59 };
  assert.throws(() => buildCanvasPreset(service, result.id, tampered), /超出/);
});

test("HTTP plan endpoints support pending analysis, completion and approved generation without API credentials", async t => {
  const { service, parent, regions } = await setup();
  const handler = createUiStudioHandler(path.dirname(service.root));
  const server = http.createServer((req, res) => handler(req, res, new URL(req.url, `http://${req.headers.host}`)));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/ui-studio/`;
  const post = async (route, body) => {
    const response = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const plan = await post(`jobs/${parent.id}/plan`, { revision: parent.revision, dispatch: false });
  assert.equal(plan.status, 201); assert.equal(plan.data.operation, "plan");
  const claim = await post(`jobs/${plan.data.id}/claim`, {});
  assert.equal(claim.data.referencePaths.length, 1);
  const complete = await post(`jobs/${plan.data.id}/complete-plan`, { regions });
  assert.equal(complete.data.status, "ready");
  const duplicate = await post(`jobs/${plan.data.id}/complete-plan`, { regions });
  assert.equal(duplicate.status, 400);
  const child = await post(`jobs/${parent.id}/refine`, { revision: parent.revision, planId: plan.data.id, dispatch: false });
  assert.equal(child.data.approvedRegions.length, 2);
  assert.equal(child.data.status, "awaiting_agent");
});


test("candidate review keeps low-resolution outputs, retries only selected layers and publishes explicitly",async()=>{
  const {reviewCandidates,retryCandidates,approveCandidates,restoreCandidates}=await import('../server/ui-studio/candidates.mjs');
  const {service,parent,regions,outputs}=await setup();
  const plan=await service.plan(parent.id,{revision:parent.revision,dispatch:false,autoContinue:true,reviewBeforePublish:true,splitOptions:{useMask:false,resolutionMode:'hd'}});
  service.completePlan(plan.id,{regions});
  const child=await service.continueSplit(plan.id);
  const first=await service.completeLayers(child.id,{layers:outputs});
  assert.equal(first.status,'review_repairs');assert.equal(first.slices?.length||0,0);
  assert.ok(first.repairPreview.slices[1].warnings.length);
  assert.equal((await service.continueSplit(plan.id)).status,'review_repairs');
  const revision=first.repairPreview.revision;
  const kept=fs.readFileSync(service.asset(child.id,first.repairPreview.slices[0].file));
  reviewCandidates(service,child.id,{revision,regionIds:['marker'],notes:{marker:'轮廓更清晰'}});
  assert.deepEqual(new UiStudioService(path.dirname(service.root)).get(child.id).candidateReview.regionIds,['marker']);
  await assert.rejects(retryCandidates(service,child.id,{revision:'stale',regionIds:['marker'],dispatch:false}),/版本/);
  const retry=await retryCandidates(service,child.id,{revision,regionIds:['marker'],dispatch:false});
  assert.equal(retry.attempt,1);
  assert.equal((await retryCandidates(service,child.id,{revision,regionIds:['marker'],dispatch:false})).attempt,1);
  assert.match(service.agentRequest(child.id).generationPrompt,/CANDIDATE REVIEW CONTRACT/);
  await assert.rejects(service.completeLayers(child.id,{layers:[outputs[1]]}),/批次/);
  assert.equal(service.get(child.id).status,'awaiting_agent');
  const second=await service.completeLayers(child.id,{attempt:1,layers:[outputs[1]]});
  assert.equal(second.status,'review_repairs');assert.equal(second.repairPreview.slices.length,2);
  assert.deepEqual(fs.readFileSync(service.asset(child.id,second.repairPreview.slices[0].file)),kept);
  assert.equal(second.candidateHistory.length,1);
  await retryCandidates(service,child.id,{revision:second.repairPreview.revision,regionIds:['marker'],dispatch:false});
  await assert.rejects(service.completeLayers(child.id,{attempt:2,layers:[{...outputs[1],dataUrl:'broken'}]}));
  assert.equal(service.get(child.id).status,'failed');
  assert.equal(service.get(child.id).repairPreview.revision,second.repairPreview.revision);
  assert.ok(fs.readdirSync(path.join(service.directory(child.id),'candidate-submissions')).length>=3);
  restoreCandidates(service,child.id,{revision:second.repairPreview.revision,regionIds:[]});
  assert.throws(()=>approveCandidates(service,child.id,{revision}),/版本/);
  const done=approveCandidates(service,child.id,{revision:second.repairPreview.revision});
  assert.equal(done.status,'ready');assert.equal(done.slices.length,2);
});

test("candidate aspect mismatch keeps native pixels for proportional layout",async()=>{
  const {prepareLayerImage}=await import('../server/ui-studio/layers.mjs');
  const input=await sharp({create:{width:20,height:20,channels:4,background:'#ff0000'}}).extend({top:1,bottom:1,left:1,right:1,background:'#00000000'}).png().toBuffer();
  const warnings=[];
  const png=await prepareLayerImage(input,{w:40,h:10,layerType:'icon'},{candidateMode:true,preserveResolution:true,warnings});
  const meta=await sharp(png).metadata();assert.equal(meta.width,20);assert.equal(meta.height,20);
  const raw=await sharp(png).ensureAlpha().raw().toBuffer();
  let red=0;for(let i=0;i<raw.length;i+=4) if(raw[i+3]===255) red++;
  assert.equal(red,400);assert.ok(warnings.some(w=>w.includes('比例')));
});
