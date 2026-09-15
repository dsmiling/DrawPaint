// Real-model smoke test in an isolated canvas; does not dispatch an Agent.
// node scripts/ui-hybrid-preview.mjs <source.png> <plan.json> [--serve]
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { createServer } from "vite";
import { UiStudioService } from "../server/ui-studio/service.mjs";
import { createUiStudioHandler } from "../server/ui-studio/http.mjs";

const [sourcePath, planPath, serve] = process.argv.slice(2);
if (!sourcePath || !planPath) throw new Error("Pass source.png and plan.json; --serve opens an isolated preview server");
await fs.mkdir("tmp", { recursive: true });
const root = await fs.mkdtemp(path.resolve("tmp/hybrid-preview-"));
const service = new UiStudioService(root);
const source = await service.normalizeImage(await fs.readFile(sourcePath));
const parent = await service.create({ kind: "extract", workflow: "mockup", prompt: "原图分割验证 · 独立副本", dataUrl: `data:image/png;base64,${source.toString("base64")}` });
await service.running.get(parent.id).promise;
const ready = service.get(parent.id);
const planned = await service.plan(parent.id, { revision: ready.revision, hybrid: true, dispatch: false });
await service.running.get(planned.id).promise;
if (service.get(planned.id).status !== "awaiting_agent") throw new Error(service.get(planned.id).error);
const regions = JSON.parse(await fs.readFile(planPath, "utf8")).regions;
service.completePlan(planned.id, { regions });
const hybrid = await service.hybrid(parent.id, { revision: ready.revision, planId: planned.id, regions });
await service.running.get(hybrid.id).promise;
const job = service.get(hybrid.id);
if (job.status !== "review_masks") throw new Error(job.error);
await fs.writeFile(path.join(root, "fixture.json"), JSON.stringify({ jobId: job.id, parentId: parent.id, planId: planned.id }));
await fs.writeFile(path.resolve("tmp/hybrid-preview-path.txt"), root);
console.log(JSON.stringify({ root, jobId: job.id, masks: job.hybridDraft.layers.map(l => ({ name: l.name, visiblePixels: l.visiblePixels, repairPixels: l.repairPixels, warnings: l.warnings })) }, null, 2));
if (serve === "--serve") {
  const handler = createUiStudioHandler(root);
  const api = http.createServer((req, res) => handler(req, res, new URL(req.url, "http://127.0.0.1:43238")));
  api.listen(43238, "127.0.0.1");
  const vite = await createServer({ server: { host: "127.0.0.1", port: 43237, strictPort: true, proxy: { "/api": { target: "http://127.0.0.1:43238", changeOrigin: true } } } });
  await vite.listen(); console.log("http://127.0.0.1:43237/?mode=ui");
  process.on("SIGINT", async () => { await vite.close(); api.close(); process.exit(0); });
}
