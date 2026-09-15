import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import sharp from "sharp";
import { normalizeOptions, validateSlices } from "./segmentation.mjs";
import { buildAtlasPrompt, generateAtlas, validateProviderConfig } from "./provider.mjs";
import { createAgentConnection } from "./agent-connection.mjs";
import { buildLayerPrompt, validateLayers, writeLayers } from "./layers.mjs";
import { preservesSource, sourcePixelLayer } from "./source-pixels.mjs";
import { expandSheets } from "./sheets.mjs";
import { readSnapshot, saveSnapshot } from "./snapshot.mjs";
import { writeJsonAtomic as write } from "./atomic.mjs";
import { updateSemantics, classificationPrompt } from "./semantics.mjs";
import { exportPreset } from "./export.mjs";
import { buildPlanPrompt, validatePlan } from "../../shared/ui-plan.mjs";
import { visionHealth } from "./vision-runtime.mjs";
import { hybridRepairPrompt } from "./hybrid.mjs";
import { normalizeSplitOptions, minimumHdSide } from "../../shared/split-options.mjs";
import { validateHdImage } from "./hd-quality.mjs";
import { candidateInstructions, mergeCandidateInputs, retainSubmission, validateCandidateAttempt } from "./candidates.mjs";
import { preparePlanOcr, createHybrid, editHybridMasks, approveHybridMasks, completeHybridRepairs, approveHybridRepairs } from "./vision-service.mjs";

const activeStatuses = new Set(["generating", "processing"]);
const agentStatuses = new Set(["awaiting_agent", "agent_dispatching", "agent_queued", "agent_generating", "agent_unknown"]);
const idPattern = /^[a-f0-9-]{36}$/;
const now = () => new Date().toISOString();
function read(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }

export class UiStudioService {
  constructor(canvasDir, { agentConnection } = {}) {
    this.root = path.join(canvasDir, "ui-studio");
    this.running = new Map();
    this.refining = new Set();
    this.splitContinuations = new Map();
    this.agentConnection = agentConnection || createAgentConnection(this.root);
    fs.mkdirSync(path.join(this.root, "jobs"), { recursive: true });
    for (const job of this.list()) if (activeStatuses.has(job.status)) {
      this.save({ ...job, status: "failed", error: "服务已重启，任务未完成。已有原图可以重新切图；生图不会自动重复扣费。" });
    }
    for (const job of this.list()) if (job.status === "agent_dispatching") {
      this.save({ ...job, status: "agent_unknown", error: "服务重启，Agent 提交结果待确认；不会自动重复提交。" });
    }
    for (const job of this.list()) if (job.autoContinue && job.operation === "plan" && job.status === "ready" && !job.continuationId && !job.continuationError) {
      queueMicrotask(() => this.continueSplit(job.id).catch(() => {}));
    }
  }
  directory(id) {
    if (!idPattern.test(id)) throw new Error("Invalid UI task ID");
    return path.join(this.root, "jobs", id);
  }
  get(id) { const job = read(path.join(this.directory(id), "job.json")); if (!job) throw new Error("UI 任务不存在"); return job; }
  save(job) { job.updatedAt = now(); write(path.join(this.directory(job.id), "job.json"), job); return job; }
  list() {
    return fs.readdirSync(path.join(this.root, "jobs")).filter(id => idPattern.test(id))
      .map(id => read(path.join(this.directory(id), "job.json"))).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  config(privateView = false) {
    const saved = read(path.join(this.root, "provider.local.json"), {});
    const config = { baseUrl: saved.baseUrl || process.env.DRAWPAINT_UI_BASE_URL || "https://api.openai.com/v1",
      model: saved.model || process.env.DRAWPAINT_UI_MODEL || "gpt-image-2",
      apiKey: saved.apiKey ?? process.env.DRAWPAINT_UI_API_KEY ?? "" };
    const local = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/])/.test(config.baseUrl);
    return privateView ? config : { baseUrl: config.baseUrl, model: config.model, hasKey: Boolean(config.apiKey), configured: Boolean(config.apiKey) || local };
  }
  setConfig(value) {
    const previous = this.config(true);
    if (value.baseUrl && value.baseUrl.replace(/\/$/, "") !== previous.baseUrl.replace(/\/$/, "") && !value.apiKey) {
      // Never forward a credential saved for one service to a newly selected host.
      previous.apiKey = "";
    }
    const config = validateProviderConfig({ baseUrl: value.baseUrl, model: value.model, apiKey: value.clearKey ? "" : value.apiKey || previous.apiKey });
    write(path.join(this.root, "provider.local.json"), config);
    return this.config();
  }
  async normalizeImage(buffer) {
    if (buffer.length > 32 * 1024 * 1024) throw new Error("图片不能超过 32 MB");
    const decoder = sharp(buffer, { limitInputPixels: 16777216 });
    const metadata = await decoder.metadata();
    if (!["png", "jpeg", "webp"].includes(metadata.format) || (metadata.pages || 1) > 1) throw new Error("请选择静态 PNG、JPEG 或 WebP 图片");
    return decoder.rotate().toColourspace("srgb").png().toBuffer();
  }
  async upload(dataUrl) {
    const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
    if (!match) throw new Error("请选择 PNG、JPEG 或 WebP 图片");
    return this.normalizeImage(Buffer.from(match[1], "base64"));
  }
  async create(input) {
    if (this.running.size >= 2) throw new Error("已有两个 UI 任务运行，请稍后重试");
    const kind = input.kind === "extract" ? "extract" : "generate";
    const provider = input.provider === "api" ? "api" : "agent";
    if (kind === "generate" && provider === "agent" && input.dispatch && !(await this.agentConnection.status()).connected) {
      throw new Error("Agent 尚未连接画布，请让当前 Agent 启动本机连接，无需配置生图 API。");
    }
    if (kind === "generate" && !String(input.prompt || "").trim()) throw new Error("请输入需要生成的 UI 素材");
    if (String(input.prompt || "").length > 12000) throw new Error("提示词过长");
    if (!Array.isArray(input.references || []) || (input.references || []).length > 4) throw new Error("最多添加 4 张参考图");
    if (kind === "generate" && provider === "api" && !this.config().configured) throw new Error("请先在生图服务设置中连接 UI 生图服务");
    const size = input.size || "1024x1024";
    if (!["1024x1024", "1536x1024", "1024x1536", "2048x2048", "2048x1152"].includes(size)) throw new Error("Unsupported size");
    const id = randomUUID();
    const workflow = input.workflow === "mockup" ? "mockup" : "atlas";
    const job = { id, kind, provider, workflow, prompt: String(input.prompt || (workflow === "mockup" ? "Imported interface mockup" : "Imported UI atlas")), size,
      quality: ["low", "medium", "high"].includes(input.quality) ? input.quality : "medium",
      options: normalizeOptions(workflow === "mockup" ? { removeBackground: false, autoSplit: false, padding: 0 } : input.options), status: "queued", createdAt: now(), updatedAt: now(), references: [] };
    const source = kind === "extract" ? await this.upload(input.dataUrl) : null;
    const refs = await Promise.all((input.references || []).map(ref => this.upload(ref)));
    if (this.running.size >= 2 && !(kind === "generate" && provider === "agent")) throw new Error("已有两个 UI 任务运行，请稍后重试");
    fs.mkdirSync(this.directory(id), { recursive: true });
    for (let i = 0; i < refs.length; i++) {
      const file = `reference-${i + 1}.png`;
      fs.writeFileSync(path.join(this.directory(id), file), refs[i]); job.references.push(file);
    }
    if (source) { job.sourceFile = "source.png"; fs.writeFileSync(path.join(this.directory(id), job.sourceFile), source); }
    if (kind === "generate" && provider === "agent") job.status = "awaiting_agent";
    this.save(job);
    if (job.status === "awaiting_agent" && input.dispatch) return this.dispatchAgent(id);
    if (job.status !== "awaiting_agent") this.launch(id, kind === "generate" ? "generate" : "process");
    return this.get(id);
  }
  startGeneration(id) {
    const job = this.get(id);
    if (["plan", "classify"].includes(job.operation)) throw new Error("分析任务须由 Agent 返回清单，不能调用生图");
    if (job.operation === "decompose") throw new Error("AI 分层请通过 Agent 返回独立图层");
    if (job.kind !== "generate" || job.status !== "awaiting_agent") throw new Error("该任务已经启动，不能重复生图");
    if (!this.config().configured) throw new Error("请先在生图服务设置中连接 UI 生图服务");
    if (this.running.size >= 2) throw new Error("已有两个 UI 任务运行，请稍后重试");
    this.save({ ...job, provider: "api" });
    this.launch(id, "generate");
    return this.get(id);
  }
  async dispatchAgent(id) {
    const job = this.get(id);
    if (job.kind !== "generate" || job.status !== "awaiting_agent") throw new Error("该任务已经提交，不能重复触发 Agent");
    if (!(await this.agentConnection.status()).connected) throw new Error("Agent 尚未连接画布，请让当前 Agent 启动本机连接。");
    // Recheck after the asynchronous connection check to reject concurrent clicks.
    if (this.get(id).status !== "awaiting_agent") throw new Error("该任务已经提交，不能重复触发 Agent");
    this.save({ ...this.get(id), ...(job.autoContinue ? { autoDispatch: true } : {}), provider: "agent", status: "agent_dispatching", error: null });
    try {
      await this.agentConnection.dispatch(id);
      const current = this.get(id);
      if (current.status === "agent_dispatching") this.save({ ...current, status: "agent_queued" });
    } catch {
      const current = this.get(id);
      // The message may already have been delivered. Do not automatically resend.
      if (current.status === "agent_dispatching") this.save({ ...current, status: "agent_unknown", error: "Agent 提交结果尚未确认，请检查当前对话。为避免重复生图，不会自动重发。" });
    }
    return this.get(id);
  }
  claimAgent(id) {
    const job = this.get(id);
    if (!agentStatuses.has(job.status) || job.status === "agent_generating") throw new Error("任务已被领取或已结束，请勿重复生图");
    this.save({ ...job, status: "agent_generating", error: null });
    return this.agentRequest(id);
  }
  failAgent(id, message) {
    const job = this.get(id);
    if (!agentStatuses.has(job.status)) throw new Error("任务已结束，不能修改 Agent 状态");
    return this.save({ ...job, status: "failed", error: String(message || "Agent 生图未完成").slice(0, 1000) });
  }
  launch(id, operation, slices) {
    if (this.running.has(id)) throw new Error("任务正在运行");
    if (this.running.size >= 2) throw new Error("已有两个 UI 任务运行，请稍后重试");
    const controller = new AbortController();
    const token = { controller, worker: null };
    this.running.set(id, token);
    this.save({ ...this.get(id), status: operation === "generate" ? "generating" : "processing", error: null });
    token.promise = (async () => {
      let job = this.get(id);
      if (operation === "generate") {
        const refs = job.references.map(file => fs.readFileSync(path.join(this.directory(id), file)));
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60 * 1000)]);
        const image = await generateAtlas(job, this.config(true), refs, signal);
        const source = await this.normalizeImage(image);
        if (controller.signal.aborted) return;
        fs.writeFileSync(path.join(this.directory(id), "source.png"), source);
        job = this.save({ ...job, sourceFile: "source.png", status: "processing" });
      }
      const revision = randomUUID();
      const result = await new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./worker.mjs", import.meta.url), { workerData: {
          directory: this.directory(id), source: job.sourceFile, options: job.options, revision, slices,
          componentCache: path.join(this.root, "component-images"),
        } });
        token.worker = worker;
        worker.once("message", message => message.error ? reject(new Error(message.error)) : resolve(message.result));
        worker.once("error", reject);
        worker.once("exit", code => { if (code !== 0) reject(new Error("切图进程已停止")); });
      });
      if (job.workflow === "mockup") result.slices = result.slices.map(s => ({ ...s, name: "完整效果图", layerType: "component", semanticSource: "manual" }));
      if (!controller.signal.aborted) this.save({ ...job, ...result, status: "ready", error: null });
    })().catch(error => {
      if (!controller.signal.aborted) this.save({ ...this.get(id), status: "failed", error: error.message === "fetch failed" ? "无法连接生图服务，请检查地址和网络。" : error.message });
    }).finally(() => this.running.delete(id));
  }
  cancel(id) {
    const token = this.running.get(id);
    token?.controller.abort(); token?.worker?.terminate();
    const job = this.get(id);
    if (agentStatuses.has(job.status) || activeStatuses.has(job.status) || ["queued", "review_masks", "review_repairs"].includes(job.status)) this.save({ ...job, status: "cancelled" });
    return this.get(id);
  }
  reprocess(id, input) {
    if (this.running.has(id)) throw new Error("请等待当前任务完成");
    const job = this.get(id);
    if (job.operation === "decompose") throw new Error("独立图层不能重新按连通区域切图，请选择节点继续 AI 细分");
    if (["plan", "classify"].includes(job.operation)) throw new Error("分析任务不能重新切图");
    if (job.workflow === "mockup") throw new Error("效果图保留完整构图，请使用分析拆解，不进行自动切图");
    if (!job.sourceFile) throw new Error("还没有可处理的原图");
    const options = normalizeOptions(input.options || job.options);
    const slices = input.slices ? validateSlices(input.slices, job.width, job.height) : undefined;
    this.save({ ...job, options }); this.launch(id, "process", slices); return this.get(id);
  }
  async completeAgent(id, buffer) {
    const job = this.get(id);
    if (job.operation === "decompose") throw new Error("该任务须用 complete-layers 返回独立图层，不能提交整张图集");
    if (job.operation === "classify") throw new Error("分类任务须返回组件属性，不能提交图片");
    if (job.operation === "plan") throw new Error("拆解方案须通过 complete-plan 返回组件范围，不能提交图片");
    if (!agentStatuses.has(job.status)) throw new Error("该任务当前不等待 Agent 结果，不能重复回填");
    const png = await this.normalizeImage(buffer);
    if (!agentStatuses.has(this.get(id).status)) throw new Error("任务状态已改变");
    if (this.running.size >= 2) throw new Error("已有两个 UI 任务运行，请稍后重试回填");
    fs.writeFileSync(path.join(this.directory(id), "source.png"), png);
    this.save({ ...job, sourceFile: "source.png" }); this.launch(id, "process"); return this.get(id);
  }
  agentRequest(id) {
    const request=this.buildAgentRequest(id),job=this.get(id);
    if(!job.reviewBeforePublish || job.operation!=="decompose") return request;
    return {...request,generationPrompt:request.generationPrompt+"\n\n"+candidateInstructions+"\n"+JSON.stringify({attempt:job.attempt || 0,retryRegionIds:job.retryRegionIds,completeLayerPlan:job.approvedRegions,layerNotes:job.candidateReview?.notes})+"\nSeparate all foreground layers in completeLayerPlan from their bases, including retained layers outside this retry. Include optional warnings:[string] for visual concerns. Include the supplied attempt number at the top level of your result manifest.",instructions:candidateInstructions};
  }
  buildAgentRequest(id) {
    const stored = this.get(id);
    const job=stored.retryRegionIds ? {...stored,approvedRegions:stored.approvedRegions.filter(r=>stored.retryRegionIds.includes(r.id)),
      ...(stored.hybridDraft ? {hybridDraft:{...stored.hybridDraft,layers:stored.hybridDraft.layers.filter(l=>stored.retryRegionIds.includes(l.regionId))}} : {})} : stored;
    if (job.method === "hybrid" && job.stage !== "repair") return { ...job, instructions: "Local segmentation or edge correction is in progress. Wait for processing or correct masks on the canvas; do not generate images." };
    if (job.method === "hybrid") return { ...job, ...hybridRepairPrompt(job, this.directory(id)),
      ...(job.maskPurpose === "reference" ? {reusableComponents:this.reusableComponents(job).filter(c=>job.hybridDraft.layers.some(l=>(c.layerType === "component" || c.layerType === l.layerType) && (l.layerType !== "text" || (c.text || "") === (l.text || "")) && Math.abs((c.w/c.h)/(l.w/l.h)-1)<=.02))} : {}),
      instructions: preservesSource(job) && job.maskPurpose === "reference"
        ? `Source fidelity mode: check for exact reusable matches first. For other layers return sourcePixels:{alphaPath,repairMaskPath?,repairImagePath?}. Correct element ownership against the source; repair only occlusions and removed-text regions, without regenerating whole layers. Run node scripts/ui-studio.mjs complete-repairs ${id} <absolute-JSON-path>. The success status is ${job.autoContinue ? "ready (automatic completion)" : "review_repairs"}.`
        : job.maskPurpose === "reference" && job.splitOptions?.generationMode === "sheet"
        ? `Follow generationPrompt to generate missing components together in sheets, prioritizing reuse. Return sheets:[{imagePath,background?}] and repairs:[{regionId,sheetIndex,sheetRect:{x,y,w,h}}]; use reuse for reused layers. Run node scripts/ui-studio.mjs complete-repairs ${id} <absolute-JSON-path>.`
        : job.maskPurpose === "reference"
        ? `Inspect reusableComponents and open potential matching images first. When patterns, text, colors, state and sharpness meet requirements, use reuse:{jobId,revision,sliceId} without generating images. For missing or mismatched elements only, pass the source and mask references together to the image generation tool to produce complete high-resolution layers. Save {repairs:[{regionId,reuse?,imagePath?,background?,allowOpaque?,generatedRect?}]}, choosing reuse or a new image for each layer. Run node scripts/ui-studio.mjs complete-repairs ${id} <absolute-JSON-path>. The success status is ${job.autoContinue ? "ready (automatic completion)" : "review_repairs (awaiting review)"}.`
        : `Repair only occluded regions in repairRequests. Save {repairs:[{regionId,imagePath}]} and run node scripts/ui-studio.mjs complete-repairs ${id} <absolute-JSON-path>. Do not use complete-layers or redraw independent layers.` };
    if (job.operation === "plan") return { ...job, generationPrompt: buildPlanPrompt(job),
      referencePaths: job.references.map(file => this.asset(id, file)),
      instructions: `Analyze the reference images only and return a regions manifest; do not generate images. Run node scripts/ui-studio.mjs complete-plan ${id} <absolute-JSON-path>. Report failures using fail.` };
    if (job.operation === "classify") {
      const parent = this.get(job.parent.jobId);
      return { ...job, generationPrompt: classificationPrompt(job, parent),
        referencePaths: job.references.map(file => path.join(this.directory(id), file)),
        slicePaths: parent.slices.filter(s => !job.parent.sliceId || s.id === job.parent.sliceId).map(s => ({ id: s.id, path: this.asset(parent.id, s.file) })),
        instructions: `Inspect reference images and run node scripts/ui-studio.mjs complete-classification ${id} <absolute-JSON-path> to return component types. Do not generate images. Report failures using fail.` };
    }
    return { ...job, generationPrompt: job.operation === "decompose" ? buildLayerPrompt(job) : buildAtlasPrompt(job), referencePaths: job.references.map(file => path.join(this.directory(id), file)),
      ...(job.operation === "decompose" ? { reusableComponents: this.reusableComponents(job) } : {}),
      instructions: job.operation === "decompose"
        ? preservesSource(job)
          ? `Inspect referencePaths and reusableComponents first. Reference exact matching layers using reuse:{jobId,revision,sliceId}. For other layers follow generationPrompt and return sourcePixels:{alphaPath,repairMaskPath?,repairImagePath?}, preserving visible source pixels and repairing only occlusions and removed-text regions. Run node scripts/ui-studio.mjs complete-layers ${id} <absolute-manifest-path>. Do not redraw whole layers; report failure reasons using fail if unable to complete.`
          : job.splitOptions?.generationMode === "sheet"
          ? `Follow generationPrompt to generate missing components together in sheets, preserve native pixels and prioritize existing assets for reuse. Return sheets and layers, with each layer referencing sheetIndex/sheetRect or reuse. Run node scripts/ui-studio.mjs complete-layers ${id} <absolute-JSON-path>.`
          : `Inspect referencePaths and potential matching images in reusableComponents first. Reference matching layers using reuse:{jobId,revision,sliceId} and generate PNGs only for missing layers. Save the manifest as JSON and run node scripts/ui-studio.mjs complete-layers ${id} <absolute-manifest-path>. Do not submit an atlas; report failure reasons using fail if further decomposition is impossible.`
        : `This is independent UI asset mode. Follow generationPrompt to generate ${job.workflow === "mockup" ? "a complete interface mockup, preserving the background and layout" : "an atlas"}, then return it using complete_drawpaint_ui_job(jobId="${id}", imagePath=absolute-final-image-path). Do not use ordinary insert_drawpaint_image or clear ordinary pending requests.` };
  }
  reusableComponents(job) {
    const seen = new Set(), components = [];
    for (const source of this.list()) {
      if (source.id === job.id || source.status !== "ready") continue;
      for (const slice of source.slices || []) {
        if (job.splitOptions?.resolutionMode === "hd" && Math.max(slice.imageWidth || slice.w, slice.imageHeight || slice.h) < minimumHdSide) continue;
        if (source.id === job.parent?.jobId && slice.id === job.parent?.sliceId) continue;
        const imagePath = this.asset(source.id, slice.file);
        if (!fs.existsSync(imagePath)) continue;
        const key = `${slice.contentHash || imagePath}/${slice.layerType}/${slice.text || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        components.push({ jobId: source.id, revision: source.revision, sliceId: slice.id,
          name: slice.name, layerType: slice.layerType, text: slice.text, w: slice.w, h: slice.h, imageWidth:slice.imageWidth || slice.w, imageHeight:slice.imageHeight || slice.h, imagePath });
      }
    }
    return components;
  }
  async reuseLayerImage(job, layer) {
    const ref = layer.reuse;
    const source = this.get(ref.jobId);
    if (source.id === job.id || source.status !== "ready" || source.revision !== ref.revision) throw new Error("复用组件版本已变化，请重新查看已有组件");
    const slice = source.slices?.find(s => s.id === ref.sliceId);
    if (!slice) throw new Error("复用组件不存在");
    if (source.id === job.parent?.jobId && slice.id === job.parent?.sliceId) throw new Error("不能用父组件整图代替独立图层");
    if (slice.layerType && slice.layerType !== "component" && slice.layerType !== layer.layerType) throw new Error("复用组件分类不匹配");
    if (slice.layerType === "text" && (slice.text || "") !== (layer.text || "")) throw new Error("复用组件文字不同，请生成对应文字");
    const ratio = (slice.w / slice.h) / (layer.w / layer.h);
    if (ratio < .98 || ratio > 1.02) throw new Error("复用组件宽高比不匹配，请保留比例或生成新图层");
    // Read immutable revision assets now; later changes cannot alter this result.
    const image = await fs.promises.readFile(this.asset(source.id, slice.file));
    await validateHdImage(job, layer, image);
    return image;
  }
  async refine(id, input) {
    const parent = this.get(id);
    if (parent.status !== "ready" || input.revision !== parent.revision) throw new Error("父组件版本已变化，请刷新后重新选择");
    const slice = input.sliceId ? parent.slices.find(s => s.id === input.sliceId) : null;
    if (input.sliceId && !slice) throw new Error("所选图层不存在");
    if ((parent.depth || 0) >= 12) throw new Error("最多支持 12 层递进拆解");
    let prompt = String(input.prompt || "Separate bases, icons, text, borders and decorations into independently reusable UI components.").trim();
    if (!prompt || prompt.length > 12000) throw new Error("细分要求须为 1–12000 字");
    let approvedRegions, splitOptions = input.splitOptions ? normalizeSplitOptions(input.splitOptions) : undefined;
    if (input.planId) {
      const plan = this.get(input.planId);
      if (plan.operation !== "plan" || plan.status !== "ready" || plan.parent.jobId !== id || plan.parent.revision !== parent.revision || (plan.parent.sliceId || null) !== (input.sliceId || null)) throw new Error("拆解方案的来源已变化，请重新分析");
      approvedRegions = validatePlan(input.regions || plan.regions, slice?.w || parent.width, slice?.h || parent.height);
      splitOptions = splitOptions || plan.splitOptions;
      if (!input.prompt) prompt = plan.prompt;
    }
    const key = `${id}/${parent.revision}/${slice?.id || "root"}`;
    if (this.refining.has(key) || this.list().some(j => j.parent?.key === key && (agentStatuses.has(j.status) || activeStatuses.has(j.status) || ["review_masks", "review_repairs"].includes(j.status)))) throw new Error("该节点已有细分任务，请等待完成或取消后重试");
    this.refining.add(key);
    try {
      if (input.dispatch !== false && !(await this.agentConnection.status()).connected) throw new Error("Agent 尚未连接画布，请让当前 Agent 启动本机连接。");
      if (this.get(id).revision !== parent.revision || this.get(id).status !== "ready") throw new Error("父组件版本已变化，请重新选择");
      const jobId = randomUUID();
      fs.mkdirSync(this.directory(jobId), { recursive: true });
      fs.copyFileSync(this.asset(id, slice?.file || parent.atlasFile), path.join(this.directory(jobId), "reference-1.png"));
      const referencePath = path.join(this.directory(jobId), "reference-1.png");
      const imageSize = await sharp(referencePath).metadata();
      const layoutWidth = slice?.w || parent.width, layoutHeight = slice?.h || parent.height;
      let sourceMasterFile;
      if (imageSize.width !== layoutWidth || imageSize.height !== layoutHeight) {
        sourceMasterFile = "reference-master.png";
        fs.copyFileSync(referencePath,path.join(this.directory(jobId),sourceMasterFile));
        const layoutImage = await sharp(referencePath).resize(layoutWidth,layoutHeight,{fit:"fill"}).png().toBuffer();
        fs.writeFileSync(referencePath,layoutImage);
      }
      if (this.get(id).revision !== parent.revision || this.get(id).status !== "ready") throw new Error("父组件版本已变化，请重新选择");
      const job = { id: jobId, kind: "generate", operation: "decompose", provider: "agent", prompt, ...(splitOptions ? {splitOptions} : {}),
        reviewBeforePublish:input.reviewBeforePublish === true,
        ...(input.autoContinue ? { autoContinue: true, autoDispatch: input.autoDispatch ?? input.dispatch !== false } : {}),
        workflow: parent.workflow || "atlas", ...(approvedRegions ? { approvedRegions, planId: input.planId } : {}),
        width: slice?.w || parent.width, height: slice?.h || parent.height, size: parent.size, quality: "high",
        depth: (parent.depth || 0) + 1, options: parent.options, references: ["reference-1.png",...(sourceMasterFile?[sourceMasterFile]:[])], sourceFile: "reference-1.png", ...(sourceMasterFile?{sourceMasterFile}:{}),
        parent: { key, jobId: id, revision: parent.revision, sliceId: slice?.id || null, name: slice?.name || parent.prompt,
          rect: { x: slice?.x || 0, y: slice?.y || 0, w: slice?.w || parent.width, h: slice?.h || parent.height } },
        status: "awaiting_agent", createdAt: now() };
      this.save(job);
      return input.dispatch === false ? job : await this.dispatchAgent(jobId);
    } finally { this.refining.delete(key); }
  }
  metadata(id, input) { return updateSemantics(this, id, input); }
  async plan(id, input) {
    if (input.hybrid && !(await visionHealth()).ready) throw new Error("本地 OCR / SAM 尚未就绪，请先安装视觉环境");
    const job = await this.refine(id, { ...input, planId: undefined, dispatch: false, autoDispatch: input.dispatch !== false,
      prompt: input.prompt || "Analyze the complete interface and separate its background, title, menu components and decorations, preserving the layout and complete text." });
    this.save({ ...job, operation: "plan", hybrid: Boolean(input.hybrid) });
    if (input.hybrid) return preparePlanOcr(this, this.get(job.id), input.dispatch !== false);
    return input.dispatch === false ? this.get(job.id) : this.dispatchAgent(job.id);
  }
  completePlan(id, input) {
    const job = this.get(id);
    if (job.operation !== "plan" || !agentStatuses.has(job.status)) throw new Error("任务当前不等待拆解方案");
    const parent = this.get(job.parent.jobId);
    if (parent.status !== "ready" || parent.revision !== job.parent.revision) throw new Error("效果图版本已变化，请重新分析");
    const regions = validatePlan(input.regions, job.width, job.height);
    const result = this.save({ ...job, regions, status: "ready", error: null });
    if (job.autoContinue) queueMicrotask(() => this.continueSplit(id).catch(() => {}));
    return result;
  }
  continueSplit(id, input = {}) {
    if (this.splitContinuations.has(id)) return this.splitContinuations.get(id);
    const operation = (async () => {
      const plan = this.get(id);
      if (plan.operation !== "plan" || plan.status !== "ready") throw new Error("方案尚未完成，暂不能继续拆分");
      const dispatch = input.dispatch ?? plan.autoDispatch ?? true;
      // A saved child is the receipt, including after a lost response or restart.
      const existing = this.list().find(j => j.operation === "decompose" && j.planId === id);
      if (existing) {
        this.save({ ...this.get(id), continuationId: existing.id, continuationError: null });
        if (!["ready", "failed", "cancelled"].includes(existing.status)) this.save({ ...existing, autoContinue: true, autoDispatch: dispatch });
        if (["review_masks", "review_repairs", "awaiting_agent"].includes(existing.status)) {
          if (existing.status === "review_masks") return await this.approveMasks(existing.id, { version: existing.hybridDraft.version, dispatch });
          if (existing.status === "review_repairs") return existing.reviewBeforePublish ? existing : this.approveRepairs(existing.id, { revision: existing.repairPreview.revision });
          if (dispatch) return await this.dispatchAgent(existing.id);
        }
        return this.get(existing.id);
      }
      this.save({ ...plan, autoContinue: true, autoDispatch: dispatch, continuationError: null });
      const request = { revision: plan.parent.revision, sliceId: plan.parent.sliceId,
        planId: id, regions: plan.regions, splitOptions: plan.splitOptions,
        autoContinue: true, reviewBeforePublish:plan.reviewBeforePublish, autoDispatch: dispatch, dispatch };
      const child = plan.hybrid ? await this.hybrid(plan.parent.jobId, request) : await this.refine(plan.parent.jobId, request);
      this.save({ ...this.get(id), continuationId: child.id, continuationError: null });
      return child;
    })().catch(error => {
      const job = this.get(id);
      this.save({ ...job, continuationError: error.message });
      throw error;
    }).finally(() => this.splitContinuations.delete(id));
    this.splitContinuations.set(id, operation);
    return operation;
  }
  exportPreset(id, input) { return exportPreset(this, id, input); }
  async classify(id, input) {
    const parent = this.get(id);
    const job = await this.refine(id, { ...input, dispatch: false, prompt: "Identify component names, types and text information, and organize them into an exportable UI preset." });
    this.save({ ...job, operation: "classify", parentMetadataRevision: parent.metadataRevision || 0 });
    return input.dispatch === false ? this.get(job.id) : this.dispatchAgent(job.id);
  }
  completeClassification(id, input) {
    const job = this.get(id);
    if (job.operation !== "classify" || !agentStatuses.has(job.status)) throw new Error("该任务不等待分类结果");
    try {
      const parent = this.get(job.parent.jobId);
      const expected = parent.slices.filter(s => !job.parent.sliceId || s.id === job.parent.sliceId).map(s => s.id);
      if (!Array.isArray(input.slices) || input.slices.length !== expected.length || input.slices.some(s => !expected.includes(s.id))) throw new Error("请为所选范围的每个切片返回分类");
      const result = this.metadata(parent.id, { ...input, presetName: job.parent.sliceId ? undefined : input.presetName,
        revision: job.parent.revision, metadataRevision: job.parentMetadataRevision, source: "ai" });
      return this.save({ ...job, status: "ready", classifiedJobId: result.id, error: null });
    } catch (error) { this.save({ ...job, status: "failed", error: error.message }); throw error; }
  }
  async completeLayers(id, input) {
    const job = this.get(id);
    if (job.method === "hybrid") throw new Error("Mask 引导任务请通过 complete-repairs 提交图层结果，并在画布检查预览");
    if (job.operation !== "decompose" || !agentStatuses.has(job.status)) throw new Error("该任务当前不等待 AI 分层结果");
    if (this.running.has(id) || this.running.size >= 2) throw new Error("任务正在处理，请稍后重试");
    validateCandidateAttempt(job,input);
    const token = { controller: new AbortController(), worker: null };
    this.running.set(id, token);
    token.promise = (async () => {
      retainSubmission(this,job,input);
      if(input.sheets !== undefined || input.layers?.some?.(e=>e.sheetIndex !== undefined || e.sheetRect !== undefined)) input = {...input,layers:await expandSheets(this,job,input.layers,input.sheets)};
      input={...input,layers:mergeCandidateInputs(this,job,input.layers)};
      const layers = validateLayers(input.layers, job.width, job.height);
      if (job.approvedRegions) {
        const ids = new Set();
        if (input.layers.length !== job.approvedRegions.length) throw new Error("图层数量与已确认拆解方案不一致");
        input.layers.forEach((layer, index) => {
          const region = job.approvedRegions.find(r => r.id === layer.regionId);
          if (!region || ids.has(region.id) || ["x", "y", "w", "h", "zIndex", "layerType", "name"].some(k => layer[k] !== region[k]) || region.layerType === "text" && (layer.text || "") !== (region.text || "")) throw new Error("图层与已确认方案不一致，请保留 regionId、名称、文字、坐标与层序");
          ids.add(region.id); layers[index].regionId = region.id; layers[index].group = region.group;
        });
      }
      // Sequential decoding bounds memory; all inputs must succeed before state changes.
      const images = [];
      for (const [i, layer] of layers.entries()) {
        if (token.controller.signal.aborted) throw new Error("任务已取消");
        const entry=input.layers[i];
        layer.regionId=entry.regionId || layer.id;
        if(job.reviewBeforePublish && Array.isArray(entry.warnings)) layer.warnings=entry.warnings.filter(w=>typeof w==="string").slice(0,10).map(w=>w.slice(0,1000));
        if(entry._candidateKeep) {
          const retained=job.repairPreview.slices.find(s=>s.regionId===entry.regionId);
          Object.assign(layer,retained,{id:layer.id,candidateRetained:true});
          images.push(await this.upload(entry.dataUrl));continue;
        }
        if(entry.sheetCrop) layer.sheetCrop=entry.sheetCrop;
        if(entry.sourcePixels || preservesSource(job) && !layer.reuse) {
          const {image,preservation}=await sourcePixelLayer(this,job,layer,entry);
          layer.extraction="source-preserved"; layer.preservation=preservation; images.push(image);
        } else images.push(layer.reuse ? await this.reuseLayerImage(job, layer) : await this.upload(entry.dataUrl));
      }
      if (token.controller.signal.aborted || !agentStatuses.has(this.get(id).status)) throw new Error("任务状态已改变");
      this.save({ ...job, status: "processing", error: null });
      const result = await writeLayers(this.directory(id), job, layers, images, randomUUID(), path.join(this.root, "component-images"));
      if (!token.controller.signal.aborted) this.save(job.reviewBeforePublish
        ? {...job,repairPreview:result,status:"review_repairs",stage:"review_repairs",retryRegionIds:null,candidateReview:null,error:null}
        : { ...job, ...result, sourceFile: "reference-1.png", status: "ready", error: null });
    })();
    try { await token.promise; } catch (error) {
      const current = this.get(id);
      if (!token.controller.signal.aborted && (current.status === "processing" || agentStatuses.has(current.status))) this.save({ ...current, status: "failed", error: error.message });
      throw error;
    } finally { this.running.delete(id); }
    return this.get(id);
  }
  asset(id, file) {
    const base = this.directory(id);
    const target = path.resolve(base, file);
    if (!target.startsWith(base + path.sep) || !/\.(png|zip|json|psd)$/.test(file) || file.endsWith("job.json") || file.includes("..")) throw new Error("Invalid asset path");
    return target;
  }
  hybrid(id, input) { return createHybrid(this, id, input); }
  editMasks(id, input) { return editHybridMasks(this, id, input); }
  approveMasks(id, input) { return approveHybridMasks(this, id, input); }
  completeRepairs(id, input) { return completeHybridRepairs(this, id, input); }
  approveRepairs(id, input) { return approveHybridRepairs(this, id, input); }
  async uploadCanvasAsset(dataUrl) {
    const png = await this.upload(dataUrl);
    const name = `${randomUUID()}.png`;
    fs.mkdirSync(path.join(this.root, "uploads"), { recursive: true });
    fs.writeFileSync(path.join(this.root, "uploads", name), png);
    return { src: `/api/ui-studio/uploads/${name}` };
  }
  snapshot(value) {
    return value === undefined ? readSnapshot(this.root) : saveSnapshot(this.root, value);
  }
}
