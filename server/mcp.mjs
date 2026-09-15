import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
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
import { enrichSelection, insertDrawpaintImage } from "./insert-image.mjs";
import { completeUiJob, completeUiLayers, uiRequest } from "./ui-studio/client.mjs";

const PROJECT_DIR = resolveProjectDir(process.env.DRAWPAINT_PROJECT_DIR);
const CANVAS_DIR = initCanvasLayout(PROJECT_DIR);
const WEB_PORT = Number(process.env.DRAWPAINT_PORT || 43217);
const API_PORT = Number(process.env.DRAWPAINT_API_PORT || 43218);
const CANVAS_URL = `http://127.0.0.1:${WEB_PORT}`;

let started = false;

async function ensureServers() {
  if (started) return { canvasUrl: CANVAS_URL, alreadyRunning: true };
  // Best-effort: check health; if down, ask user to run npm run dev
  try {
    const res = await fetch(`http://127.0.0.1:${API_PORT}/api/health`);
    if (res.ok) {
      started = true;
      return { canvasUrl: CANVAS_URL, alreadyRunning: true };
    }
  } catch {
    // not running
  }
  return {
    canvasUrl: CANVAS_URL,
    alreadyRunning: false,
    hint: "Run npm run dev in the project root, then open the canvas URL in a browser.",
  };
}

function queueInsert({ filePath, relativePath, replaceSelected = false, prompt = "" }) {
  const items = readJson(pendingInsertsPath(CANVAS_DIR), []);
  const item = {
    id: randomUUID(),
    type: "insert_image",
    filePath,
    relativePath,
    url: `/api/assets/${path.basename(relativePath)}`,
    replaceSelected: Boolean(replaceSelected),
    prompt,
    createdAt: new Date().toISOString(),
  };
  items.push(item);
  writeJson(pendingInsertsPath(CANVAS_DIR), items);
  return item;
}

function copyImageToAssets(sourcePath) {
  const abs = path.isAbsolute(sourcePath)
    ? sourcePath
    : path.resolve(PROJECT_DIR, sourcePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Image not found: ${abs}`);
  }
  const ext = path.extname(abs).toLowerCase() || ".png";
  const dir = assetsDir(CANVAS_DIR, "default");
  fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-agent${ext}`;
  const dest = path.join(dir, name);
  fs.copyFileSync(abs, dest);
  return {
    filePath: dest,
    relativePath: `canvas/pages/default/assets/${name}`,
  };
}

const server = new McpServer({
  name: "drawpaint",
  version: "0.1.0",
});

server.tool(
  "open_drawpaint_canvas",
  "Open / locate the DrawPaint infinite canvas for this project. Returns the local canvas URL and whether the API is already running.",
  {},
  async () => {
    const status = await ensureServers();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ...status,
              projectDir: PROJECT_DIR,
              canvasDir: CANVAS_DIR,
              howToOpen: `Open ${status.canvasUrl} in Cursor Simple Browser or the system browser.`,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  "get_drawpaint_selection",
  "Read the currently selected shapes and bounds from the DrawPaint canvas (includes isAiImageHolder).",
  {},
  async () => {
    const selection = enrichSelection(
      readJson(selectionPath(CANVAS_DIR), { shapes: [] }),
    );
    return {
      content: [{ type: "text", text: JSON.stringify(selection, null, 2) }],
    };
  },
);

server.tool(
  "get_drawpaint_pending_request",
  "Read the pending agent request created from the DrawPaint canvas (prompt, screenshot path, referencePaths, elementRefs). Use this when the user asks you to process a DrawPaint request.",
  {},
  async () => {
    const request = readJson(pendingRequestPath(CANVAS_DIR), null);
    return {
      content: [
        {
          type: "text",
          text: request
            ? JSON.stringify(request, null, 2)
            : "No pending DrawPaint request.",
        },
      ],
    };
  },
);

server.tool(
  "clear_drawpaint_pending_request",
  "Clear the pending DrawPaint agent request after it has been handled.",
  {},
  async () => {
    writeJson(pendingRequestPath(CANVAS_DIR), null);
    return {
      content: [{ type: "text", text: "Cleared pending DrawPaint request." }],
    };
  },
);

server.tool(
  "insert_drawpaint_image",
  "Copy a local bitmap into page assets, create a tldraw image shape, and by default replace a targeted AI image holder (frame meta drawpaintAiImageHolder). Otherwise place beside an anchor (placement right, margin 40) or in a clear area. Updates snapshot and notifies open canvas.",
  {
    imagePath: z.string().describe("Absolute or project-relative path to a local image file"),
    anchorShapeId: z.string().optional(),
    sourceShapeId: z.string().optional(),
    fileName: z.string().optional(),
    placement: z.enum(["right", "left", "below"]).optional(),
    margin: z.number().optional(),
    matchAnchor: z.boolean().optional(),
    replaceAiImageHolder: z
      .boolean()
      .optional()
      .describe("Default true when anchor is an AI image holder"),
    replaceSelected: z
      .boolean()
      .optional()
      .describe("Legacy alias; prefer replaceAiImageHolder"),
    displayWidth: z.number().optional(),
    displayHeight: z.number().optional(),
    altText: z.string().optional(),
    annotationScreenshot: z.string().optional(),
    prompt: z.string().optional(),
  },
  async (args) => {
    const imagePath = path.isAbsolute(args.imagePath)
      ? args.imagePath
      : path.resolve(PROJECT_DIR, args.imagePath);
    const result = insertDrawpaintImage(CANVAS_DIR, {
      ...args,
      imagePath,
      replaceAiImageHolder:
        args.replaceAiImageHolder ?? args.replaceSelected,
      altText: args.altText || args.prompt || "",
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: true, ...result }, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "get_drawpaint_snapshot_info",
  "Return DrawPaint storage paths and latest snapshot metadata (not the full tldraw document).",
  {},
  async () => {
    const snap = readJson(snapshotPath(CANVAS_DIR), null);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              projectDir: PROJECT_DIR,
              canvasDir: CANVAS_DIR,
              snapshotPath: snapshotPath(CANVAS_DIR),
              updatedAt: snap?.updatedAt ?? null,
              hasDocument: Boolean(snap?.document),
              root: ROOT,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
server.tool("get_drawpaint_ui_jobs", "List independent UI asset mode jobs; does not read or modify ordinary image requests.", {}, async () => ({
  content: [{ type: "text", text: JSON.stringify(await uiRequest("jobs")) }],
}));
server.tool("get_drawpaint_ui_request", "Read the UI atlas generation prompt and reference files for one independent UI task.",
  { jobId: z.string().uuid() }, async ({ jobId }) => ({
    content: [{ type: "text", text: JSON.stringify(await uiRequest(`jobs/${jobId}/agent-request`)) }],
  }));
server.tool("complete_drawpaint_ui_job", "Submit a generated UI atlas to its own UI task. Automatically removes background, slices components and returns results to the UI material canvas. Never use ordinary insert_drawpaint_image for this mode.",
  { jobId: z.string().uuid(), imagePath: z.string() }, async ({ jobId, imagePath }) => ({
    content: [{ type: "text", text: JSON.stringify(await completeUiJob(jobId, path.resolve(PROJECT_DIR, imagePath))) }],
  }));
server.tool("complete_drawpaint_ui_layers", "Submit independent semantic PNG layers for an AI decomposition task. The JSON manifest contains layers with imagePath, name, layerType, parent-local x/y/w/h and zIndex. Preserves parent-child lineage; never submit an atlas for these tasks.",
  { jobId: z.string().uuid(), manifestPath: z.string() }, async ({ jobId, manifestPath }) => ({
    content: [{ type: "text", text: JSON.stringify(await completeUiLayers(jobId, path.resolve(PROJECT_DIR, manifestPath))) }],
  }));
await server.connect(transport);
