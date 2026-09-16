import fs from "node:fs";
import path from "node:path";
import { agentRequestPath, initCanvasLayout, pendingRequestPath, readJson, resolveProjectDir, writeJson } from "../server/storage.mjs";
import { insertDrawpaintImage } from "../server/insert-image.mjs";

const [command, requestId, value] = process.argv.slice(2);
const project = resolveProjectDir(process.env.DRAWPAINT_PROJECT_DIR);
const canvas = initCanvasLayout(project);
const file = pendingRequestPath(canvas);
const requestFile = agentRequestPath(canvas, requestId);
const request = readJson(requestFile, null) || readJson(file, null);
if (!request || request.id !== requestId) throw new Error("DrawPaint request not found or changed");

if (command === "request") {
  console.log(JSON.stringify(request, null, 2));
} else if (command === "complete") {
  if (!value) throw new Error("Generated image path is required");
  const imagePath = path.resolve(value || "");
  if (!fs.existsSync(imagePath) || !fs.statSync(imagePath).isFile()) {
    throw new Error("Generated image not found or is not a file");
  }
  const annotation = request.type === "annotate_edit";
  const result = insertDrawpaintImage(canvas, {
    imagePath,
    anchorShapeId: request.anchorShapeId || undefined,
    replaceAiImageHolder: request.type === "ai_image_generate",
    placement: annotation ? "right" : undefined,
    margin: annotation ? 40 : undefined,
    matchAnchor: annotation,
    annotationScreenshot: annotation ? request.screenshotAbsolutePath || request.screenshotRelativePath : undefined,
    altText: request.prompt || "",
  });
  writeJson(requestFile, { ...request, status: "completed", result });
  if (readJson(file, null)?.id === request.id) writeJson(file, null);
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
} else if (command === "fail") {
  const failed = { ...request, status: "failed", error: value || "Codex task failed" };
  writeJson(requestFile, failed);
  if (readJson(file, null)?.id === request.id) writeJson(file, failed);
  console.log(JSON.stringify({ ok: true, status: "failed" }));
} else {
  throw new Error("Usage: drawpaint.mjs request|complete|fail <requestId> [imagePath|reason]");
}
