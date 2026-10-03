import fs from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";

const templatePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "video-template.json");

const H3_ASPECT_RATIOS = [
  ["1:1 (Square)", 1],
  ["2:3 (Portrait Photo)", 2 / 3],
  ["3:2 (Photo)", 3 / 2],
  ["3:4 (Portrait Standard)", 3 / 4],
  ["4:3 (Standard)", 4 / 3],
  ["9:16 (Portrait Widescreen)", 9 / 16],
  ["16:9 (Widescreen)", 16 / 9],
  ["21:9 (Ultrawide)", 21 / 9],
];

export function closestH3AspectRatio(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("无法从起始图片读取有效的宽高");
  }

  const ratio = width / height;
  return H3_ASPECT_RATIOS.reduce((closest, candidate) =>
    Math.abs(Math.log(ratio / candidate[1])) < Math.abs(Math.log(ratio / closest[1])) ? candidate : closest,
  )[0];
}

export const VIDEO_MODELS = [
  {
    id: "minimax-h3", name: "MiniMax H3", description: "本机单首帧 / 可选尾帧 · 推荐 5 秒", fps: 24,
    supportsEndFrame: true, durations: [2, 3, 5],
    files: [
      ["diffusion_models", "minimax_h3_fl2va_pruned_fp8_scaled.safetensors"],
      ["text_encoders", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"],
      ["vae", "minimax_h3_video_vae_fp16.safetensors"],
      ["vae", "minimax_h3_audio_vae_fp32.safetensors"],
      ["loras", "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"],
    ],
    nodes: ["MiniMaxH3ImageToVideo", "ComfySwitchNode", "SaveVideo"],
  },
  {
    id: "wan-2.2-5b", name: "Wan 2.2 5B", description: "本机单张起始图生成 · 2 秒（首版）", fps: 16,
    supportsEndFrame: false, durations: [2],
    files: [
      ["diffusion_models", "wan2.2_ti2v_5B_fp16.safetensors"],
      ["text_encoders", "umt5_xxl_fp8_e4m3fn_scaled.safetensors"],
      ["vae", "wan2.2_vae.safetensors"],
    ],
    nodes: ["Wan22ImageToVideoLatent", "SaveVideo"],
  },
];

export function modelById(id) {
  return VIDEO_MODELS.find(model => model.id === id);
}

export function inspectVideoModels(comfyDir, connected, objectInfo) {
  return VIDEO_MODELS.map(model => {
    const missingFiles = model.files.filter(([folder, name]) => {
      try { return fs.statSync(path.join(comfyDir, "models", folder, name)).size < 1024 * 1024; }
      catch { return true; }
    }).map(([folder, name]) => `${folder}/${name}`);
    const missingNodes = connected && objectInfo ? model.nodes.filter(name => !Object.hasOwn(objectInfo, name)) : [];
    return { id: model.id, name: model.name, description: model.description, fps: model.fps, supportsEndFrame: model.supportsEndFrame, durations: model.durations,
      installed: missingFiles.length === 0, ready: connected && Boolean(objectInfo) && missingFiles.length === 0 && missingNodes.length === 0,
      missingFiles, missingNodes };
  });
}

export function buildVideoGraph({ modelId, image, lastImage, prompt, seconds, id, imageWidth, imageHeight }) {
  const model = modelById(modelId);
  if (!model) throw new Error("未知视频模型");
  if (!model.durations.includes(seconds)) throw new Error(`${model.name} 不支持 ${seconds} 秒时长`);
  if (lastImage && !model.supportsEndFrame) throw new Error(`${model.name} 暂不支持尾帧约束`);
  if (model.id === "minimax-h3") {
    const graph = JSON.parse(fs.readFileSync(templatePath, "utf8"));
    graph["114"].inputs.image = image;
    if (imageWidth && imageHeight) {
      graph["115"].inputs.aspect_ratio = closestH3AspectRatio(imageWidth, imageHeight);
    }
    if (lastImage) {
      graph["130"] = { class_type: "LoadImage", inputs: { image: lastImage } };
      graph["105:104"].inputs.last_frame = ["130", 0];
    }
    graph["105:104"].inputs.prompt = prompt;
    graph["105:111"].inputs.value = seconds;
    graph["105:15"].inputs.noise_seed = randomInt(1, 2 ** 48);
    graph["92"].inputs.filename_prefix = `video/DrawPaint_${id}`;
    return graph;
  }
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "wan2.2_ti2v_5B_fp16.safetensors", weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", type: "wan", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "wan2.2_vae.safetensors" } },
    "4": { class_type: "LoadImage", inputs: { image } },
    "5": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: prompt } },
    "6": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: "blurry, flickering, distorted" } },
    "7": { class_type: "Wan22ImageToVideoLatent", inputs: { vae: ["3", 0], width: 512, height: 512, length: 33, batch_size: 1, start_image: ["4", 0] } },
    "8": { class_type: "ModelSamplingSD3", inputs: { model: ["1", 0], shift: 8 } },
    "9": { class_type: "KSampler", inputs: { model: ["8", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0], seed: randomInt(1, 2 ** 48), steps: 20, cfg: 5, sampler_name: "uni_pc", scheduler: "simple", denoise: 1 } },
    "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["3", 0] } },
    "11": { class_type: "CreateVideo", inputs: { images: ["10", 0], fps: 16 } },
    "12": { class_type: "SaveVideo", inputs: { video: ["11", 0], filename_prefix: `video/DrawPaint_${id}`, format: "mp4" } },
  };
}
