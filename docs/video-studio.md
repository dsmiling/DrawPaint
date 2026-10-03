# 视频工坊

视频工坊把本机图生视频、片段管理、逐帧检查和时间线剪辑放在同一页。运行 `npm run dev` 后，打开 <http://127.0.0.1:43217/?mode=video>。绘画画布中的“选中图片生视频”可以把选中的图片带到视频工坊。

## 运行环境

- DrawPaint 前端与 API，默认端口分别为 `43217` 和 `43218`。
- 本机 ComfyUI，地址为 `http://127.0.0.1:8188`。将 `ComfyUI/` 放在 DrawPaint 项目或数据目录的同级目录，以便检查权重和读取输出素材。
- FFmpeg 和 FFprobe，需要能从服务进程的 PATH 调用；视频导入、逐帧取图和 MP4 导出依赖它们。
- Windows 下，如果同级目录存在 `start_comfy.ps1`，模型设置页可调用它启动 ComfyUI；其他情况请自行启动 ComfyUI。页面不会下载模型或安装节点。

生成视频使用本机 ComfyUI；普通视频操作无需 Codex 连接器或图片 API Key。画布原有的 Codex 生图功能仍按 README 启动连接器。

## 模型准备

“模型设置”会检查连接、模型权重和 ComfyUI 节点。文件位置均相对于 `ComfyUI/models/`。

MiniMax H3 支持起始图、可选尾帧，以及 2、3、5 秒视频，需要：

- `diffusion_models/minimax_h3_fl2va_pruned_fp8_scaled.safetensors`
- `text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`
- `vae/minimax_h3_video_vae_fp16.safetensors`
- `vae/minimax_h3_audio_vae_fp32.safetensors`
- `loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors`

Wan 2.2 5B 当前工作流支持单张起始图和 2 秒视频，需要：

- `diffusion_models/wan2.2_ti2v_5B_fp16.safetensors`
- `text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors`
- `vae/wan2.2_vae.safetensors`

具体节点需求在 `server/video-models.mjs` 中定义；MiniMax H3 工作流还使用 `server/video-template.json` 中的节点。模型状态检查通过后，如生成时报缺少节点，需按对应工作流补齐本机 ComfyUI 环境。

## 生成、检查与剪辑

1. 点击“生成片段”，选择 PNG、JPEG 或 WebP 起始图，填写动作描述并选择模型、时长。MiniMax H3 可同时使用尾帧图，并根据起始图选择最接近的受支持宽高比。
2. 生成完成后，片段会加入节点画布和时间线。“历史生成”中的视频也可加入当前项目；导入支持 MP4、WebM、MOV，每个文件不超过 90 MB。
3. 节点卡片可以拖动，空白区域可平移，画布可缩放。左侧图层、节点和时间线保持选中状态同步。
4. 拖动时间线片段改变起点和轨道，拖动两端裁切。右键可复制、按播放头分割、重命名、导出当前裁切片段或删除。
5. 右侧“简略 / 完整”检查面板可逐帧选择首尾帧，再用两帧生成新片段。原片段会保留，方便比较。
6. 选择导出画布尺寸后，点击“导出视频”。输出按 24 fps 编码，保留并混合原片音频；不同宽高比的素材以黑边保持完整画面。

生成图片和视频仍需人工检查身份、服装、手部、动作及过渡。提交生成任务成功不代表画面已经通过验收。

## 可选动作描述润色

首尾帧检查面板支持“优化润色”“细化动作”和“镜头表达”。服务通过 Cursor SDK 读取账号可用模型，并结合两张图片返回建议；点击“采用建议”才会替换描述。

使用前在启动服务的终端设置 `CURSOR_API_KEY`。密钥仅放在环境变量或本机私有配置中，不写入仓库。未配置密钥时，本机生成、剪辑和导出仍可使用。

## 保存与导出

项目自动保存到 `canvas/video-project.json`。导入素材、生成视频副本和导出结果分别保存在 `canvas/video-assets/`、`canvas/video-generated/`、`canvas/video-exports/`；任务和导出记录保存在相应 JSON 文件中。

生成完成的视频会复制到项目目录，因此 ComfyUI 重启或任务历史清空后，已保存的视频仍可预览、取帧和导出。运行数据已被 Git 忽略，迁移机器时需要单独备份。

导出完成后可下载 MP4。浏览器支持文件保存窗口时，也可点击“选择保存位置…”指定路径；否则使用浏览器默认下载位置。

## 验证

```bash
npm run test:video
npm run test:ui
npm run build
```

视频测试覆盖时间线和裁切参数、音频导出参数、模型工作流接线与宽高比，以及生成素材在 ComfyUI 历史消失后的持久化读取。测试不执行耗时的模型推理，也不替代实际画面验收。
