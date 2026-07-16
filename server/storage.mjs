import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");

export function resolveProjectDir(input) {
  const fromEnv = process.env.DRAWPAINT_PROJECT_DIR;
  const projectDir = path.resolve(input || fromEnv || ROOT);
  return projectDir;
}

export function resolveCanvasDir(projectDir) {
  return path.join(projectDir, "canvas");
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

export function pageDir(canvasDir, pageId = "default") {
  return path.join(canvasDir, "pages", pageId);
}

export function snapshotPath(canvasDir, pageId = "default") {
  return path.join(pageDir(canvasDir, pageId), "snapshot.json");
}

export function assetsDir(canvasDir, pageId = "default") {
  return path.join(pageDir(canvasDir, pageId), "assets");
}

export function selectionPath(canvasDir) {
  return path.join(canvasDir, "selection.json");
}

export function pendingRequestPath(canvasDir) {
  return path.join(canvasDir, "pending-request.json");
}

export function pendingInsertsPath(canvasDir) {
  return path.join(canvasDir, "pending-inserts.json");
}

export function initCanvasLayout(projectDir) {
  const canvasDir = resolveCanvasDir(projectDir);
  ensureDir(assetsDir(canvasDir, "default"));
  ensureDir(path.join(canvasDir, "pages", "default"));
  if (!fs.existsSync(snapshotPath(canvasDir, "default"))) {
    writeJson(snapshotPath(canvasDir, "default"), {
      schema: "drawpaint.snapshot.v1",
      document: null,
      updatedAt: null,
    });
  }
  if (!fs.existsSync(selectionPath(canvasDir))) {
    writeJson(selectionPath(canvasDir), {
      schema: "drawpaint.selection.v1",
      shapes: [],
      updatedAt: null,
    });
  }
  if (!fs.existsSync(pendingRequestPath(canvasDir))) {
    writeJson(pendingRequestPath(canvasDir), null);
  }
  if (!fs.existsSync(pendingInsertsPath(canvasDir))) {
    writeJson(pendingInsertsPath(canvasDir), []);
  }
  return canvasDir;
}
