import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { writePsdBuffer } from "ag-psd";
import { strToU8, zipSync } from "fflate";
import { buildPreset } from "./preset.mjs";
import { buildCanvasPreset } from "./canvas-preset.mjs";

export async function exportPreset(service, id, input) {
  if (!["psd", "unity"].includes(input.format)) throw new Error("请选择 PSD 或 Unity 导出");
  const preset = input.variant === "canvas" ? buildCanvasPreset(service, id, input) : buildPreset(service, id, input);
  const scale = input.format === "psd" ? input.scale ?? 1 : 1;
  if (![1,2,4].includes(scale)) throw new Error("PSD 导出倍率须为 1、2 或 4");
  if(scale !== 1) {
    const scaleNode=node=>{
      for(const key of ["x","y","w","h"]) node[key]*=scale;
      if(node.fontSize) node.fontSize*=scale;
      node.children.forEach(scaleNode);
    };
    scaleNode(preset.root);preset.width*=scale;preset.height*=scale;
    preset.exportScale=scale;
  }
  if (preset.width * preset.height > 16777216) throw new Error("预设尺寸过大");
  const files = {}, composite = [], psdChildren = [];
  const sprites = new Map();
  let index = 0, area = 0;
  async function walk(node, x, y) {
    // Explicit values also keep Unity JsonUtility's missing-field defaults harmless.
    node.opacity ??= 1; node.hidden = Boolean(node.hidden);
    if (node.rotation || node.flipX || node.flipY) node.textRender = "image";
    x += node.x; y += node.y;
    const layer = { name: `[${node.layerType || "component"}] ${node.name}`, left: x, top: y, hidden: Boolean(node.hidden), opacity: node.opacity ?? 1 };
    if (node.children.length) {
      layer.children = [];
      for (const child of node.children) layer.children.push(await walk(child, x, y));
    } else {
      area += node.w * node.h;
      if (area > 33554432) throw new Error("图层总面积过大，请拆成组件导出");
      const original = await fs.readFile(service.asset(node.jobId, node.imageFile));
      const bytes = await sharp(original).flop(Boolean(node.flipX)).flip(Boolean(node.flipY)).rotate(node.rotation || 0).resize(node.w, node.h, { fit: "fill" }).png().toBuffer();
      const decoded = await sharp(bytes).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      layer.imageData = { width: decoded.info.width, height: decoded.info.height, data: new Uint8ClampedArray(decoded.data) };
      if (!node.hidden) {
        const faded = Buffer.from(decoded.data);
        for (let p = 3; p < faded.length; p += 4) faded[p] = Math.round(faded[p] * (node.opacity ?? 1));
        composite.push({ input: await sharp(faded, { raw: { width: node.w, height: node.h, channels: 4 } }).png().toBuffer(), left: x, top: y });
      }
      index++;
      // Unity keeps the source texture's resolution; RectTransform controls layout.
      const spriteBytes = input.format === "unity" ? await sharp(original).flop(Boolean(node.flipX)).flip(Boolean(node.flipY)).rotate(node.rotation || 0).png().toBuffer() : bytes;
      const spriteInfo=await sharp(spriteBytes).metadata();
      node.imageWidth=spriteInfo.width;node.imageHeight=spriteInfo.height;
      const hash = createHash("sha256").update(spriteBytes).digest("hex");
      if (!sprites.has(hash)) {
        const file = `Sprites/layer-${sprites.size + 1}.png`;
        sprites.set(hash, file); files[file] = new Uint8Array(spriteBytes);
      }
      node.sprite = sprites.get(hash);
    }
    return layer;
  }
  psdChildren.push(await walk(preset.root, 0, 0));
  const image = await sharp({ create: { width: preset.width, height: preset.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(composite).png().toBuffer();
  const directory = `export-${randomUUID()}`;
  const out = path.join(service.directory(id), directory);
  await fs.mkdir(out, { recursive: true });
  let file;
  if (input.format === "psd") {
    const decoded = await sharp(image).ensureAlpha().raw().toBuffer();
    const psd = writePsdBuffer({ width: preset.width, height: preset.height,
      imageData: { width: preset.width, height: preset.height, data: new Uint8ClampedArray(decoded) }, children: psdChildren }, { generateThumbnail: false });
    file = "preset.psd"; await fs.writeFile(path.join(out, file), psd);
  } else {
    files["preset.json"] = strToU8(JSON.stringify(preset, null, 2));
    files["Preview.png"] = new Uint8Array(image);
    files["Editor/DrawPaintPresetImporter.cs"] = new Uint8Array(await fs.readFile(new URL("./unity/DrawPaintPresetImporter.cs", import.meta.url)));
    files["DrawPaintUIElement.cs"] = new Uint8Array(await fs.readFile(new URL("./unity/DrawPaintUIElement.cs", import.meta.url)));
    const packageFiles = {}, presetFolder = `Assets/DrawPaint/Presets/${directory}/`;
    for (const [name, data] of Object.entries(files)) packageFiles[(name.endsWith('.cs') ? 'Assets/DrawPaint/' : presetFolder) + name] = data;
    packageFiles["README.txt"] = strToU8(`解压到 Unity 项目根目录，与 Assets 文件夹合并。多个包共用 Assets/DrawPaint 中相同导入脚本，预设素材各自独立，不要把每个完整包放进不同 Assets 子文件夹。等待编译后，选中 Presets 中对应 preset.json，菜单 Assets > DrawPaint > Build UI Prefab。依赖 uGUI；可编辑文字需要 TextMeshPro 和对应字体资源。默认文字保留图片显示，类型和文字内容写入 DrawPaintUIElement。生成独立 .prefab，放入现有 Canvas 使用；不会覆盖已有预设，也不绑定业务点击逻辑。布局来源：${preset.variant === "canvas" ? "当前画布，包含位置、尺寸、层级、副本和显隐" : "原始素材或最新成功分层的源像素布局"}。翻转或旋转的文字保留图片外观。\n`);
    file = "unity-preset.zip"; await fs.writeFile(path.join(out, file), zipSync(packageFiles, { level: 0 }));
  }
  await fs.writeFile(path.join(out, "preset.json"), JSON.stringify(preset, null, 2));
  await fs.writeFile(path.join(out, "preview.png"), image);
  return { file: `${directory}/${file}`, previewFile: `${directory}/preview.png`, manifestFile: `${directory}/preset.json`, layers: index };
}
