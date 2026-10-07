import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

export const VIDEO_PROMPT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["start", "end", "prompt"],
  properties: { start: { type: "string" }, end: { type: "string" }, prompt: { type: "string" } },
};

export function codexCommand(env = process.env) {
  if (env.DRAWPAINT_CODEX_PATH) return { file: env.DRAWPAINT_CODEX_PATH, prefix: [] };
  for (const directory of (env.PATH || env.Path || "").split(path.delimiter)) {
    const executable = path.join(directory, process.platform === "win32" ? "codex.exe" : "codex");
    if (existsSync(executable)) return { file: executable, prefix: [] };
    const npmCli = path.join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(npmCli)) return { file: process.execPath, prefix: [npmCli] };
  }
  throw new Error("未找到本机 Codex，请安装并登录，或设置 DRAWPAINT_CODEX_PATH");
}

function run(command, args, { input, timeout, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command.file, [...command.prefix, ...args], { windowsHide: true, timeout, env, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.on("error", () => {});
    child.stdin.end(input || "");
  });
}

export function createGptVideoPromptClient({ env = process.env, execute = run, commandFor = codexCommand } = {}) {
  let statusCache;
  return {
    async status() {
      if (statusCache && Date.now() < statusCache.expires) return statusCache.value;
      let value;
      try {
        await execute(commandFor(env), ["login", "status"], { timeout: 6000, env });
        value = { ready: true };
      } catch { value = { ready: false, error: "GPT 尚未连接，请在本机 Codex 登录后重试" }; }
      statusCache = { expires: Date.now() + 15000, value };
      return value;
    },
    async refine(instruction, images) {
      const status = await this.status();
      if (!status.ready) throw new Error(status.error);
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "drawpaint-video-prompt-"));
      try {
        const schema = path.join(directory, "schema.json"), output = path.join(directory, "result.json");
        await fs.writeFile(schema, JSON.stringify(VIDEO_PROMPT_SCHEMA));
        const imageFiles = [];
        for (const [index, image] of images.entries()) {
          const file = path.join(directory, `frame-${index}.${image.mimeType.split("/")[1]}`);
          await fs.writeFile(file, Buffer.from(image.data, "base64")); imageFiles.push(file);
        }
        const args = ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "-c", 'approval_policy="never"',
          "--color", "never", "-C", directory, ...imageFiles.flatMap(file => ["--image", file]), "--output-schema", schema, "--output-last-message", output];
        if (env.DRAWPAINT_VIDEO_GPT_MODEL) args.push("--model", env.DRAWPAINT_VIDEO_GPT_MODEL);
        args.push("-");
        try {
          await execute(commandFor(env), args, { input: `${instruction}\n只分析随请求附带的两张图片并直接回答，不调用工具，不读取其他文件。`, timeout: 180000, env });
        } catch (error) {
          throw new Error(error.killed ? "GPT 提示词优化超时，请重试" : "GPT 提示词优化失败，请检查本机 Codex 登录与模型配置");
        }
        return { text: await fs.readFile(output, "utf8"), model: env.DRAWPAINT_VIDEO_GPT_MODEL || "default" };
      } finally {
        const absolute = path.resolve(directory), tempRoot = path.resolve(os.tmpdir()) + path.sep;
        if (absolute.startsWith(tempRoot) && path.basename(absolute).startsWith("drawpaint-video-prompt-")) {
          await fs.rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
      }
    },
  };
}
