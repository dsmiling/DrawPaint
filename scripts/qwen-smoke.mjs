// Real local inference in a separate workspace; ordinary canvases are untouched.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { UiStudioService } from "../server/ui-studio/service.mjs";
import { initCanvasLayout } from "../server/storage.mjs";

const project = path.resolve("output", `qwen-smoke-${Date.now()}`);
const canvas = initCanvasLayout(project);
const service = new UiStudioService(canvas);
const reference = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="256"><rect width="512" height="256" fill="#080f22"/><rect x="64" y="80" width="384" height="96" rx="24" fill="#153b69" stroke="#65d3ff" stroke-width="4"/></svg>')).png().toBuffer();
const started = Date.now();
const job = await service.create({ provider: "qwen", kind: "generate", workflow: "mockup", size: "1024x1024", quality: "medium",
  prompt: "Create a polished science fiction game main menu. Use the reference for the style of blue illuminated rounded buttons. A moonlit planet and stars form the background. Three centered buttons read PLAY, SETTINGS, EXIT. Title STAR VOYAGER. Clear visual hierarchy, crisp flat game screen, elegant cyan lighting.",
  references: [`data:image/png;base64,${reference.toString("base64")}`],
});
console.log(JSON.stringify({ id: job.id, project, status: job.status }));
await service.running.get(job.id).promise;
const done = service.get(job.id);
if (done.status !== "ready") throw new Error(done.error || done.status);
const exported = await service.exportPreset(done.id, { revision: done.revision, format: "unity" });
const source = path.join(service.directory(done.id), done.sourceFile);
const { width, height, hasAlpha } = await sharp(source).metadata();
const report = { id: done.id, promptId: done.qwenPromptId, seconds: Math.round((Date.now() - started) / 1000), source, width, height, hasAlpha,
  slices: done.slices.length, unityPackage: service.asset(done.id, exported.file) };
fs.writeFileSync(path.join(project, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
