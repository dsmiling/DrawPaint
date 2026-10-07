import fs from "node:fs";
import path from "node:path";
import { insertDrawpaintImage } from "./insert-image.mjs";
import { agentRequestPath, agentRequestsDir, pendingRequestPath, readJson, writeJson, snapshotPath, assetsDir } from "./storage.mjs";
import { qwenImages, qwenCanvasSize } from "./qwen-images.mjs";

export function createQwenCanvas(canvasDir, client = qwenImages) {
  const active = new Map();
  const save = request => {
    writeJson(agentRequestPath(canvasDir, request.id), request);
    if (readJson(pendingRequestPath(canvasDir))?.id === request.id) writeJson(pendingRequestPath(canvasDir), request);
    return request;
  };
  function complete(request, result) {
    save({ ...request, status: "completed", result });
    if (readJson(pendingRequestPath(canvasDir))?.id === request.id) writeJson(pendingRequestPath(canvasDir), null);
  }
  function resume(request) {
    if (active.has(request.id)) return;
    // A restart between snapshot insertion and request acknowledgement must not
    // insert the same result again.
    const store = readJson(snapshotPath(canvasDir))?.document?.store || {};
    const inserted = Object.values(store).find(shape => shape.typeName === "shape" && shape.meta?.drawpaintRequestId === request.id);
    if (inserted) {
      complete(request, { shapeId: inserted.id, assetId: inserted.props.assetId, url: store[inserted.props.assetId]?.props.src });
      return;
    }
    const controller = new AbortController();
    active.set(request.id, controller);
    (async () => {
      const image = await client.wait(request.qwenPromptId, controller.signal);
      controller.signal.throwIfAborted();
      const file = path.join(agentRequestsDir(canvasDir), `${request.id}.png`);
      fs.writeFileSync(file, image);
      const result = insertDrawpaintImage(canvasDir, {
        imagePath: file, fileName: `qwen-${request.id}.png`, anchorShapeId: request.anchorShapeId || undefined,
        replaceAiImageHolder: request.type === "ai_image_generate", matchAnchor: request.type === "annotate_edit",
        annotationScreenshot: request.type === "annotate_edit" ? request.screenshotRelativePath : undefined,
        altText: request.prompt, shapeMeta: { drawpaintProvider: "qwen", drawpaintRequestId: request.id },
      });
      complete(request, result);
    })().catch(error => { if (!controller.signal.aborted) save({ ...request, status: "failed", error: error.message }); })
      .finally(() => active.delete(request.id));
  }
  for (const name of fs.readdirSync(agentRequestsDir(canvasDir)).filter(n => n.endsWith(".json"))) {
    const request = readJson(path.join(agentRequestsDir(canvasDir), name));
    if (request?.provider === "qwen" && request.status === "qwen_queued" && request.qwenPromptId) resume(request);
    else if (request?.provider === "qwen" && request.status === "qwen_submitting") save({ ...request, status: "failed", error: "服务在提交时重启，结果未确认。请先检查 ComfyUI 队列，再决定是否重新生图。" });
  }
  async function dispatch(request) {
    if (readJson(agentRequestPath(canvasDir, request.id))?.status !== "pending") throw new Error("该生图任务已提交，请勿重复发送");
    save({ ...request, status: "qwen_submitting" });
    try {
      const paths = [...(request.referencePaths || [])];
      if (request.type === "annotate_edit") {
        const store = readJson(snapshotPath(canvasDir))?.document?.store || {};
        const shape = store[request.anchorShapeId];
        const src = store[shape?.props?.assetId]?.props?.src;
        if (src?.startsWith("/api/assets/")) paths.unshift(path.join(assetsDir(canvasDir), path.basename(src.slice(12))));
        if (request.screenshotAbsolutePath) paths.splice(1, 0, request.screenshotAbsolutePath);
      }
      const references = [...new Set(paths)].map(file => fs.readFileSync(file));
      if (references.length > 10) throw new Error("底图、标注截图和参考图合计最多 10 张，请减少参考图");
      const size = qwenCanvasSize(request.targetWidth, request.targetHeight);
      const prompt = request.type === "annotate_edit" ? [
        "Edit the original image using the annotated screenshot as a location guide. Follow arrows and annotation text; use additional images as references for the indicated content. Return only the clean edited original image, without arrows, annotations or surrounding canvas. Preserve unedited areas and the original composition.",
        ...(request.selection?.shapes || []).map(shape => shape.props?.text || "").filter(Boolean),
      ].join("\n") : request.generationPrompt || request.prompt;
      const qwenPromptId = await client.submit({ prompt, ...size, references, id: request.id }, undefined);
      const next = save({ ...request, status: "qwen_queued", qwenPromptId, generationSize: size });
      resume(next);
      return { provider: "qwen", promptId: qwenPromptId, generationSize: size };
    } catch (error) { save({ ...request, status: "failed", error: error.message }); throw error; }
  }
  async function cancel(id) {
    const request = readJson(agentRequestPath(canvasDir, id));
    if (request?.provider !== "qwen" || !["qwen_queued"].includes(request.status)) throw new Error("该本地任务不能取消");
    active.get(id)?.abort();
    save({ ...request, status: "cancelled" });
    await client.cancel(request.qwenPromptId);
    return { ok: true };
  }
  return { dispatch, cancel };
}
