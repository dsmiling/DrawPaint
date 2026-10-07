import { randomInt, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";

export const QWEN_MODELS = Object.freeze({
  diffusion: "qwen_image_2.1_int8_convrot.safetensors",
  encoder: "qwen3vl_8b_int8_convrot.safetensors",
  vae: "qwen_image_2.1_vae_bf16.safetensors",
});
const requiredNodes = ["UNETLoader", "CLIPLoader", "VAELoader", "TextEncodeQwenImage21", "QwenImage21Cache", "EmptyLatentImage", "KSampler", "VAEDecode", "SaveImage", "LoadImage"];

// Honor the canvas slot size; only scale down to the installed GPU's limits.
export function qwenCanvasSize(width = 1024, height = 1024) {
  width = Number(width) || 1024; height = Number(height) || 1024;
  if (width <= 0 || height <= 0 || !Number.isFinite(width + height)) throw new Error("图片尺寸无效");
  if (Math.max(width, height) / Math.min(width, height) > 8) throw new Error("本地生图宽高比不能超过 8:1，请调整图片框比例");
  const scale = Math.min(1, 1024 / Math.sqrt(width * height), 2048 / Math.max(width, height));
  return { width: Math.max(256, Math.round(width * scale / 32) * 32), height: Math.max(256, Math.round(height * scale / 32) * 32) };
}

export function buildQwenImageGraph({ prompt, width = 1024, height = 1024, references = [], quality = "medium", seed = randomInt(0, 2 ** 32), id = randomUUID() }) {
  if (!String(prompt || "").trim() || prompt.length > 20000) throw new Error("请输入不超过 20000 字符的生图描述");
  if (![width, height].every(n => Number.isInteger(n) && n >= 256 && n <= 2048 && n % 32 === 0)) throw new Error("本地生图尺寸须为 256 至 2048 之间的 32 倍数");
  if (!Array.isArray(references) || references.length > 10) throw new Error("本地生图最多支持 10 张参考图");
  const graph = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: QWEN_MODELS.diffusion, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: QWEN_MODELS.encoder, type: "qwen_image", device: "cpu" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: QWEN_MODELS.vae } },
    "4": { class_type: "TextEncodeQwenImage21", inputs: { clip: ["2", 0], vae: ["3", 0], prompt, negative_prompt: "", resolution: 1024 } },
    "5": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
    "6": { class_type: "QwenImage21Cache", inputs: { model: ["1", 0], device: "cpu", dtype: "int8" } },
    "7": { class_type: "KSampler", inputs: { model: ["6", 0], positive: ["4", 0], negative: ["4", 1], latent_image: ["5", 0], seed,
      steps: { low: 15, medium: 25, high: 40 }[quality] || 25, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: `DrawPaintQwen/${id}` } },
  };
  references.forEach((name, i) => {
    const node = String(10 + i);
    graph[node] = { class_type: "LoadImage", inputs: { image: name } };
    graph["4"].inputs[`images.image_${i + 1}`] = [node, 0];
  });
  return graph;
}

export function createQwenImageClient({ baseUrl = process.env.DRAWPAINT_COMFY_URL || "http://127.0.0.1:8188", fetchImpl = fetch, pollMs = 2000 } = {}) {
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error("本地 Qwen 服务地址须为本机 ComfyUI 地址");
  const base = url.href.replace(/\/$/, "");
  async function request(route, options = {}) {
    try {
      const response = await fetchImpl(`${base}${route}`, { ...options, redirect: "error", signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`ComfyUI 返回 HTTP ${response.status}，请检查模型和工作流。`);
      return response;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (error.message?.startsWith("ComfyUI")) throw error;
      throw new Error("无法连接本地 ComfyUI，请先启动 Qwen 生图服务（默认端口 8188）。");
    }
  }
  const json = async (route, options) => (await request(route, options)).json();
  const post = (route, value, signal) => json(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value), signal });
  async function health(signal) {
    try {
      const info = await json("/object_info", { signal });
      const missingNodes = requiredNodes.filter(node => !info[node]);
      const choices = (node, key) => info[node]?.input?.required?.[key]?.[0] || [];
      const missingModels = [["UNETLoader", "unet_name", QWEN_MODELS.diffusion], ["CLIPLoader", "clip_name", QWEN_MODELS.encoder], ["VAELoader", "vae_name", QWEN_MODELS.vae]]
        .filter(([node, key, name]) => !choices(node, key).includes(name)).map(item => item[2]);
      return { ready: !missingNodes.length && !missingModels.length, model: "Qwen-Image-2.1", baseUrl: base, missingNodes, missingModels,
        error: missingNodes.length ? `缺少 ComfyUI 节点：${missingNodes.join("、")}` : missingModels.length ? `缺少 Qwen 模型：${missingModels.join("、")}` : null };
    } catch (error) { if (signal?.aborted) throw error; return { ready: false, model: "Qwen-Image-2.1", baseUrl: base, missingNodes: [], missingModels: [], error: error.message }; }
  }
  async function submit(options, signal) {
    buildQwenImageGraph({ ...options, references: (options.references || []).map((_, i) => `reference-${i}.png`) });
    const setup = await health(signal);
    if (!setup.ready) throw new Error(setup.error);
    const references = [];
    for (const buffer of options.references || []) {
      if (buffer.length > 32 * 1024 * 1024) throw new Error("参考图不能超过 32 MB");
      const image = await sharp(buffer, { limitInputPixels: 16777216 }).rotate().png().toBuffer();
      const form = new FormData();
      form.append("image", new Blob([image], { type: "image/png" }), `DrawPaintQwen-${randomUUID()}.png`);
      form.append("overwrite", "false");
      const upload = await json("/upload/image", { method: "POST", body: form, signal });
      if (!upload.name || /[\\/]/.test(upload.name) || String(upload.subfolder || "").split(/[\\/]/).includes("..")) throw new Error("ComfyUI 参考图上传结果无效");
      references.push([upload.subfolder, upload.name].filter(Boolean).join("/"));
    }
    const graph = buildQwenImageGraph({ ...options, references });
    const queued = await post("/prompt", { prompt: graph, client_id: randomUUID() }, signal);
    if (!/^[a-f0-9-]{36}$/.test(queued.prompt_id || "")) throw new Error("ComfyUI 未确认生图任务，请检查工作流；请勿自动重复提交。");
    return queued.prompt_id;
  }
  async function result(id, signal) {
    if (!/^[a-f0-9-]{36}$/.test(id || "")) throw new Error("本地生图任务编号无效");
    const history = (await json(`/history/${id}`, { signal }))[id];
    if (history?.status?.status_str === "error") {
      const detail = history.status.messages?.find(entry => entry[0] === "execution_error")?.[1];
      throw new Error(`Qwen 生图失败：${String(detail?.exception_message || "ComfyUI 工作流执行失败").slice(0, 800)}`);
    }
    const output = history?.outputs?.["9"]?.images?.[0];
    if (!output) {
      if (history?.status?.completed) throw new Error("Qwen 生图已结束，但没有输出图片");
      return null;
    }
    if (output.type !== "output" || !/\.(png|webp|jpe?g)$/i.test(output.filename || "") || /[\\/]/.test(output.filename) || String(output.subfolder || "").split(/[\\/]/).includes("..")) throw new Error("ComfyUI 输出图片引用无效");
    const response = await request(`/view?${new URLSearchParams({ filename: output.filename, subfolder: output.subfolder || "", type: "output" })}`, { signal });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 32 * 1024 * 1024) throw new Error("生成图片不能超过 32 MB");
    return buffer;
  }
  async function wait(id, signal) {
    const deadline = Date.now() + 45 * 60_000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const image = await result(id, signal);
      if (image) return image;
      await delay(pollMs, undefined, { signal });
    }
    throw new Error("等待 Qwen 生图超过 45 分钟，请检查 ComfyUI 任务队列。");
  }
  // Delete only this queued task. Do not globally interrupt a shared video/chat worker.
  async function cancel(id) { if (id) await post("/queue", { delete: [id] }); }
  return { health, submit, result, wait, cancel };
}

export const qwenImages = createQwenImageClient();
