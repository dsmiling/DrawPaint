import fs from "node:fs";
import { UiStudioService } from "./service.mjs";
import { visionHealth } from "./vision-runtime.mjs";
import { jobDiagnostics } from "./diagnostics.mjs";
import { approveCandidates, retryCandidates, reviewCandidates, restoreCandidates } from "./candidates.mjs";

const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
export function createUiStudioHandler(canvasDir) {
  const service = new UiStudioService(canvasDir);
  const json = (res, status, data) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  };
  async function body(req) {
    if (!req.headers["content-type"]?.startsWith("application/json")) throw new Error("Expected application/json");
    let size = 0; const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 48 * 1024 * 1024) throw new Error("请求过大，请减少图片数量或尺寸");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }
  return async (req, res, url) => {
    if (!url.pathname.startsWith("/api/ui-studio/")) return false;
    try {
      const host = new URL(`http://${req.headers.host}`).hostname;
      if (!localHosts.has(host) || (req.headers.origin && !localHosts.has(new URL(req.headers.origin).hostname))) {
        json(res, 403, { error: "UI 素材接口仅允许本机页面访问" }); return true;
      }
      const route = url.pathname.slice("/api/ui-studio/".length);
      if (req.method === "POST" && route === "uploads") json(res, 201, await service.uploadCanvasAsset((await body(req)).dataUrl));
      else if (req.method === "GET" && /^uploads\/[a-f0-9-]{36}\.png$/.test(route)) {
        const file = `${service.root}/${route}`;
        if (!fs.existsSync(file)) json(res, 404, { error: "素材不存在" });
        else { res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "private, max-age=31536000, immutable" }); fs.createReadStream(file).pipe(res); }
      }
      else if (req.method === "GET" && route === "config") json(res, 200, service.config());
      else if (req.method === "GET" && route === "vision") json(res, 200, await visionHealth());
      else if (req.method === "POST" && route === "config") json(res, 200, service.setConfig(await body(req)));
      else if (req.method === "GET" && route === "snapshot") json(res, 200, service.snapshot());
      else if (req.method === "POST" && route === "snapshot") json(res, 200, service.snapshot(await body(req)));
      else if (req.method === "GET" && route === "jobs") json(res, 200, { jobs: service.list(), agent: await service.agentConnection.status() });
      else if (req.method === "POST" && route === "jobs") json(res, 201, await service.create(await body(req)));
      else {
        const match = /^jobs\/([a-f0-9-]{36})(?:\/(.*))?$/.exec(route);
        if (!match) { json(res, 404, { error: "UI 路径不存在" }); return true; }
        const [, id, action] = match;
        if (req.method === "GET" && !action) json(res, 200, service.get(id));
        else if (req.method === "GET" && action === "diagnostics") json(res, 200, jobDiagnostics(service,id));
        else if (req.method === "POST" && action === "open-thread") { await body(req); service.get(id); json(res,200,await service.agentConnection.openThread(id)); }
        else if (req.method === "POST" && action === "metadata") json(res, 200, service.metadata(id, await body(req)));
        else if (req.method === "POST" && action === "export") json(res, 200, await service.exportPreset(id, await body(req)));
        else if (req.method === "POST" && action === "classify") json(res, 201, await service.classify(id, await body(req)));
        else if (req.method === "POST" && action === "complete-classification") json(res, 200, service.completeClassification(id, await body(req)));
        else if (req.method === "POST" && action === "refine") json(res, 201, await service.refine(id, await body(req)));
        else if (req.method === "POST" && action === "plan") json(res, 201, await service.plan(id, await body(req)));
        else if (req.method === "POST" && action === "hybrid") json(res, 201, await service.hybrid(id, await body(req)));
        else if (req.method === "POST" && action === "masks") json(res, 200, await service.editMasks(id, await body(req)));
        else if (req.method === "POST" && action === "approve-masks") json(res, 200, await service.approveMasks(id, await body(req)));
        else if (req.method === "POST" && action === "complete-repairs") json(res, 200, await service.completeRepairs(id, await body(req)));
        else if (req.method === "POST" && action === "approve-repairs") {const input=await body(req);json(res,200,service.get(id).method === "hybrid" ? service.approveRepairs(id,input) : approveCandidates(service,id,input));}
        else if (req.method === "POST" && action === "review-candidates") json(res,200,reviewCandidates(service,id,await body(req)));
        else if (req.method === "POST" && action === "restore-candidates") json(res,200,restoreCandidates(service,id,await body(req)));
        else if (req.method === "POST" && action === "retry-candidates") json(res,200,await retryCandidates(service,id,await body(req)));
        else if (req.method === "POST" && action === "complete-plan") json(res, 200, service.completePlan(id, await body(req)));
        else if (req.method === "POST" && action === "continue-split") json(res, 200, await service.continueSplit(id, await body(req)));
        else if (req.method === "POST" && action === "complete-layers") json(res, 200, await service.completeLayers(id, await body(req)));
        else if (req.method === "GET" && action === "agent-request") json(res, 200, service.agentRequest(id));
        else if (req.method === "POST" && action === "dispatch") { await body(req); json(res, 200, await service.dispatchAgent(id)); }
        else if (req.method === "POST" && action === "claim") { await body(req); json(res, 200, service.claimAgent(id)); }
        else if (req.method === "POST" && action === "agent-failed") { const input = await body(req); json(res, 200, service.failAgent(id, input.error)); }
        else if (req.method === "POST" && action === "generate") { await body(req); json(res, 200, service.startGeneration(id)); }
        else if (req.method === "POST" && action === "complete") {
          const input = await body(req); const image = await service.upload(input.dataUrl);
          json(res, 200, await service.completeAgent(id, image));
        } else if (req.method === "POST" && action === "process") json(res, 200, service.reprocess(id, await body(req)));
        else if (req.method === "POST" && action === "cancel") { await body(req); json(res, 200, service.cancel(id)); }
        else if (req.method === "GET" && action?.startsWith("assets/")) {
          const file = service.asset(id, decodeURIComponent(action.slice(7)));
          if (!fs.existsSync(file)) json(res, 404, { error: "素材不存在" });
          else {
            const type = file.endsWith(".psd") ? "image/vnd.adobe.photoshop" : file.endsWith(".zip") ? "application/zip" : file.endsWith(".json") ? "application/json" : "image/png";
            res.writeHead(200, { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=31536000, immutable",
              ...(/\.(zip|psd)$/.test(file) ? { "Content-Disposition": `attachment; filename="${file.split(/[\\/]/).at(-1)}"` } : {}) });
            fs.createReadStream(file).pipe(res);
          }
        } else json(res, 404, { error: "UI 操作不存在" });
      }
    } catch (error) { json(res, error.status || 400, { error: error.message }); }
    return true;
  };
}
