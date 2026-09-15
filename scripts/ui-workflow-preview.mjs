// Isolated, deterministic browser fixture. This does not call image generation.
// Run: node scripts/ui-workflow-preview.mjs; open http://127.0.0.1:43227/?mode=ui
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import sharp from "sharp";
import { createServer } from "vite";
import { UiStudioService } from "../server/ui-studio/service.mjs";
import { createUiStudioHandler } from "../server/ui-studio/http.mjs";

fs.mkdirSync("tmp", { recursive: true });
const root = fs.mkdtempSync(path.resolve("tmp/workflow-preview-"));
const service = new UiStudioService(root);
const png = svg => sharp(Buffer.from(svg)).png().toBuffer();
const background = await png('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="#101e29"/><path d="M0 520 Q240 140 330 540 M600 540 Q750 120 960 480" fill="none" stroke="#365265" stroke-width="14"/></svg>');
const title = await png('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="80"><text x="200" y="56" text-anchor="middle" font-family="serif" font-size="48" fill="#f8edce">WORKFLOW TEST</text></svg>');
const button = await png('<svg xmlns="http://www.w3.org/2000/svg" width="260" height="64"><rect x="2" y="2" width="256" height="60" rx="8" fill="#335a6a" stroke="#b79964" stroke-width="4"/><text x="130" y="42" text-anchor="middle" font-family="sans-serif" font-size="26" fill="#ffffff">START GAME</text></svg>');
const tightTitle = await sharp(title).trim().toBuffer({ resolveWithObject: true });
const regions = [
  { id: "background", name: "场景背景", layerType: "background", x: 0, y: 0, w: 960, h: 540, zIndex: 0 },
  { id: "title", name: "界面标题", layerType: "text", text: "WORKFLOW TEST", x: 280 - tightTitle.info.trimOffsetLeft, y: 120 - tightTitle.info.trimOffsetTop, w: tightTitle.info.width, h: tightTitle.info.height, zIndex: 1 },
  { id: "start", name: "开始按钮", layerType: "button", x: 350, y: 290, w: 260, h: 64, zIndex: 2 },
];
const images = [background, tightTitle.data, button];
const source = await sharp(background).composite(regions.slice(1).map((r, i) => ({ input: images[i + 1], left: r.x, top: r.y }))).png().toBuffer();
const parent = await service.create({ workflow: "mockup", kind: "extract", prompt: "流程验证样例（固定测试素材）", dataUrl: `data:image/png;base64,${source.toString("base64")}` });
await service.running.get(parent.id).promise;
const ready = service.get(parent.id);
const plan = await service.plan(ready.id, { revision: ready.revision, dispatch: false });
service.completePlan(plan.id, { regions });
const layers = await Promise.all(regions.map(async (r, i) => {
  const image = i === 0 ? images[i] : await sharp(images[i]).extend({ top: 4, bottom: 4, left: 4, right: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  return { ...r, regionId: r.id, dataUrl: `data:image/png;base64,${image.toString("base64")}`, ...(i === 0 ? { allowOpaque: true } : {}) };
}));
if(process.argv.includes("--candidates")) {
  const child=await service.refine(ready.id,{revision:ready.revision,planId:plan.id,dispatch:false,reviewBeforePublish:true,splitOptions:{resolutionMode:"hd"}});
  await service.completeLayers(child.id,{layers});
}
fs.writeFileSync(path.join(root, "fixture.json"), JSON.stringify({ parentId: ready.id, planId: plan.id, layers }));
fs.writeFileSync(path.resolve("tmp/workflow-preview-path.txt"), root);
const handler = createUiStudioHandler(root);
const api = http.createServer((req, res) => handler(req, res, new URL(req.url, "http://127.0.0.1:43228")));
api.listen(43228, "127.0.0.1");
const vite = await createServer({ server: { host: "127.0.0.1", port: 43227, strictPort: true, proxy: { "/api": { target: "http://127.0.0.1:43228", changeOrigin: true } } } });
await vite.listen();
console.log(`Isolated fixture: ${root}\nhttp://127.0.0.1:43227/?mode=ui`);
process.on("SIGINT", async () => { await vite.close(); api.close(); process.exit(0); });
