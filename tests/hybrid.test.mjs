import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { UiStudioService } from "../server/ui-studio/service.mjs";
import { validatePlan } from "../shared/ui-plan.mjs";
import { paintMask, compositeRepair, prepareHybridDraft, mapRepairImage, expandRepairMask } from "../server/ui-studio/hybrid.mjs";
import { buildPreset } from "../server/ui-studio/preset.mjs";
import { unzipSync,strFromU8 } from "fflate";
import { readPsd,initializeCanvas } from "ag-psd";
import { prepareLayerImage } from "../server/ui-studio/layers.mjs";
import { randomUUID } from "node:crypto";
import { sourcePixelLayer } from "../server/ui-studio/source-pixels.mjs";
import { expandSheets } from "../server/ui-studio/sheets.mjs";
import { completeUiRepairs, completeUiLayers } from "../server/ui-studio/client.mjs";
import { finishHybridSegmentation } from "../server/ui-studio/vision-service.mjs";
import { validateHdImage } from "../server/ui-studio/hd-quality.mjs";

const dataUrl = data => `data:image/png;base64,${data.toString("base64")}`;
const encode = (data, w, h, channels = 4) => sharp(data, { raw: { width: w, height: h, channels } }).png().toBuffer();

test("HD measures visible content rather than transparent padding",async()=>{
  const image=await sharp({create:{width:25,height:28,channels:4,background:'#edcd80'}}).extend({left:500,right:500,top:500,bottom:500,background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer();
  await assert.rejects(validateHdImage({splitOptions:{resolutionMode:'hd'}},{name:'金饰'},image),/有效内容分辨率不足/);
  await validateHdImage({splitOptions:{resolutionMode:'source'}},{name:'金饰'},image);
});

test("Mask HD rejects low-resolution output and original-pixel bypass before automatic publication",async t=>{
  for(const kind of ['tiny','sourcePixels']) {
    const {service,job,root}=await fixture('reference');t.after(()=>fs.rm(root,{recursive:true,force:true}));
    service.save({...job,autoContinue:true,splitOptions:{resolutionMode:'hd'}});
    await assert.rejects(service.editMasks(job.id,{version:job.hybridDraft.version,maskPurpose:'cutout'}),/不能切换/);
    await service.approveMasks(job.id,{version:job.hybridDraft.version,dispatch:false});
    const repairs=await generatedLayers();
    if(kind==='sourcePixels') repairs[0]={regionId:'base',sourcePixels:{}};
    await assert.rejects(service.completeRepairs(job.id,{repairs}),/分辨率不足|不能回填原像素/);
    assert.equal(service.get(job.id).status,'failed');assert.equal(service.get(job.id).revision,undefined);
  }
});

test("automatic split continues after segmentation and publishes validated layers without review gates", async t => {
  const {service,job,root}=await fixture("reference"); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  service.save({...job,autoContinue:true,autoDispatch:false,splitOptions:{resolutionMode:"hd"}});
  const next=await finishHybridSegmentation(service,job.id,job.hybridDraft);
  assert.equal(next.status,"awaiting_agent"); assert.equal(next.stage,"repair");
  assert.equal(next.masksApproved,job.hybridDraft.version);
  service.claimAgent(job.id);
  const repairs=await Promise.all(job.hybridDraft.layers.map(async l=>({regionId:l.regionId,allowOpaque:true,
    dataUrl:dataUrl(await encode(Buffer.alloc(l.w*l.h*4,255),l.w,l.h))})));
  // Foreground must still pass alpha validation, even in automatic mode.
  repairs[1].allowOpaque=false;
  const icon=Buffer.alloc(7*6*4,255); icon.fill(0,0,4);
  repairs[1].dataUrl=dataUrl(await encode(icon,7,6));
  // Synthetic fixtures exercise HD delivery, not perceptual sharpness.
  for(const r of repairs) r.dataUrl=dataUrl(await sharp(Buffer.from(r.dataUrl.split(',')[1],'base64')).resize({width:1024}).png().toBuffer());
  const result=await service.completeRepairs(job.id,{repairs});
  assert.equal(result.status,"ready"); assert.equal(result.stage,"done");
  assert.equal(result.repairPreview,null); assert.equal(result.slices.length,2);
  assert.ok(result.revision); assert.ok(await fs.stat(service.asset(job.id,result.slices[1].file)));
  await assert.rejects(service.completeRepairs(job.id,{repairs}),/不等待/);
});

test("automatic split keeps invalid layers off the canvas and respects cancellation", async t => {
  const {service,job,root}=await fixture("reference"); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  service.save({...job,autoContinue:true,autoDispatch:false});
  await finishHybridSegmentation(service,job.id,job.hybridDraft);
  await assert.rejects(service.completeRepairs(job.id,{repairs:[]}),/./);
  assert.equal(service.get(job.id).status,"failed"); assert.equal(service.get(job.id).revision,undefined);
  service.save({...job,status:"cancelled",autoContinue:true});
  assert.equal((await finishHybridSegmentation(service,job.id,job.hybridDraft)).status,"cancelled");
});

test("continuing a legacy plan resumes its existing mask task instead of generating a duplicate", async t => {
  const {service,job,root}=await fixture("reference"); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const next=await service.continueSplit(job.planId,{dispatch:false});
  assert.equal(next.id,job.id); assert.equal(next.stage,"repair");
  assert.equal(next.autoContinue,true); assert.equal(next.status,"awaiting_agent");
  assert.equal(service.list().filter(j=>j.planId===job.planId).length,1);
});

test("preservation keeps original RGB, accepts corrected ownership beyond advisory masks, and limits repair",async t=>{
  const {service,job,root,pixels}=await fixture("reference");t.after(()=>fs.rm(root,{recursive:true,force:true}));
  service.save({...job,splitOptions:{preserveAppearance:true}});
  await service.approveMasks(job.id,{version:job.hybridDraft.version,dispatch:false});
  const request=service.claimAgent(job.id);
  assert.match(request.generationPrompt,/EDIT TARGET/);
  const alpha=Buffer.alloc(240,255),repair=Buffer.alloc(240);
  for(let y=3;y<7;y++) for(let x=5;x<10;x++) repair[y*20+x]=255;
  const fill=Buffer.alloc(240*4);for(let p=0;p<240;p++) fill.set([9,20,30,255],p*4);
  const iconAlpha=Buffer.alloc(42);for(let y=1;y<5;y++) for(let x=1;x<6;x++) iconAlpha[y*7+x]=255;
  // A deliberately empty old guide must not erase the corrected source layer.
  await fs.writeFile(service.asset(job.id,job.hybridDraft.layers[1].maskFile),await encode(Buffer.alloc(42),7,6,1));
  const preview=await service.completeRepairs(job.id,{repairs:[
    {regionId:"base",sourcePixels:{alphaDataUrl:dataUrl(await encode(alpha,20,12,1)),repairMaskDataUrl:dataUrl(await encode(repair,20,12,1)),repairDataUrl:dataUrl(await encode(fill,20,12))}},
    {regionId:"icon",sourcePixels:{alphaDataUrl:dataUrl(await encode(iconAlpha,7,6,1))}},
  ]});
  assert.equal(preview.status,"review_repairs");
  const result=service.approveRepairs(job.id,{revision:preview.repairPreview.revision});
  const actual=await sharp(service.asset(job.id,result.slices[0].file)).ensureAlpha().raw().toBuffer();
  for(let p=0;p<240;p++) assert.deepEqual(actual.subarray(p*4,p*4+4),repair[p]?Buffer.from([9,20,30,255]):pixels.subarray(p*4,p*4+4));
  assert.equal(result.slices[0].preservation.repairedPixels,20);
  assert.equal(result.quality.changedPixels,0,"recomposition equals original despite radically different repair RGB beneath foreground");
  assert.equal(result.slices[1].imageWidth,7,"native source detail is never invented by upscaling");
});

test("preservation rejects whole redraws, stretched mattes, and unpaired repairs",async t=>{
  const {service,job,root}=await fixture("reference");t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const entry=job.hybridDraft.layers[0];
  await assert.rejects(sourcePixelLayer(service,job,entry,{dataUrl:dataUrl(await encode(Buffer.alloc(240*4,255),20,12))}),/不能整层重绘/);
  await assert.rejects(sourcePixelLayer(service,job,entry,{sourcePixels:{alphaDataUrl:dataUrl(await encode(Buffer.alloc(4,255),2,2,1))}}),/尺寸一致/);
  await assert.rejects(sourcePixelLayer(service,job,entry,{sourcePixels:{repairDataUrl:"x"}}),/同时提供/);
});

test("hybrid plan validates parent ordering, point bounds and safe mask geometry", () => {
  const rows = [{ id: "base", name: "底板", layerType: "background", x: 0, y: 0, w: 10, h: 10, zIndex: 0, maskMode: "rectangle", repairMode: "image" },
    { id: "icon", name: "图标", layerType: "icon", x: 2, y: 2, w: 4, h: 4, zIndex: 1, parentId: "base", positivePoints: [[3, 3]], negativePoints: [[9, 9]] }];
  assert.equal(validatePlan(rows, 10, 10)[1].parentId, "base");
  assert.throws(() => validatePlan([rows[0], { ...rows[1], positivePoints: [[10, 1]] }], 10, 10), /提示点/);
  assert.throws(() => validatePlan([{ ...rows[0], parentId: "icon" }, rows[1]], 10, 10), /父层/);
  assert.throws(() => validatePlan([rows[0], { ...rows[1], maskMode: "rectangle" }], 10, 10), /矩形背景/);
  assert.throws(() => validatePlan([rows[0], { ...rows[1], id: "../../x" }], 10, 10), /标识/);
});

test("brush correction preserves unpainted alpha, interpolates lines and bounds input", () => {
  const mask = Buffer.alloc(100, 77);
  const painted = paintMask(mask, 10, 10, [{ mode: "erase", radius: 1, points: [[1, 1], [7, 1]] }]);
  for (let x = 1; x <= 7; x++) assert.equal(painted[10+x], 0);
  assert.equal(painted[99], 77); assert.equal(mask[11], 77);
  assert.throws(() => paintMask(mask, 10, 10, [{ mode: "keep", radius: 1000, points: [[1, 1]] }]), /画笔参数/);
});

test("repair padding removes residual outlines without restoring erased parent pixels", async t => {
  const {service,job,root}=await fixture();t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const isolated=Buffer.alloc(25); isolated[12]=255;
  assert.equal(expandRepairMask(isolated,5,5,1).filter(x=>x===255).length,9);
  assert.throws(()=>expandRepairMask(isolated,5,5,9),/扩边/);
  const edited=await service.editMasks(job.id,{version:job.hybridDraft.version,repairPaddings:[{regionId:"base",padding:2}],edits:[{regionId:"base",strokes:[{mode:"erase",radius:1,points:[[6,4]]}]}]});
  const layer=edited.hybridDraft.layers[0];
  assert.ok(layer.repairPixels>20);
  const pixels=await sharp(service.asset(job.id,layer.imageFile)).ensureAlpha().raw().toBuffer();
  assert.equal(pixels[(4*20+6)*4+3],0,"declared child cannot restore parent brush erasure");
  const saved=await service.editMasks(job.id,{version:edited.hybridDraft.version,edits:[]});
  const again=await sharp(service.asset(job.id,saved.hybridDraft.layers[0].imageFile)).ensureAlpha().raw().toBuffer();
  assert.equal(again[(4*20+6)*4+3],0,"erasure persists when recalculating masks");
});

test("repair copies only approved RGB pixels and cannot change protected colour or alpha", () => {
  const original = Buffer.from([1,2,3,255, 4,5,6,99, 7,8,9,100]);
  const generated = Buffer.alloc(12, 250), mask = Buffer.from([0,255,128]);
  const output = compositeRepair(original, generated, mask);
  assert.deepEqual([...output.subarray(0,4)], [1,2,3,255]);
  assert.deepEqual([...output.subarray(4,8)], [250,250,250,99]);
  assert.equal(output[11], 100);
  assert.throws(() => compositeRepair(original, generated.subarray(4), mask), /原始尺寸/);
});

async function fixture(maskPurpose) {
  await fs.mkdir("tmp", { recursive: true });
  const root = await fs.mkdtemp(path.resolve("tmp/hybrid-test-"));
  const service = new UiStudioService(root);
  const pixels = Buffer.alloc(20*12*4);
  for (let p=0; p<240; p++) pixels.set([35+p%7, 46, 55, 255], p*4);
  for (let y=3; y<7; y++) for (let x=5; x<10; x++) pixels.set([255,190,80,255], (y*20+x)*4);
  const source = await encode(pixels,20,12);
  const initial = await service.create({ kind: "extract", workflow: "mockup", dataUrl: dataUrl(source) });
  await service.running.get(initial.id).promise;
  const parent = service.get(initial.id);
  const plan = await service.plan(parent.id, { revision: parent.revision, dispatch:false });
  const regions = validatePlan([
    { id:"base", name:"底板", layerType:"background", x:0,y:0,w:20,h:12,zIndex:0,repairMode:"image",maskMode:"rectangle" },
    { id:"icon", name:"图标", layerType:"icon", x:4,y:2,w:7,h:6,zIndex:1,parentId:"base" },
  ],20,12);
  service.completePlan(plan.id,{regions});
  const child = {...await service.refine(parent.id,{revision:parent.revision,planId:plan.id,regions,dispatch:false}),...(maskPurpose?{maskPurpose}:{})};
  const directory = service.directory(child.id);
  await fs.mkdir(path.join(directory,"segments"));
  const base = Buffer.alloc(240,255), icon = Buffer.alloc(42);
  for(let y=1;y<5;y++) for(let x=1;x<6;x++) icon[y*7+x]=255;
  await fs.writeFile(path.join(directory,"segments/base.png"),await encode(base,20,12,1));
  await fs.writeFile(path.join(directory,"segments/icon.png"),await encode(icon,7,6,1));
  const hybridDraft = await prepareHybridDraft(directory, child,{model:"fixture",device:"cpu",masks:[{regionId:"base",maskFile:"base.png",warnings:[]},{regionId:"icon",maskFile:"icon.png",warnings:[]}]});
  const job = service.save({...child,method:"hybrid",stage:"review_masks",status:"review_masks",hybridDraft});
  return {service,job,parent,root,pixels,source};
}

test("reviewed hybrid repairs retain exact geometry, source pixels and reusable exports", async t => {
  const {service,job,parent,root,pixels} = await fixture();
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  assert.equal(job.hybridDraft.layers[0].repairPixels,20);
  await assert.rejects(service.refine(parent.id,{revision:parent.revision,dispatch:false}),/已有细分/);
  await assert.rejects(service.editMasks(job.id,{version:"stale"}),/已更新/);
  const pending = await service.approveMasks(job.id,{version:job.hybridDraft.version,dispatch:false});
  assert.equal(pending.status,"awaiting_agent");
  const request = service.claimAgent(job.id);
  assert.equal(request.repairRequests.length,1);
  assert.match(request.instructions,/complete-repairs/);
  await assert.rejects(service.completeLayers(job.id,{layers:[]}),/complete-repairs/);
  const generated = await encode(Buffer.alloc(20*12*4,255),20,12);
  const preview = await service.completeRepairs(job.id,{repairs:[{regionId:"base",dataUrl:dataUrl(generated)}]});
  assert.equal(preview.status,"review_repairs"); assert.equal(preview.revision,undefined);
  assert.throws(()=>service.approveRepairs(job.id,{revision:"stale"}),/变化/);
  assert.equal(buildPreset(service,parent.id,{revision:parent.revision}).root.children.length,1,"unreviewed repairs cannot replace original export");
  const result = service.approveRepairs(job.id,{revision:preview.repairPreview.revision});
  assert.equal(result.status,"ready"); assert.equal(result.slices[1].w,7); assert.equal(result.slices[1].x,4);
  const base = await sharp(service.asset(job.id,result.slices[0].file)).ensureAlpha().raw().toBuffer();
  for(let y=0;y<12;y++) for(let x=0;x<20;x++) {
    const p=(y*20+x)*4;
    if(x>=5&&x<10&&y>=3&&y<7) assert.deepEqual([...base.subarray(p,p+4)],[255,255,255,255]);
    else assert.deepEqual(base.subarray(p,p+4),pixels.subarray(p,p+4));
  }
  const composed=await sharp(service.asset(job.id,result.atlasFile)).raw().toBuffer();
  assert.deepEqual(composed,pixels,"opaque foreground hides repaired pixels; entire reconstruction equals source");
  assert.equal(result.quality.changedPixels,0);
  assert.equal(buildPreset(service,parent.id,{revision:parent.revision}).root.children.length,2);
  const exported=await service.exportPreset(job.id,{revision:result.revision,format:"unity"});
  assert.ok(await fs.stat(service.asset(job.id,exported.file)));
  await assert.rejects(service.completeRepairs(job.id,{repairs:[]}),/不等待/);
});

async function generatedLayers() {
  const base=await sharp({create:{width:80,height:48,channels:4,background:{r:60,g:90,b:120,alpha:1}}}).png().toBuffer();
  const pixels=Buffer.alloc(28*24*4);
  // Complete generated border lies outside the old inset mask, with translucent edges.
  for(let y=0;y<24;y++) for(let x=0;x<28;x++) if(x<2||x>25||y<2||y>21) pixels.set([210,180,60,128],(y*28+x)*4);
  const icon=await encode(pixels,28,24);
  return [{regionId:"base",dataUrl:dataUrl(base),allowOpaque:true},{regionId:"icon",dataUrl:dataUrl(icon)}];
}

test("one sheet becomes independent native-resolution layers and keeps RGBA and layout",async t=>{
  const {service,job,root}=await fixture("reference");t.after(()=>fs.rm(root,{recursive:true,force:true}));
  service.save({...job,splitOptions:{resolutionMode:"hd",generationMode:"sheet",preserveAppearance:true}});
  await service.approveMasks(job.id,{version:job.hybridDraft.version,dispatch:false});
  const request=service.claimAgent(job.id);assert.match(request.generationPrompt,/BATCH SPRITE SHEET/);assert.doesNotMatch(request.generationPrompt,/No contact sheets/);assert.match(request.instructions,/sheets:/);
  const existing=await generatedLayers(),buffers=await Promise.all(existing.map(e=>sharp(Buffer.from(e.dataUrl.split(',')[1],'base64')).resize({width:840,kernel:'nearest'}).png().toBuffer()));
  const png=await sharp({create:{width:1720,height:720,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite([{input:buffers[0],left:0,top:0},{input:buffers[1],left:880,top:0}]).png().toBuffer();
  const preview=await service.completeRepairs(job.id,{sheets:[{dataUrl:dataUrl(png)}],repairs:[{regionId:'base',sheetIndex:0,sheetRect:{x:0,y:0,w:840,h:504},allowOpaque:true},{regionId:'icon',sheetIndex:0,sheetRect:{x:880,y:0,w:840,h:720}}]});
  const layer=preview.repairPreview.slices[1];assert.deepEqual([layer.imageWidth,layer.imageHeight,layer.w,layer.h],[840,720,7,6]);assert.equal(layer.sheetCrop.x,880);
  assert.deepEqual(await sharp(service.asset(job.id,layer.file)).raw().toBuffer(),await sharp(buffers[1]).raw().toBuffer());
  const done=service.approveRepairs(job.id,{revision:preview.repairPreview.revision});assert.equal(done.slices.length,2);
});

test("sheet mappings reject overlaps, out-of-bounds and conflicting sources",async()=>{
  const png=await encode(Buffer.alloc(40*20*4,255),40,20),service={upload:async()=>png},job={splitOptions:{resolutionMode:'hd'}};
  const rows=[{sheetIndex:0,sheetRect:{x:0,y:0,w:20,h:20}},{sheetIndex:0,sheetRect:{x:20,y:0,w:20,h:20}}],sheets=[{dataUrl:dataUrl(png)}];
  for(const invalid of [{...rows[1],sheetRect:{x:19,y:0,w:20,h:20}},{...rows[1],sheetRect:{x:21,y:0,w:20,h:20}},{...rows[1],sheetIndex:2},{...rows[1],reuse:{}},{...rows[1],dataUrl:'bad'}]) await assert.rejects(expandSheets(service,job,[rows[0],invalid],sheets),/图集|重叠/);
  await assert.rejects(expandSheets(service,job,rows,[...sheets,...sheets]),/没有对应/);
  await assert.rejects(expandSheets(service,{splitOptions:{resolutionMode:'source'}},rows,sheets),/原像素/);
  const mixed=await expandSheets(service,job,[rows[0],{reuse:{jobId:'existing'}}],sheets);assert.deepEqual(mixed[1],{reuse:{jobId:'existing'}});
});

test("both CLI completion paths upload a shared sheet once without duplicating per-layer image data",async t=>{
  const root=await fs.mkdtemp(path.resolve('tmp/sheet-cli-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const imagePath=path.join(root,'sheet.png');await fs.writeFile(imagePath,await encode(Buffer.alloc(40*20*4,255),40,20));
  const rows=[{regionId:'a',name:'a',layerType:'icon',x:0,y:0,w:2,h:2,zIndex:0,sheetIndex:0,sheetRect:{x:0,y:0,w:20,h:20}},{regionId:'b',name:'b',layerType:'icon',x:2,y:0,w:2,h:2,zIndex:1,sheetIndex:0,sheetRect:{x:20,y:0,w:20,h:20}}];
  const previousFetch=globalThis.fetch;globalThis.fetch=async(url,options)=>({ok:true,json:async()=>JSON.parse(options.body)});t.after(()=>{globalThis.fetch=previousFetch;});
  for(const [key,complete] of [['layers',completeUiLayers],['repairs',completeUiRepairs]]){const file=path.join(root,key+'.json');await fs.writeFile(file,JSON.stringify({sheets:[{imagePath}], [key]:rows}));const payload=await complete(randomUUID(),file);assert.equal(payload.sheets.length,1);assert.ok(payload.sheets[0].dataUrl);assert.equal(payload[key].length,2);assert.ok(payload[key].every(e=>!e.dataUrl && e.sheetIndex===0));}
});

test("reference masks guide every generated layer without clipping alpha, resolution or exterior pixels",async t=>{
  const {service,job,parent,root,pixels}=await fixture("reference");t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const guide=job.hybridDraft;
  const originalCrop=await sharp(service.asset(job.id,guide.layers[0].referenceFile)).ensureAlpha().raw().toBuffer();
  assert.deepEqual(originalCrop,pixels,"reference image retains foreground and original context");
  await service.approveMasks(job.id,{version:guide.version,dispatch:false});
  const request=service.claimAgent(job.id);
  assert.equal(request.repairRequests.length,2,"unoccluded foreground also needs generation");
  assert.equal(request.referencePaths.length,2);
  assert.match(request.generationPrompt,/NOT authoritative output alpha/);
  assert.match(request.instructions,/完整高清图层|complete high-resolution layers/);
  const generated=await generatedLayers();
  const preview=await service.completeRepairs(job.id,{repairs:generated});
  assert.equal(preview.status,"review_repairs");assert.equal(preview.revision,undefined);
  assert.equal(buildPreset(service,parent.id,{revision:parent.revision}).root.children.length,1);
  const icon=preview.repairPreview.slices[1];
  assert.deepEqual([icon.x,icon.y,icon.w,icon.h,icon.imageWidth,icon.imageHeight],[4,2,7,6,28,24]);
  const output=await sharp(service.asset(job.id,icon.file)).ensureAlpha().raw().toBuffer();
  assert.deepEqual([...output.subarray(0,4)],[210,180,60,128],"old mask's exterior does not delete generated translucent border");
  assert.equal(output[(12*28+14)*4+3],0,"old opaque source does not overwrite generated hole");
  const base=await sharp(service.asset(job.id,preview.repairPreview.slices[0].file)).raw().toBuffer();
  assert.deepEqual([...base.subarray(0,4)],[60,90,120,255],"visible unmasked original pixels are replaced too");
  const result=service.approveRepairs(job.id,{revision:preview.repairPreview.revision});
  const packed=unzipSync(await fs.readFile(service.asset(job.id,result.exportFile)));
  const manifest=JSON.parse(strFromU8(packed["manifest.json"]));
  assert.equal(manifest.reconstruction,"mask-guided-ai");
  for(const layer of manifest.layers) for(const key of ["file","referenceFile","guideFile","maskFile","exclusionFile","repairMaskFile"]) assert.ok(packed[layer[key]],`${key} resolves inside export`);
  assert.ok(packed[manifest.referenceGuide]);
  const unity=await service.exportPreset(job.id,{revision:result.revision,format:"unity"});
  const unityZip=unzipSync(await fs.readFile(service.asset(job.id,unity.file)));
  const unityManifest=JSON.parse(strFromU8(Object.entries(unityZip).find(([f])=>f.endsWith("preset.json"))[1]));
  const sprite=await sharp(Object.entries(unityZip).find(([f])=>f.endsWith(unityManifest.root.children[1].sprite))[1]).metadata();
  assert.deepEqual([sprite.width,sprite.height],[28,24]);assert.equal(unityManifest.root.children[1].w,7);
  const psd=await service.exportPreset(job.id,{revision:result.revision,format:"psd",scale:4});
  initializeCanvas(()=>{throw new Error("Canvas not required");},(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)}));
  const decoded=readPsd(await fs.readFile(service.asset(job.id,psd.file)),{useImageData:true});
  assert.deepEqual([decoded.width,decoded.height],[80,48]);
  const leaf=decoded.children[0].children[1];
  assert.deepEqual([leaf.left,leaf.top,leaf.imageData.width,leaf.imageData.height],[16,8,28,24]);
  assert.deepEqual(Buffer.from(leaf.imageData.data),output);
  await assert.rejects(service.exportPreset(job.id,{revision:result.revision,format:"psd",scale:3}),/倍率/);
  const refined=await service.refine(job.id,{revision:result.revision,sliceId:icon.id,dispatch:false});
  const working=await sharp(service.asset(refined.id,refined.sourceFile)).metadata();
  const master=await sharp(service.asset(refined.id,refined.sourceMasterFile)).metadata();
  assert.deepEqual([working.width,working.height],[7,6]);assert.deepEqual([master.width,master.height],[28,24]);
});

test("reference workflow discovers existing layers and accepts mixed or fully reused native PNGs",async t=>{
  const {service,job,root}=await fixture("reference");t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await service.approveMasks(job.id,{version:job.hybridDraft.version,dispatch:false});
  const preview=await service.completeRepairs(job.id,{repairs:await generatedLayers()});
  const donor=service.approveRepairs(job.id,{revision:preview.repairPreview.revision});
  const id=randomUUID();await fs.cp(service.directory(job.id),service.directory(id),{recursive:true});
  const fresh=service.save({...job,id,status:"review_masks"});
  await service.approveMasks(id,{version:fresh.hybridDraft.version,dispatch:false});
  const request=service.claimAgent(id);
  assert.equal(request.reusableComponents.filter(c=>c.jobId===donor.id).length,2);
  assert.equal(request.reusableComponents.find(c=>c.jobId===donor.id&&c.sliceId==='slice-2').imageWidth,28);
  assert.match(request.generationPrompt,/Before any generation, inspect reusableComponents/);
  const reuse=i=>({regionId:i===0?'base':'icon',reuse:{jobId:donor.id,revision:donor.revision,sliceId:donor.slices[i].id}});
  const mixed=await service.completeRepairs(id,{repairs:[(await generatedLayers())[0],reuse(1)]});
  assert.equal(mixed.repairPreview.reusedLayers,1);
  const copied=mixed.repairPreview.slices[1];
  assert.deepEqual([copied.imageWidth,copied.imageHeight,copied.w,copied.h],[28,24,7,6]);
  assert.deepEqual(await fs.readFile(service.asset(id,copied.file)),await fs.readFile(service.asset(donor.id,donor.slices[1].file)));
  const edited=await service.editMasks(id,{version:fresh.hybridDraft.version,edits:[]});
  await service.approveMasks(id,{version:edited.hybridDraft.version,dispatch:false});
  service.upload=async()=>{throw new Error('All-reuse must not upload generated images');};
  const all=await service.completeRepairs(id,{repairs:[reuse(0),reuse(1)]});
  assert.equal(all.status,'review_repairs');assert.equal(all.repairPreview.reusedLayers,2);
  assert.equal(all.repairPreview.slices[1].extraction,'reused');
  for(const kind of ['stale','conflict','type','ratio','text']){
    const current=await service.editMasks(id,{version:service.get(id).hybridDraft.version,edits:[]});
    await service.approveMasks(id,{version:current.hybridDraft.version,dispatch:false});
    const rows=[reuse(0),reuse(1)];
    if(kind==='stale')rows[1].reuse.revision=randomUUID();
    if(kind==='conflict')rows[1].generatedRect={x:0,y:0,w:28,h:24};
    if(kind==='type')rows[1].reuse.sliceId='slice-1';
    if(kind==='ratio')service.save({...donor,slices:donor.slices.map(s=>s.id==='slice-2'?{...s,w:10}:s)});
    if(kind==='text'){
      service.save({...donor,slices:donor.slices.map(s=>s.id==='slice-2'?{...s,layerType:'text',text:'5678'}:s)});
      const target=service.get(id);target.hybridDraft.layers[1]={...target.hybridDraft.layers[1],layerType:'text',text:'1280'};service.save(target);
    }
    await assert.rejects(service.completeRepairs(id,{repairs:rows}),/复用|分类|文字|宽高比/);
    assert.equal(service.get(id).revision,undefined);
    service.save(donor);
  }
});

test("reference corrections are semantic hints, persist with notes, and can regenerate an empty mask",async t=>{
  const {service,job,root}=await fixture();t.after(()=>fs.rm(root,{recursive:true,force:true}));
  service.save({...job,splitOptions:{useMask:true,keepText:false,granularity:"components",notes:"去掉文字"}});
  const edited=await service.editMasks(job.id,{version:job.hybridDraft.version,maskPurpose:"reference",layerNotes:[{regionId:"icon",notes:"保留细线，修正缺口"}],edits:[{regionId:"icon",strokes:[{mode:"erase",radius:20,points:[[3,3]]}]}]});
  assert.equal(edited.maskPurpose,"reference");assert.equal(edited.hybridDraft.layers[1].visiblePixels,0);
  const request=await service.approveMasks(job.id,{version:edited.hybridDraft.version,dispatch:false});
  assert.equal(request.status,"awaiting_agent");
  const claimed=service.claimAgent(job.id);
  assert.equal(claimed.repairRequests[1].instructions,"保留细线，修正缺口");
  assert.match(claimed.generationPrompt,/Remove all readable text/);
  assert.match(claimed.generationPrompt,/Split into complete components/);
  const preview=await service.completeRepairs(job.id,{repairs:await generatedLayers()});
  const reloaded=new UiStudioService(root);
  assert.equal(reloaded.get(job.id).repairPreview.slices[1].imageWidth,28);
  const corrected=await reloaded.editMasks(job.id,{version:edited.hybridDraft.version,layerNotes:[{regionId:"icon",notes:"细线更清晰"}],edits:[]});
  assert.equal(corrected.repairPreview,null);assert.notEqual(corrected.hybridDraft.version,edited.hybridDraft.version);
  assert.throws(()=>reloaded.approveRepairs(job.id,{revision:preview.repairPreview.revision}),/变化/);
  await assert.rejects(reloaded.editMasks(job.id,{version:corrected.hybridDraft.version,layerNotes:[{regionId:"missing",notes:"x"}]}),/说明无效/);
});

test("reference completion rejects missing layers, fake transparency and bad mappings without publication",async t=>{
  const {service,job,root}=await fixture("reference");t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let current=job;
  for(const kind of ["missing","opaque","mapping"]) {
    await service.approveMasks(job.id,{version:current.hybridDraft.version,dispatch:false});
    const repairs=await generatedLayers();
    if(kind==="missing") repairs.pop();
    if(kind==="opaque") repairs[1]={regionId:"icon",dataUrl:repairs[0].dataUrl,allowOpaque:true};
    if(kind==="mapping") repairs[1].generatedRect={x:0,y:0,w:500,h:500};
    await assert.rejects(service.completeRepairs(job.id,{repairs}),/每个|矩形背景|映射范围/);
    assert.equal(service.get(job.id).revision,undefined);
    current=await service.editMasks(job.id,{version:current.hybridDraft.version,edits:[]});
  }
});

test("high resolution import retains frame margins and faint alpha; declared key removes hollow interiors",async()=>{
  const pixels=Buffer.alloc(40*20*4);
  for(let y=5;y<15;y++)for(let x=10;x<30;x++)pixels.set([80,140,220,255],(y*40+x)*4);
  pixels.set([80,140,220,2],(8*40+1)*4);
  const image=await encode(pixels,40,20);
  const framed=await prepareLayerImage(image,{name:"带余量",w:20,h:10},{preserveResolution:true,preserveFrame:true});
  assert.deepEqual(await sharp(framed).ensureAlpha().raw().toBuffer(),pixels);
  const key=Buffer.alloc(40*20*4);
  for(let y=0;y<20;y++)for(let x=0;x<40;x++)key.set(x>=2&&x<38&&y>=1&&y<19&&(x<5||x>34||y<4||y>15)?[200,190,90,255]:[255,0,255,255],(y*40+x)*4);
  const removed=await prepareLayerImage(await encode(key,40,20),{name:"镂空边框",background:"#ff00ff",w:20,h:10},{preserveResolution:true,preserveFrame:true});
  const rgba=await sharp(removed).ensureAlpha().raw().toBuffer();
  assert.equal(rgba[(10*40+20)*4+3],0);assert.equal(rgba[(2*40+3)*4+3],255);
  await assert.rejects(prepareLayerImage(image,{name:"比例错误",w:5,h:10},{preserveResolution:true,preserveFrame:true}),/宽高比/);
});

test("generated repair mapping is explicit, bounded, and retains protected source pixels", async t => {
  const {service,job,parent,root,pixels}=await fixture(); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const generated=await sharp({create:{width:40,height:30,channels:4,background:{r:180,g:90,b:70,alpha:1}}}).png().toBuffer();
  const entry=job.hybridDraft.layers[0];
  await assert.rejects(mapRepairImage(generated,entry),/尺寸不一致/);
  await assert.rejects(mapRepairImage(generated,entry,{x:30,y:0,w:20,h:24}),/映射范围/);
  await assert.rejects(mapRepairImage(generated,entry,{x:0,y:0,w:1.5,h:24}),/映射范围/);
  await service.approveMasks(job.id,{version:job.hybridDraft.version,dispatch:false});
  const preview=await service.completeRepairs(job.id,{repairs:[{regionId:"base",dataUrl:dataUrl(generated),generatedRect:{x:0,y:3,w:40,h:24}}]});
  assert.equal(preview.status,"review_repairs");
  const reloaded=new UiStudioService(root);
  assert.equal(reloaded.get(job.id).status,"review_repairs");
  await assert.rejects(reloaded.refine(parent.id,{revision:parent.revision,dispatch:false}),/已有细分/);
  const base=preview.repairPreview.slices[0];
  assert.deepEqual(base.repairMapping.generatedRect,{x:0,y:3,w:40,h:24});
  const decoded=await sharp(reloaded.asset(job.id,base.file)).ensureAlpha().raw().toBuffer();
  for(let y=0;y<12;y++) for(let x=0;x<20;x++) {
    const p=(y*20+x)*4;
    if(x>=5&&x<10&&y>=3&&y<7) assert.deepEqual([...decoded.subarray(p,p+4)],[180,90,70,255]);
    else assert.deepEqual(decoded.subarray(p,p+4),pixels.subarray(p,p+4));
  }
  const edited=await reloaded.editMasks(job.id,{version:job.hybridDraft.version,edits:[]});
  assert.equal(edited.status,"review_masks"); assert.equal(edited.repairPreview,null);
  assert.throws(()=>reloaded.approveRepairs(job.id,{revision:preview.repairPreview.revision}),/变化/);
  await reloaded.approveMasks(job.id,{version:edited.hybridDraft.version,dispatch:false});
  const again=await reloaded.completeRepairs(job.id,{repairs:[{regionId:"base",dataUrl:dataUrl(await encode(Buffer.alloc(960,255),20,12))}]});
  reloaded.cancel(job.id);
  assert.throws(()=>reloaded.approveRepairs(job.id,{revision:again.repairPreview.revision}),/变化/);
});

test("invalid repairs fail without publication, retain masks, and allow explicit correction", async t => {
  const {service,job,root} = await fixture();t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await service.approveMasks(job.id,{version:job.hybridDraft.version,dispatch:false});
  await assert.rejects(service.completeRepairs(job.id,{repairs:[]}),/每个/);
  assert.equal(service.get(job.id).revision,undefined);
  const edited=await service.editMasks(job.id,{version:job.hybridDraft.version,edits:[{regionId:"icon",strokes:[{mode:"erase",radius:1,points:[[1,1]]}]}]});
  assert.equal(edited.status,"review_masks");assert.notEqual(edited.hybridDraft.version,job.hybridDraft.version);
  service.cancel(job.id);
  await assert.rejects(service.editMasks(job.id,{version:edited.hybridDraft.version}),/不能校正/);
});


test("Mask candidates await explicit approval and targeted retry preserves untouched PNGs",async t=>{
  const {retryCandidates}=await import('../server/ui-studio/candidates.mjs');
  const {service,job,root}=await fixture('reference');t.after(()=>fs.rm(root,{recursive:true,force:true}));
  service.save({...job,reviewBeforePublish:true,autoContinue:true,autoDispatch:false,splitOptions:{resolutionMode:'hd'}});
  await service.approveMasks(job.id,{version:job.hybridDraft.version,dispatch:false});
  const outputs=await generatedLayers();outputs[1].warnings=['检查细线'];
  const first=await service.completeRepairs(job.id,{repairs:outputs});
  assert.equal(first.status,'review_repairs');assert.ok(first.repairPreview.slices[1].warnings.includes('检查细线'));
  const kept=await fs.readFile(service.asset(job.id,first.repairPreview.slices[0].file));
  await retryCandidates(service,job.id,{revision:first.repairPreview.revision,regionIds:['icon'],notes:{icon:'更清晰'},dispatch:false});
  const request=service.agentRequest(job.id);
  assert.equal(request.repairRequests.length,1);assert.equal(request.repairRequests[0].regionId,'icon');
  await assert.rejects(service.completeRepairs(job.id,{repairs:[outputs[1]]}),/批次/);
  const second=await service.completeRepairs(job.id,{attempt:1,repairs:[outputs[1]]});
  assert.equal(second.status,'review_repairs');assert.equal(second.repairPreview.slices.length,2);
  assert.deepEqual(await fs.readFile(service.asset(job.id,second.repairPreview.slices[0].file)),kept);
  assert.equal(service.approveRepairs(job.id,{revision:second.repairPreview.revision}).status,'ready');
});
