import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createVideoPromptService, parsePromptResult } from "../server/video-prompt.mjs";
import { createGptVideoPromptClient, VIDEO_PROMPT_SCHEMA } from "../server/gpt-video-prompt.mjs";
import { chooseVideoPromptModel, CURSOR_PROMPT_DEFAULT } from "../shared/video-prompt-options.js";

const image = "data:image/png;base64,aW1hZ2U=";
const result = { start: "首帧", end: "尾帧", prompt: "连贯动作" };
const input = { startImage: image, endImage: image, operation: "motion", prompt: "动作" };

test("Cursor prefers Grok 4.7 over Auto and preserves intentional saved choices", () => {
  const models = [{ id: "default" }, { id: "grok-4.7" }, { id: "grok-4.6" }];
  assert.equal(chooseVideoPromptModel(models, "", CURSOR_PROMPT_DEFAULT), "grok-4.7");
  assert.equal(chooseVideoPromptModel(models, "grok-4.6", CURSOR_PROMPT_DEFAULT), "grok-4.6");
  assert.equal(chooseVideoPromptModel(models, "default", CURSOR_PROMPT_DEFAULT), "default");
});

test("GPT routing works independently of Cursor credentials and retains both images", async () => {
  let received;
  const service = createVideoPromptService({ env: {}, gptClient: { status: async () => ({ ready: true }), refine: async (...args) => { received = args; return { text: JSON.stringify(result), model: "default" }; } } });
  assert.equal((await service.list("gpt")).ready, true);
  assert.equal((await service.list("cursor")).ready, false);
  assert.equal((await service.refine({ ...input, provider: "gpt" })).provider, "gpt");
  assert.equal(received[1].length, 2);
  assert.match(received[0], /细化主体/);
});

test("Cursor invokes the requested model with image inputs and disposes the SDK agent", async () => {
  let options, message, disposed = false;
  const service = createVideoPromptService({ env: { CURSOR_API_KEY: "test-only" }, cursorModels: { list: async () => [{ id: "default", displayName: "Auto" }, { id: "grok-4.7", displayName: "Grok 4.7" }] },
    createCursorAgent: async value => { options = value; return { send: async value => { message = value; return { wait: async () => ({ status: "finished", result: JSON.stringify(result) }) }; }, [Symbol.asyncDispose]: async () => { disposed = true; } }; } });
  assert.equal((await service.list("cursor")).defaultModel, "grok-4.7");
  const response = await service.refine({ ...input, provider: "cursor" });
  assert.equal(options.model.id, "grok-4.7");
  assert.deepEqual(options.tools, []);
  assert.equal(message.images.length, 2);
  assert.equal(response.model, "grok-4.7");
  assert.equal(disposed, true);
  await assert.rejects(service.refine({ ...input, provider: "cursor", model: "missing" }), /不可用/);
});

test("local models are filtered by vision capability and receive REST base64 images", async () => {
  let request;
  const service = createVideoPromptService({ env: {}, fetchImpl: async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "text-only" }, { name: "qwen3.8:27b" }] });
    if (url.endsWith("/api/show")) return Response.json({ capabilities: body.model === "text-only" ? ["completion"] : ["completion", "vision"] });
    request = body; return Response.json({ model: body.model, message: { content: JSON.stringify(result) } });
  } });
  assert.deepEqual((await service.list("local")).models.map(item => item.id), ["qwen3.8:27b"]);
  const response = await service.refine({ ...input, provider: "local" });
  assert.equal(response.model, "qwen3.8:27b");
  assert.deepEqual(request.messages[0].images, ["aW1hZ2U=", "aW1hZ2U="]);
  assert.equal(request.keep_alive, 0);
  await assert.rejects(service.refine({ ...input, provider: "local", model: "text-only" }), /不可用/);
});

test("invalid inputs and incomplete model results are rejected across providers", async () => {
  const service = createVideoPromptService({ env: {} });
  await assert.rejects(service.refine({ ...input, provider: "unknown" }), /服务无效/);
  await assert.rejects(service.refine({ ...input, provider: "gpt", startImage: "not-an-image" }), /首尾帧/);
  await assert.rejects(service.refine({ ...input, operation: "unknown" }), /未知/);
  assert.throws(() => parsePromptResult("null", "local", "model"), /未完成/);
  assert.throws(() => parsePromptResult('{"prompt":"missing frames"}', "gpt", "default"), /未完成/);
  assert.equal(parsePromptResult('<think>reasoning</think>\n```json\n' + JSON.stringify(result) + '\n```', "local", "model").prompt, result.prompt);
});

test("GPT CLI uses saved auth, a read-only isolated directory, two image files and structured output", async () => {
  let directory;
  const client = createGptVideoPromptClient({ env: {}, commandFor: () => ({ file: "codex", prefix: [] }), execute: async (_, args, options) => {
    if (args[0] === "login") return "";
    directory = args[args.indexOf("-C") + 1];
    assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
    assert.ok(args.includes("--ephemeral"));
    assert.equal(args.filter(value => value === "--image").length, 2);
    assert.match(options.input, /不调用工具/);
    const schema = JSON.parse(await fs.readFile(args[args.indexOf("--output-schema") + 1], "utf8"));
    assert.deepEqual(schema, VIDEO_PROMPT_SCHEMA);
    await fs.writeFile(args[args.indexOf("--output-last-message") + 1], JSON.stringify(result));
  } });
  const response = await client.refine("识别首尾帧", [{ mimeType: "image/png", data: "aW1hZ2U=" }, { mimeType: "image/png", data: "aW1hZ2U=" }]);
  assert.equal(JSON.parse(response.text).prompt, result.prompt);
  await assert.rejects(fs.access(directory));
});
