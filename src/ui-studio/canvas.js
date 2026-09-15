import { AssetRecordType, createShapeId } from "tldraw";
import { assetUrl } from "./api.js";
import { jobImageLayout, redundantAtlasIds, besideSourceLayout } from "./canvas-layout.js";
import { nodeKey } from "./layer-tree.js";
import { visibilityChange } from "./visibility.js";
import { canvasResult, canvasDelivery } from "../../shared/ui-delivery.mjs";
import { verifiedDelivery } from "./delivery-transaction.js";

export function uiShapePage(editor, shape) {
  let parent = shape.parentId;
  while (parent?.startsWith("shape:")) parent = editor.getShape(parent)?.parentId;
  return parent;
}

export function removeRedundantAtlases(editor) {
  const ids = redundantAtlasIds(editor.store.allRecords().filter(record => record.typeName === "shape"));
  if (ids.length) editor.deleteShapes(ids);
}

function sourcePlacement(editor,job) {
  if(job.operation!=='decompose' || !job.parent) return null;
  const sources=uiNodeShapes(editor,{...job.parent,slice:job.parent.rect});
  const source=sources.find(s=>uiShapePage(editor,s)===editor.getCurrentPageId()) || sources[0];
  if(!source) return null;
  const bounds=editor.getShapePageBounds(source);
  return bounds ? {...besideSourceLayout(job,bounds),page:uiShapePage(editor,source)} : null;
}

export function placeJobBesideSource(editor,rawJob) {
  const job=canvasResult(rawJob),placement=sourcePlacement(editor,job);
  if(!placement) throw new Error('原组件不在画布中，请先回填原组件');
  if(!canvasDelivery(job,editor.store.allRecords()).complete) insertJob(editor,job);
  const node={jobId:job.id,revision:job.revision};
  const shapes=uiNodeShapes(editor,node);
  editor.complete();editor.setCurrentTool('select');
  editor.markHistoryStoppingPoint('移到原图旁');
  editor.setCurrentPage(placement.page);
  editor.run(()=>{
    editor.reparentShapes(shapes.map(s=>s.id),placement.page);
    const preview=nodePreview(editor,node);
    if(preview) moveUiNode(editor,node,{x:placement.x-preview.x,y:placement.y-preview.y},false);
  });
  selectUiNode(editor,node);
}

export function insertJob(editor, job) {
  job=canvasResult(job);
  if ((job.status !== "ready" && !job.canvasCandidate) || !job.slices?.length) throw new Error("任务没有通过校验的素材，未修改画布");
  const existing = editor.store.allRecords().filter(s => s.typeName === "shape" && s.meta?.uiJobId === job.id);
  if (canvasDelivery(job,editor.store.allRecords()).complete) {
    if (!job.canvasCandidate) editor.updateShapes(existing.filter(s=>s.meta.uiRevision===job.revision && s.meta.uiCandidate).map(s=>({id:s.id,type:s.type,
      meta:{...s.meta,uiCandidate:false,...(s.type === "group" && s.meta.uiName?.startsWith("待检查 · ") ? {uiName:job.parent?.name || job.prompt} : {})}})));
    return;
  }
  // groupShapes cancels an active selection interaction. Finish it BEFORE
  // creating images, otherwise cancellation can roll those images back and
  // leave only the subsequently created group behind.
  editor.complete();
  editor.setCurrentTool("select");
  const commit=mutate=>verifiedDelivery(editor,job,mutate,
    ()=>editor.markHistoryStoppingPoint("回填 UI 图层"),mark=>editor.bailToMark(mark));
  // A retry replaces textures on the same shapes, keeping user placement and grouping.
  const previousImages=existing.filter(s=>s.type === "image");
  if (existing.some(s=>s.meta.uiCandidate) && previousImages.length===job.slices.length && previousImages.every(s=>job.slices.some(l=>l.id===s.meta.uiSliceId))) {
    const assets=[],updates=[];
    for(const shape of previousImages) {
      const slice=job.slices.find(l=>l.id===shape.meta.uiSliceId),assetId=AssetRecordType.createId();
      assets.push({id:assetId,type:"image",typeName:"asset",props:{name:slice.name,src:assetUrl(job,slice.file),w:slice.imageWidth || slice.w,h:slice.imageHeight || slice.h,mimeType:"image/png",isAnimated:false},meta:{}});
      const before=shape.meta.sourceRect;
      const sx=shape.props.w/(before?.w || slice.w),sy=shape.props.h/(before?.h || slice.h);
      const dx=before ? (slice.x-before.x)*sx : 0,dy=before ? (slice.y-before.y)*sy : 0;
      updates.push({id:shape.id,type:shape.type,
        x:shape.x+dx*Math.cos(shape.rotation)-dy*Math.sin(shape.rotation),
        y:shape.y+dx*Math.sin(shape.rotation)+dy*Math.cos(shape.rotation),
        props:{assetId,w:slice.w*sx,h:slice.h*sy},meta:{...shape.meta,uiRevision:job.revision,uiCandidate:Boolean(job.canvasCandidate),
          sourceRect:{x:slice.x,y:slice.y,w:slice.w,h:slice.h}}});
    }
    updates.push(...existing.filter(s=>s.type === "group").map(s=>({id:s.id,type:s.type,meta:{...s.meta,uiRevision:job.revision,uiCandidate:Boolean(job.canvasCandidate)}})));
    commit(()=>{editor.createAssets(assets);editor.updateShapes(updates);});
    return;
  }
  const placement=!existing.some(s=>s.type==='image') ? sourcePlacement(editor,job) : null;
  if(placement && placement.page!==editor.getCurrentPageId()) editor.setCurrentPage(placement.page);
  const current = editor.getCurrentPageShapes();
  const previous = current.filter(s => s.meta?.uiJobId === job.id);
  const atlasShape = previous.find(s => s.meta.uiRole === "atlas");
  const firstSlice = previous.find(s => s.meta.uiRole === "slice" && s.meta.sourceRect);
  const previousPoint=firstSlice && editor.getShapePageTransform(firstSlice).point();
  const x = firstSlice ? previousPoint.x - firstSlice.meta.sourceRect.x : placement?.x ?? atlasShape?.x ?? (job.operation==='decompose' ? editor.getViewportPageBounds().x+40 : current.length ? Math.max(...current.map(s => (editor.getShapePageBounds(s)?.maxX || 0))) + 100 : 0);
  const y = firstSlice ? previousPoint.y - firstSlice.meta.sourceRect.y : placement?.y ?? atlasShape?.y ?? (job.operation==='decompose' ? editor.getViewportPageBounds().y+40 : 0);
  const images = jobImageLayout(job, { x, y,scale:placement?.scale ?? 1 });
  const shapes = [], assets = [];
  for (const img of images.sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0))) {
    const old = previous.find(s => s.meta.uiName === img.name && s.meta.uiRole === img.role);
    const assetId = AssetRecordType.createId();
    assets.push({ id: assetId, type: "image", typeName: "asset", props: { name: img.name, src: assetUrl(job, img.file),
      w: img.imageWidth || img.sourceW, h: img.imageHeight || img.sourceH, mimeType: "image/png", isAnimated: false }, meta: {} });
    shapes.push({ id: createShapeId(), type: "image", parentId:editor.getCurrentPageId(), x: old ? editor.getShapePageTransform(old).point().x : img.x, y: old ? editor.getShapePageTransform(old).point().y : img.y,
      props: { assetId, w: img.w, h: img.h, altText: img.name },
      meta: { uiJobId: job.id, uiRevision: job.revision, uiCandidate:Boolean(job.canvasCandidate), uiRole: img.role, uiName: img.name,
        uiSliceId: img.id, uiLayerType: img.layerType || "component",
        sourceRect: { x: img.sourceX, y: img.sourceY, w: img.sourceW, h: img.sourceH } } });
  }
  let groupId;
  commit(() => {
    editor.createAssets(assets); editor.createShapes(shapes);
    if (shapes.some(s=>!editor.getShape(s.id))) throw new Error("图片图层创建未完成，已撤回本次回填；请检查画布容量或编辑状态");
    if (job.operation === "decompose" && shapes.length > 1) {
      groupId = createShapeId();
      editor.groupShapes(shapes.map(s => s.id), { groupId });
      editor.updateShape({ id: groupId, type: "group", meta: { uiJobId: job.id, uiRevision: job.revision, uiCandidate:Boolean(job.canvasCandidate), uiRole: "layer-group", uiName: job.presetName || job.parent.name } });
    }
    editor.deleteShapes(previous.map(s => s.id));
  });
  const selected = shapes.filter(s => s.meta.uiRole === "slice").map(s => s.id);
  editor.select(...(groupId ? [groupId] : selected));
  const bounds = editor.getSelectionPageBounds();
  if (bounds) editor.zoomToBounds(bounds, { inset: 64, animation: { duration: 200 } });
}

export function uiNodeShapes(editor, node) {
  if (!editor) return [];
  if (node.children) {
    const leaves = [], visit = n => { if (n.sliceId) leaves.push(n); n.children.forEach(visit); };
    visit(node);
    const ids = new Set(leaves.flatMap(n => uiNodeShapes(editor, { ...n, children: undefined })).map(s => s.id));
    return editor.store.allRecords().filter(s => s.typeName === "shape" && s.type === "image" && ids.has(s.id));
  }
  const shapes = editor.store.allRecords().filter(s => s.typeName === "shape" &&
    (node.instanceKey ? s.meta?.uiNodeKey === node.instanceKey : !s.meta?.uiNodeKey && s.meta?.uiJobId === node.jobId && s.meta.uiRevision === node.revision));
  if (node.sliceId) return shapes.filter(s => s.meta.uiSliceId === node.sliceId || (!s.meta.uiSliceId && s.meta.uiRole === "slice" && node.slice && (s.meta.sourceRect ? ["x", "y", "w", "h"].every(k => s.meta.sourceRect[k] === node.slice[k]) : s.meta.uiName === node.slice.name)));
  const group = shapes.find(s => s.meta.uiRole === "layer-group");
  return group ? [group] : shapes.filter(s => s.meta.uiRole === "slice");
}

export function selectUiNode(editor, node) {
  let shapes = uiNodeShapes(editor, node);
  if (!shapes.length) return false;
  const pageOf = shape => uiShapePage(editor, shape);
  const page = shapes.some(s => pageOf(s) === editor.getCurrentPageId()) ? editor.getCurrentPageId() : pageOf(shapes[0]);
  if (!page || !editor.getPage(page)) return false;
  if (editor.getCurrentPageId() !== page) editor.setCurrentPage(page);
  shapes = shapes.filter(s => pageOf(s) === page);
  editor.setCurrentTool("select");
  if (!node.children && !node.sliceId && shapes.length > 1) {
    const groupId = createShapeId();
    editor.run(() => {
      editor.groupShapes(shapes.map(s => s.id), { groupId });
      editor.updateShape({ id: groupId, type: "group", meta: { uiJobId: node.jobId, uiRevision: node.revision, uiRole: "layer-group", uiName: node.job?.presetName || node.job?.prompt || "UI 预设" } });
    });
    shapes = [editor.getShape(groupId)];
  }
  const commonParent = shapes.every(s => s.parentId === shapes[0].parentId) && editor.getShape(shapes[0].parentId);
  editor.setFocusedGroup(commonParent?.type === "group" ? commonParent.id : null);
  editor.select(...shapes.map(s => s.id));
  editor.zoomToSelection({ animation: { duration: 160 } });
  return true;
}

export function nodePreview(editor, node) {
  const selected = uiNodeShapes(editor, node).filter(s => uiShapePage(editor, s) === editor.getCurrentPageId()), ids = new Set(selected.map(s => s.id));
  const images = editor.store.allRecords().filter(s => {
    if (s.typeName !== "shape" || s.type !== "image") return false;
    let parent = s;
    while (parent) { if (ids.has(parent.id)) return true; parent = editor.getShape(parent.parentId); }
    return false;
  }).map(s => {
    let opacity = s.opacity, parent = editor.getShape(s.parentId);
    const indices = [s.index];
    while (parent) { opacity *= parent.opacity; indices.unshift(parent.index); parent = editor.getShape(parent.parentId); }
    return { id: s.id, src: editor.getAsset(s.props.assetId)?.props.src, bounds: editor.getShapePageBounds(s), opacity, index: indices.join("/") };
  }).filter(s => s.src && s.bounds).sort((a, b) => a.index.localeCompare(b.index));
  if (!images.length) return null;
  const x = Math.min(...images.map(s => s.bounds.x)), y = Math.min(...images.map(s => s.bounds.y));
  return { images, x, y, w: Math.max(...images.map(s => s.bounds.maxX)) - x, h: Math.max(...images.map(s => s.bounds.maxY)) - y };
}

export function moveUiNode(editor, node, delta, mark = true) {
  const shapes = uiNodeShapes(editor, node).filter(s => uiShapePage(editor, s) === editor.getCurrentPageId());
  if (mark) editor.markHistoryStoppingPoint("移动 UI 节点");
  editor.updateShapes(shapes.map(s => {
    const point = editor.getShapePageTransform(s).point();
    const local = editor.getPointInParentSpace(s, { x: point.x + delta.x, y: point.y + delta.y });
    return { id: s.id, type: s.type, x: local.x, y: local.y };
  }));
}

export function uiNodeVisible(editor, node) {
  return uiNodeShapes(editor, node).some(s => {
    let current = s;
    while (current) { if (current.opacity === 0) return false; current = editor.getShape(current.parentId); }
    return true;
  });
}

export function setUiNodeVisible(editor, node, visible) {
  editor.markHistoryStoppingPoint("切换 UI 图层显隐");
  const key = nodeKey(node);
  editor.updateShapes(uiNodeShapes(editor, node).map(s => visibilityChange(s, key, visible)));
}

export function resizeUiNode(editor, node, values, mark = true) {
  const bounds = nodePreview(editor, node);
  if (!bounds) throw new Error("该节点没有画布图片");
  const next = { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h, ...values };
  if (![next.x, next.y, next.w, next.h].every(Number.isFinite) || next.w < 1 || next.h < 1 || next.w > 32768 || next.h > 32768) throw new Error("宽高须在 1–32768 像素之间，坐标须为有效数字");
  const images = bounds.images.map(s => editor.getShape(s.id));
  if ((next.w !== bounds.w || next.h !== bounds.h) && images.some(s => Math.abs(Math.sin(editor.getShapePageTransform(s).rotation() * 2)) > 0.00001)) throw new Error("请先将旋转图层恢复为直角，再输入宽高");
  if (mark) editor.markHistoryStoppingPoint("调整 UI 节点尺寸和位置");
  editor.run(() => {
    const scale = { x: next.w / bounds.w, y: next.h / bounds.h };
    images.forEach(s => editor.resizeShape(s.id, scale, { scaleOrigin: { x: bounds.x, y: bounds.y }, scaleAxisRotation: 0, isAspectRatioLocked: false }));
    const resized = nodePreview(editor, node);
    moveUiNode(editor, node, { x: next.x - resized.x, y: next.y - resized.y }, false);
  });
}

export function locateJob(editor, job) {
  job=canvasResult(job);
  if (!canvasDelivery(job,editor.store.allRecords()).complete) { insertJob(editor,job); return; }
  if (!selectUiNode(editor, { jobId: job.id, revision: job.revision })) insertJob(editor, job);
}
