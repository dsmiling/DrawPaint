import { Agent, Cursor } from "@cursor/sdk";

const operations = {
  polish: "润色动作描述，使动作、主体和首尾状态清晰连贯",
  motion: "细化主体的动作轨迹、节奏和过渡，避免凭空增加画面元素",
  camera: "补充合适的镜头运动与构图表达，保持画面主体和风格一致",
};
let modelCache = { expires: 0, models: [] };

async function availableModels() {
  if (Date.now() < modelCache.expires) return modelCache.models;
  const models = await Cursor.models.list({ apiKey: process.env.CURSOR_API_KEY });
  modelCache = { expires: Date.now() + 60_000, models };
  return models;
}

function parseImage(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
  if (!match || Buffer.byteLength(match[2], "base64") > 8 * 1024 * 1024) throw new Error("首尾帧须为不超过 8 MB 的 PNG、JPEG 或 WebP 图片");
  return { mimeType: match[1], data: match[2] };
}

export async function listPromptModels() {
  if (!process.env.CURSOR_API_KEY) return { ready: false, models: [], error: "请在 DrawPaint 服务环境中设置 CURSOR_API_KEY" };
  const models = await availableModels();
  return { ready: true, models: models.map(({ id, displayName }) => ({ id, name: displayName || id })) };
}

export async function refineVideoPrompt(input) {
  if (!process.env.CURSOR_API_KEY) throw new Error("请先设置 CURSOR_API_KEY");
  const prompt = String(input.prompt || "").trim();
  if (prompt.length > 2000) throw new Error("动作描述不能超过 2000 字");
  const operation = operations[input.operation];
  if (!operation) throw new Error("未知的润色操作");
  const images = [parseImage(input.startImage), parseImage(input.endImage)];
  const models = await availableModels();
  const model = models.find(item => item.id === input.model);
  if (!model) throw new Error("所选模型不可用，请刷新模型列表");
  const instruction = `你是图生视频提示词编辑。两张图片依次是首帧和尾帧。先分别识别每张图片中实际可见的主体、物件、背景，再比较变化，然后完成：${operation}。用户原描述：${prompt || "（未填写，请根据两帧可见变化生成描述）"}。图片事实优先于用户文字；如果文字提到图片中看不到的主体，不要把它写成确定可见的物体。只返回 JSON 对象，不要 Markdown，格式为 {"start":"首帧可见内容的简短描述","end":"尾帧可见内容的简短描述","prompt":"可直接用于图生视频的一段中文动作提示词"}。不要臆造看不到的物体、身份或情节；保留与图片不冲突的用户动作意图。prompt 最多 2000 字。`;
  const agent = await Agent.create({ apiKey: process.env.CURSOR_API_KEY, model: { id: model.id }, local: { cwd: process.cwd() }, tools: [] });
  try {
    const run = await agent.send({ text: instruction, images });
    const result = await run.wait();
    if (result.status !== "finished" || !result.result?.trim()) throw new Error(result.error?.message || "模型未返回润色结果");
    let value;
    try { value = JSON.parse(result.result.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); }
    catch { throw new Error("模型返回格式无效，请重试或更换模型"); }
    if (![value.start, value.end, value.prompt].every(item => typeof item === "string" && item.trim())) throw new Error("模型未完成首尾帧识别，请重试");
    return { prompt: value.prompt.trim().slice(0, 2000), start: value.start.trim(), end: value.end.trim(), model: result.model?.id || model.id };
  } finally {
    await agent[Symbol.asyncDispose]();
  }
}
