export function buildAtlasPrompt(job) {
  if (job.workflow === "mockup") return [
    "Create a complete, polished GAME UI SCREEN MOCKUP with a coherent final composition.",
    job.prompt,
    "Show the actual flat game screen: full background, typography, buttons, icons and decorations placed exactly as they should appear in the finished interface. Use supplied references for the requested visual direction. Keep text readable and exact, with a clear visual hierarchy and safe screen margins.",
    "This is the visual master for later semantic layer reconstruction. Produce ONE fully assembled screen. No asset sheet, separated components, component labels, bounding boxes, device frames or checkerboard. Preserve the intended scene background, lighting and atmosphere.",
    `Target image size: ${job.size}.`,
  ].join("\n\n");
  return [
    "Create a production-oriented GAME UI ASSET SHEET, with separate reusable UI components.",
    job.prompt,
    "Plan a named UI prefab and semantic components (button, text, icon, texture, background, border, decoration). Keep isolated text readable and exact. Classification belongs in metadata, never add type labels onto the sheet.",
    "Use reference images only for visual style and requested components, if supplied.",
    "Arrange every requested component separately. Leave generous empty gutters (at least 32 pixels at 1024 resolution) between components and around the sheet edges.",
    "No overlapping components, no surrounding game scene, no device mockup, no labels or captions unless explicitly requested. Keep each component whole and uncropped.",
    "Keep ornaments belonging to a button attached to that button. Use coherent styling and crisp silhouettes.",
    `Background: a perfectly uniform flat ${job.options.background === "auto" ? "#ff00ff magenta" : job.options.background} color, including empty interiors of hollow frames. Never use this exact background color in the UI artwork. No checkerboard, gradient, texture or drop shadows on the sheet background.`,
    `Target image size: ${job.size}.`,
  ].join("\n\n");
}

export function validateProviderConfig(config) {
  const url = new URL(config.baseUrl);
  if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol)) throw new Error("生图接口地址无效");
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("远程生图接口须使用 HTTPS，本机接口可使用 HTTP");
  if (!config.model?.trim() || config.model.length > 200) throw new Error("请填写模型名称");
  return { baseUrl: url.href.replace(/\/$/, ""), model: config.model.trim(), apiKey: String(config.apiKey || "").trim() };
}

export async function generateAtlas(job, config, references, signal) {
  const fields = { model: config.model, prompt: buildAtlasPrompt(job), size: job.size, quality: job.quality, n: 1 };
  const headers = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
  let body;
  if (references.length) {
    body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.append(key, String(value));
    for (let i = 0; i < references.length; i++) body.append("image[]", new Blob([references[i]], { type: "image/png" }), `reference-${i + 1}.png`);
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(fields);
  }
  const response = await fetch(`${config.baseUrl}/images/${references.length ? "edits" : "generations"}`, { method: "POST", headers, body, signal, redirect: "error" });
  if (!response.ok) {
    // Never persist upstream error bodies: proxies may echo authorization headers.
    throw new Error(`生图接口返回 HTTP ${response.status}。请检查模型、额度、尺寸和接口配置。`);
  }
  const payload = await response.json();
  const encoded = payload.data?.[0]?.b64_json;
  if (encoded && typeof encoded === "string") {
    if (encoded.length > 45 * 1024 * 1024) throw new Error("生成图片超过 32 MB 限制");
    return Buffer.from(encoded, "base64");
  }
  // URL-only gateways must be configured to return base64; no untrusted secondary fetch.
  throw new Error("接口没有返回 data[0].b64_json 图片，请使用支持 Images API base64 输出的生图服务。");
}
