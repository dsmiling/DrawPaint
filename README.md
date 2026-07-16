# DrawPaint

Cursor 可用的 tldraw 无限画布 MVP（方案 A：本地画布 + MCP + Skills）。

对标 [Cowart](https://github.com/zhongerxin/cowart) 的核心工作流，但不依赖 Codex Widget。

## 能力（Phase A 已对齐 Cowart）

- 无限画布：拖拽、缩放、导入图片
- **AI 图片框**：顶部「AI 图片」创建 `frame` holder（比例预设）→ 填 prompt/参考图 → 发送到 Cursor → Agent 按框尺寸生图并 **替换该框**
- 标注：画笔 / 箭头 / 文字；「按标注发送」导出截图待办
- Deeplink：预填 Cursor 对话（需按 Enter 发送）
- MCP：`insert_drawpaint_image`（`replaceAiImageHolder` / `placement` / `anchorShapeId`）

## 快速开始

```bash
cd C:\WorkPlace\Project\DrawPaint
npm install
npm run dev
```

浏览器打开：http://127.0.0.1:43217

## 与 Cursor 对话联动

画布按钮会：

1. 写入 `canvas/pending-request.json`
2. 打开 `cursor://anysphere.cursor-deeplink/prompt?text=...` 预填提示词

**注意：** Cursor 官方 deeplink **不会自动发送**，你需要在对话里按一次 Enter。
这是 Cursor 安全限制，网页画布无法绕过。

也可在 Cursor 聊天输入 `/drawpaint` 命令触发同样流程。

## 推荐测试路径

1. `npm run dev`，打开画布
2. 拖一张图片进画布，用箭头/文字标注要改的地方
3. 选中底图 + 标注，填写右侧 Prompt
4. 点 **按标注修改 → Agent**
5. 回到 Cursor 对话：`请处理 DrawPaint 待办请求`
6. Agent 读截图与 prompt 后，把生成图路径用 `insert_drawpaint_image` 插回（或你手动提供图片路径让它插入）

## 目录

```
DrawPaint/
├── src/                 # 画布前端
├── server/
│   ├── dev.mjs          # Vite + API 一键启动
│   ├── http.mjs         # REST API
│   ├── mcp.mjs          # Cursor MCP
│   └── storage.mjs
├── canvas/              # 运行时数据（自动创建）
├── .cursor/mcp.json
└── .cursor/skills/drawpaint/
```

## 端口

| 服务 | 端口 |
|------|------|
| 画布 Web | 43217 |
| API | 43218 |

可用环境变量 `DRAWPAINT_PORT` / `DRAWPAINT_API_PORT` / `DRAWPAINT_PROJECT_DIR` 覆盖。

## 限制（MVP）

- 不是 Cursor 原生 Webview 内嵌，需浏览器 / Simple Browser
- Agent 不会自动弹窗；需你在对话里触发「处理待办」
- 生图本身依赖你当前 Cursor 可用的图片模型/工具；本仓库负责画布与插回链路
