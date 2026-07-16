import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ROOT,
  assetsDir,
  initCanvasLayout,
  pendingInsertsPath,
  pendingRequestPath,
  readJson,
  resolveCanvasDir,
  resolveProjectDir,
  selectionPath,
  snapshotPath,
  writeJson,
} from "./storage.mjs";

const PORT = Number(process.env.DRAWPAINT_API_PORT || 43218);
const PROJECT_DIR = resolveProjectDir(process.env.DRAWPAINT_PROJECT_DIR);
const CANVAS_DIR = initCanvasLayout(PROJECT_DIR);

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function saveDataUrlAsset(dataUrl, filenameHint = "image.png") {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl || "");
  if (!match) throw new Error("Expected data URL image");
  const mime = match[1];
  const ext =
    mime === "image/jpeg"
      ? "jpg"
      : mime === "image/webp"
        ? "webp"
        : mime === "image/gif"
          ? "gif"
          : "png";
  const dir = assetsDir(CANVAS_DIR, "default");
  fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${filenameHint.replace(/[^\w.-]+/g, "_").replace(/\.\w+$/, "")}.${ext}`;
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, Buffer.from(match[2], "base64"));
  return {
    filePath,
    relativePath: `canvas/pages/default/assets/${name}`,
    url: `/api/assets/${name}`,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);

  if (req.method === "OPTIONS") {
    return sendJson(res, 204, {});
  }

  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        projectDir: PROJECT_DIR,
        canvasDir: CANVAS_DIR,
        canvasUrl: `http://127.0.0.1:${Number(process.env.DRAWPAINT_PORT || 43217)}`,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/snapshot") {
      return sendJson(res, 200, readJson(snapshotPath(CANVAS_DIR), { document: null }));
    }

    if (req.method === "POST" && url.pathname === "/api/snapshot") {
      const body = await readBody(req);
      writeJson(snapshotPath(CANVAS_DIR), {
        schema: "drawpaint.snapshot.v1",
        document: body.document ?? null,
        session: body.session ?? null,
        updatedAt: new Date().toISOString(),
      });
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/selection") {
      const body = await readBody(req);
      writeJson(selectionPath(CANVAS_DIR), {
        schema: "drawpaint.selection.v1",
        shapes: body.shapes || [],
        bounds: body.bounds || null,
        updatedAt: new Date().toISOString(),
      });
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/selection") {
      return sendJson(res, 200, readJson(selectionPath(CANVAS_DIR), { shapes: [] }));
    }

    if (req.method === "POST" && url.pathname === "/api/agent-request") {
      const body = await readBody(req);
      const request = {
        id: randomUUID(),
        schema: "drawpaint.agent-request.v1",
        type: body.type || "generate",
        prompt: body.prompt || "",
        selection: body.selection || null,
        screenshotRelativePath: body.screenshotRelativePath || null,
        anchorShapeId: body.anchorShapeId || null,
        targetWidth: body.targetWidth ?? null,
        targetHeight: body.targetHeight ?? null,
        targetAspectRatio: body.targetAspectRatio || null,
        referencePaths: body.referencePaths || [],
        elementRefs: body.elementRefs || [],
        createdAt: new Date().toISOString(),
        status: "pending",
      };
      writeJson(pendingRequestPath(CANVAS_DIR), request);
      return sendJson(res, 200, { ok: true, request });
    }

    if (req.method === "GET" && url.pathname === "/api/agent-request") {
      return sendJson(res, 200, {
        request: readJson(pendingRequestPath(CANVAS_DIR), null),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/agent-request/clear") {
      writeJson(pendingRequestPath(CANVAS_DIR), null);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/pending-inserts") {
      const items = readJson(pendingInsertsPath(CANVAS_DIR), []);
      return sendJson(res, 200, { items });
    }

    if (req.method === "POST" && url.pathname === "/api/pending-inserts/ack") {
      const body = await readBody(req);
      const ids = new Set(body.ids || []);
      const items = readJson(pendingInsertsPath(CANVAS_DIR), []);
      writeJson(
        pendingInsertsPath(CANVAS_DIR),
        items.filter((item) => !ids.has(item.id)),
      );
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/upload-asset") {
      const body = await readBody(req);
      const saved = saveDataUrlAsset(body.dataUrl, body.filename || "upload.png");
      return sendJson(res, 200, { ok: true, ...saved });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/assets/")) {
      const name = path.basename(url.pathname.slice("/api/assets/".length));
      const filePath = path.join(assetsDir(CANVAS_DIR, "default"), name);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        return res.end("Not found");
      }
      const ext = path.extname(name).toLowerCase();
      const type =
        ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".webp"
            ? "image/webp"
            : ext === ".gif"
              ? "image/gif"
              : "image/png";
      res.writeHead(200, {
        "Content-Type": type,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
      });
      return fs.createReadStream(filePath).pipe(res);
    }

    sendJson(res, 404, { error: "Not found", path: url.pathname });
  } catch (error) {
    sendJson(res, 500, { error: String(error?.message || error) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[drawpaint-api] http://127.0.0.1:${PORT}`);
  console.log(`[drawpaint-api] project=${PROJECT_DIR}`);
  console.log(`[drawpaint-api] canvas=${CANVAS_DIR}`);
  console.log(`[drawpaint-api] root=${ROOT}`);
});
