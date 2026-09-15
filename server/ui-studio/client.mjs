import fs from "node:fs";
import sharp from "sharp";

export async function uiRequest(route, value) {
  const url = `http://127.0.0.1:${Number(process.env.DRAWPAINT_API_PORT || 43218)}/api/ui-studio/${route}`;
  const response = await fetch(url, value === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
export async function completeUiJob(jobId, imagePath) {
  if (!/^[a-f0-9-]{36}$/.test(jobId)) throw new Error("Invalid UI job ID");
  if (fs.statSync(imagePath).size > 32 * 1024 * 1024) throw new Error("Image exceeds 32 MB");
  const png = await sharp(imagePath, { limitInputPixels: 16777216 }).png().toBuffer();
  return uiRequest(`jobs/${jobId}/complete`, { dataUrl: `data:image/png;base64,${png.toString("base64")}` });
}

export async function completeUiLayers(jobId, manifestPath) {
  if (!/^[a-f0-9-]{36}$/.test(jobId)) throw new Error("Invalid UI job ID");
  if (fs.statSync(manifestPath).size > 1024 * 1024) throw new Error("图层清单过大");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest.layers) || manifest.layers.length < 1 || manifest.layers.length > 64) throw new Error("请提供 1–64 个图层（首次至少两个）");
  const sheets = await sheetPayload(manifest.sheets);
  const layers = [];
  let total = JSON.stringify(sheets || []).length;
  for (const layer of manifest.layers) {
    if(layer.sheetIndex !== undefined || layer.sheetRect !== undefined) {layers.push(layer);continue;}
    if(layer.sourcePixels) {
      const {sourcePixels,...metadata}=layer;
      const converted=await sourcePixelPayload(sourcePixels);
      total+=JSON.stringify(converted).length;
      if(total>46*1024*1024) throw new Error("图层总大小过大，请分批拆解");
      layers.push({...metadata,sourcePixels:converted});continue;
    }
    if (layer.reuse) {
      if (layer.imagePath || layer.dataUrl || layer.background) throw new Error("复用图层不能同时提供新图片或抠图底色");
      layers.push(layer);
      continue;
    }
    const size = fs.statSync(layer.imagePath).size;
    if (size > 32 * 1024 * 1024) throw new Error("图层图片超过 32 MB");
    const png = await sharp(layer.imagePath, { limitInputPixels: 16777216 }).png().toBuffer();
    total += Math.ceil(png.length / 3) * 4;
    if (total > 46 * 1024 * 1024) throw new Error("图层总大小过大，请分批拆解");
    const { imagePath, ...metadata } = layer;
    layers.push({ ...metadata, dataUrl: `data:image/png;base64,${png.toString("base64")}` });
  }
  return uiRequest(`jobs/${jobId}/complete-layers`, { layers, attempt:manifest.attempt, ...(sheets ? {sheets} : {}) });
}

export async function completeUiRepairs(jobId, manifestPath) {
  if (!/^[a-f0-9-]{36}$/.test(jobId) || fs.statSync(manifestPath).size > 1024 * 1024) throw new Error("修补清单无效");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest.repairs) || manifest.repairs.length > 64) throw new Error("修补清单无效");
  const sheets = await sheetPayload(manifest.sheets);
  let total = JSON.stringify(sheets || []).length;
  const repairs = [];
  for (const repair of manifest.repairs) {
    if(repair.sheetIndex !== undefined || repair.sheetRect !== undefined) {repairs.push(repair);continue;}
    if(repair.sourcePixels) {
      const {sourcePixels,...metadata}=repair;
      const converted=await sourcePixelPayload(sourcePixels);
      total+=JSON.stringify(converted).length;
      if(total>46*1024*1024) throw new Error("图层总大小过大，请分批拆解");
      repairs.push({...metadata,sourcePixels:converted});continue;
    }
    if (repair.reuse) {
      if (["imagePath","dataUrl","background","allowOpaque","generatedRect"].some(k=>repair[k]!==undefined)) throw new Error("复用图层不能同时提供新图片、底色或映射");
      repairs.push({regionId:repair.regionId,reuse:repair.reuse});
      continue;
    }
    if (fs.statSync(repair.imagePath).size > 32 * 1024 * 1024) throw new Error("修补图片过大");
    const png = await sharp(repair.imagePath, { limitInputPixels: 16777216 }).png().toBuffer();
    total += Math.ceil(png.length / 3) * 4;
    if (total > 46 * 1024 * 1024) throw new Error("修补图片总大小过大");
    repairs.push({ regionId: repair.regionId, warnings:repair.warnings, ...(repair.generatedRect ? {generatedRect: repair.generatedRect} : {}), ...(repair.background !== undefined ? {background:repair.background} : {}), ...(repair.allowOpaque !== undefined ? {allowOpaque:repair.allowOpaque} : {}), dataUrl: `data:image/png;base64,${png.toString("base64")}` });
  }
  return uiRequest(`jobs/${jobId}/complete-repairs`, { repairs, attempt:manifest.attempt, ...(sheets ? {sheets} : {}) });
}

async function sourcePixelPayload(spec) {
  const result={};
  for(const [fileKey,dataKey] of [["alphaPath","alphaDataUrl"],["repairMaskPath","repairMaskDataUrl"],["repairImagePath","repairDataUrl"]]) {
    if(!spec[fileKey]) continue;
    if(fs.statSync(spec[fileKey]).size>32*1024*1024) throw new Error("保真图层文件超过 32 MB");
    const png=await sharp(spec[fileKey],{limitInputPixels:16777216}).png().toBuffer();
    result[dataKey]=`data:image/png;base64,${png.toString("base64")}`;
  }
  if(!result.alphaDataUrl) throw new Error("缺少元素归属图 alphaPath");
  return result;
}

async function sheetPayload(sheets) {
  if(sheets === undefined) return undefined;
  if(!Array.isArray(sheets) || !sheets.length || sheets.length>8) throw new Error("请提供 1–8 张图集");
  const converted=[];let total=0;
  for(const sheet of sheets) {
    if(fs.statSync(sheet.imagePath).size>32*1024*1024) throw new Error("图集超过 32 MB");
    const png=await sharp(sheet.imagePath,{limitInputPixels:16777216}).png().toBuffer();
    total+=Math.ceil(png.length/3)*4;if(total>46*1024*1024) throw new Error("图集总大小过大");
    converted.push({dataUrl:"data:image/png;base64,"+png.toString("base64"),...(sheet.background!==undefined?{background:sheet.background}:{})});
  }
  return converted;
}
