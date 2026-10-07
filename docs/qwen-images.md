# 本地 Qwen 生图

绘画画布和素材工坊的“生图模型”可以选择 **本地 Qwen-Image-2.1**。DrawPaint 通过本机 ComfyUI 提交工作流，取得 PNG 后继续使用原有回填、切图和导出流程。它不调用 Codex/Cursor SDK，也不需要图片 API Key。

绘画画布与素材工坊分别保存模型选择。修改一个模式不会修改其他模式；切换模式和刷新页面后恢复各自的选择。

## 准备

本工作区已经部署 ComfyUI 和以下模型。独立安装时，将三个文件分别放在 ComfyUI 的对应模型目录：

- `models/diffusion_models/qwen_image_2.1_int8_convrot.safetensors`
- `models/text_encoders/qwen3vl_8b_int8_convrot.safetensors`
- `models/vae/qwen_image_2.1_vae_bf16.safetensors`

ComfyUI 必须提供 `TextEncodeQwenImage21` 和 `QwenImage21Cache` 节点。“检查连接”会检查服务、节点及模型列表，并显示缺少的文件。

当前工作区启动方式：

```powershell
cd C:\workplace\Study
powershell -ExecutionPolicy Bypass -File .\start_comfy.ps1
```

另一个终端启动 DrawPaint：

```powershell
cd C:\workplace\Study\DrawPaint
npm run dev
```

默认连接 `http://127.0.0.1:8188`。如本机使用其他端口，启动 DrawPaint 前设置 `DRAWPAINT_COMFY_URL`。本接入只接受本机地址。

## 绘画画布

在顶部选择本地 Qwen，再创建 AI 图片框、填写描述、添加参考图并发送。图片框的显示尺寸与位置保留；推理尺寸沿用图片框尺寸，按比例对齐至 32 像素，并限制在约 1 MP、最长边 2048 像素以内，不主动放大小尺寸图片框（512×512 图片框按 512×512 推理）。参考图最多 10 张。

可在顶部取消最近的本地任务回填。支持的宽高比范围为 1:8 至 8:1。

“按标注修改”会提交原图、标注截图和元素参考图，要求 Qwen 返回没有标注的编辑结果，并放在原图右侧。原图、标注截图和元素参考图合计最多 10 张。模型对标注的遵循程度需要实际检查。

## 素材工坊

在“生成 UI”表单选择本地 Qwen，可生成完整效果图或素材图集，并沿用已有参考图入口。参考图最多 4 张。默认使用 1K 方图或 `1344×768` 宽屏；可以选择更大尺寸，耗时和显存需求相应增加。

质量选项对应草稿 15 步、标准 25 步、精细 40 步。当前工作流使用 CPU 文本编码器、CPU INT8 缓存、CFG 1 和 Euler 采样，适配本工作区的 16 GB 显卡部署。

生成效果图后，按现有流程显示完整图片。素材图集按设置去背景、自动切图，然后回填并支持 PNG/ZIP、PSD、Unity 导出。**语义拆解、组件分类与 AI 分层仍需要 Agent**；选择本地生图模型不会把这些分析任务交给图像模型。

## 任务与验证

ComfyUI 接受任务后，DrawPaint 持久化其任务编号。服务重启会继续等待已有任务，不会重复提交；若服务在提交确认之前退出，会显示未确认状态，须先检查 ComfyUI 队列。已完成图片和任务记录保存在各自画布的数据目录中。

取消素材工坊任务会停止本地等待并删除该排队项；已经在 ComfyUI 执行的任务可能继续运行，结果不会回填。不会全局打断其他聊天或视频生成任务。

```powershell
npm run test:qwen
node scripts/qwen-smoke.mjs
```

第一条使用测试替身验证接口、回填、重启恢复与导出。第二条执行真实带参考图生图，在独立 `output/qwen-smoke-*` 目录保存图片、Unity 包及 `report.json`，不会修改日常画布。

模型功能与部署资料：[Qwen 官方模型说明](https://huggingface.co/Qwen/Qwen-Image-2.1)、[ComfyUI 官方教程](https://docs.comfy.org/tutorials/image/qwen/qwen-image-2-1)。
