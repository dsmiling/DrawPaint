import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { resolveProjectDir, initCanvasLayout } from "./storage.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PROJECT_DIR = resolveProjectDir(process.env.DRAWPAINT_PROJECT_DIR);
initCanvasLayout(PROJECT_DIR);

const api = spawn(process.execPath, [path.join(__dirname, "http.mjs")], {
  cwd: ROOT,
  env: {
    ...process.env,
    DRAWPAINT_PROJECT_DIR: PROJECT_DIR,
  },
  stdio: "inherit",
});

api.on("exit", (code) => {
  if (code && code !== 0) {
    console.error(`[drawpaint] API exited with code ${code}`);
    process.exit(code);
  }
});

const vite = await createServer({
  root: ROOT,
  configFile: path.join(ROOT, "vite.config.js"),
  server: {
    host: "127.0.0.1",
    port: Number(process.env.DRAWPAINT_PORT || 43217),
    strictPort: true,
  },
});

await vite.listen();
vite.printUrls();
console.log(`[drawpaint] project=${PROJECT_DIR}`);
console.log(`[drawpaint] open the canvas URL above to test.`);

async function shutdown() {
  await vite.close();
  api.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
