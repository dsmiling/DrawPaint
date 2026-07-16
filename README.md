# DrawPaint

DrawPaint 是一个面向 **Cursor** 的无限画布工具。它基于 [tldraw](https://github.com/tldraw/tldraw) 提供可视化画布，用于构思、标注、生成图片，以及根据标注图迭代图片。

画布以本地 Web 服务运行（浏览器或 Cursor Simple Browser），通过 **MCP + Skills** 与 Cursor Agent 联动；画布数据默认保存在当前项目的 `canvas/` 目录。

对标 [Cowart](https://github.com/zhongerxin/cowart) 的核心工作流，但不依赖 Codex 原生 Widget：交互靠 Cursor deeplink 预填对话（需你按一次 Enter 发送）。

## 功能

- 在本地打开 tldraw 无限画布：拖拽、缩放、导入图片；数据持久化到项目 `canvas/`。
- 创建 **AI 图片** 框：选择比例预设，输入 prompt、选择参考图，发送到 Cursor；Agent 按选中框的位置和尺寸生成图片并 **替换该框**。
- 标注好图片后，可从画布提交标注截图（「按标注修改」），让 Agent 根据标注生成干净的新图并放到原图旁边；原图与标注不会被删除或移动。
- 通过 deeplink / `/drawpaint` 命令把待办写入 `canvas/pending-request.json` 并预填 Cursor 对话。
- 通过 DrawPaint MCP 读取选择状态、待办请求，并把生成图插回画布（替换 holder / 放在锚点右侧等）。

> Phase A（AI 图片框 + 标注改图）已对齐 Cowart 主路径。AI HTML / AI Slides 等能力按路线图后续交付，见 `docs/superpowers/specs/`。

## 安装

仓库地址：https://github.com/dsmiling/DrawPaint

### 让 Cursor 协助安装

把下面这段发给 Cursor Agent：

```text
请从 https://github.com/dsmiling/DrawPaint.git 安装 DrawPaint。
请 clone 到我指定的工作目录（若未指定则用当前工作区旁的 DrawPaint），
进入目录后执行 npm install，确认 .cursor/mcp.json 与 .cursor/skills/ 存在，
然后告诉我如何用 npm run dev 启动画布，以及是否需要在 Cursor 中确认启用 drawpaint MCP。
```

### 手动安装

```bash
git clone https://github.com/dsmiling/DrawPaint.git
cd DrawPaint
npm install
```

确认项目内已有 Cursor 集成文件：

```text
.cursor/mcp.json                 # drawpaint MCP：node server/mcp.mjs
.cursor/skills/drawpaint/        # 总调度 skill
.cursor/skills/drawpaint-image-gen/
.cursor/skills/drawpaint-image-edit/
.cursor/commands/drawpaint.md    # /drawpaint 命令
```

用 Cursor 打开该仓库（或把本仓库作为工作区根目录）。首次打开时，按 Cursor 提示启用 / 信任项目内的 MCP 与 Skills。

### 启动画布

```bash
npm run dev
```

浏览器或 Cursor Simple Browser 打开：

```text
http://127.0.0.1:43217
```

`npm run dev` 会同时拉起画布前端与本地 API（默认 API 端口 `43218`）。

## 更新

在项目根目录：

```bash
git pull
npm install
```

然后重新执行 `npm run dev`。若 MCP / Skills 有变更，建议新开一条 Cursor 对话，确保新技能与工具被完整加载。

画布运行时数据（截图、snapshot、pending 文件等）默认被 `.gitignore` 忽略，更新代码不会覆盖你本机已生成的 `canvas/` 内容；换机器时请自行备份需要保留的画布资源。

## 使用

### 打开画布

1. 在项目根目录运行 `npm run dev`。
2. 打开 `http://127.0.0.1:43217`。
3. 在 Cursor 中也可说：「打开 DrawPaint 画布」——Agent 应提示你启动服务并给出 URL（MCP：`open_drawpaint_canvas`）。

画布数据默认路径：

```text
canvas/pages/default/snapshot.json
canvas/pages/default/assets/
canvas/selection.json
canvas/pending-request.json
canvas/pending-inserts.json
```

### 生成新图（AI 图片框）

1. 打开 DrawPaint 画布。
2. 顶部工具栏点击 **AI 图片**，创建并选中一个 AI 图片框（可选手持比例：1:1、3:2、2:3、4:3、3:4、16:9、9:16 等）。
3. 在生成面板中输入 prompt，可选一张或多张参考图（画布内选取或上传），然后发送到 Cursor。

DrawPaint 会：

1. 将参考图保存到当前页 `assets/`；
2. 写入 `canvas/pending-request.json`（类型 `ai_image_generate`，含 `anchorShapeId`、目标宽高与宽高比等）；
3. 打开 Cursor deeplink，预填提示词。

**注意：** Cursor 官方 deeplink **不会自动发送**，你需要在对话里按一次 **Enter**。这是 Cursor 安全限制，网页画布无法绕过。

Agent 处理时会按选中框的位置和比例生成图片，并用 MCP `insert_drawpaint_image`（`replaceAiImageHolder: true`）把 AI 图片框替换成普通图片形状。

也可在 Cursor 聊天输入 `/drawpaint`，触发同样的「处理待办」流程。

### 根据标注图生成新图

1. 在画布中对图片做标注（画笔 / 箭头 / 文字；推荐使用专用 **标注** 工具）。
2. 选中被标注的图片，点击 **按标注修改**（附近的箭头/文字会自动纳入）。
3. 可选填写右侧 Prompt，再发送到 Cursor / Agent。

DrawPaint 会导出包含原图、箭头和标注文字的截图，写入 pending（类型 `annotate_edit`），并预填 Cursor 对话。

Agent 会以标注截图为权威说明，生成去掉标注痕迹的干净新图，并用 `insert_drawpaint_image` 放到原图右侧（`placement: "right"`）。**原图和标注不会被删除或移动。**

你也可以在 Cursor 中直接说：「请处理 DrawPaint 待办请求」。

### 推荐完整测试路径

1. `npm run dev`，打开画布。
2. 拖一张图片进画布，用箭头/文字标注要改的地方。
3. 选中底图，填写 Prompt（可选）。
4. 点 **按标注修改 → Agent**（或等价发送按钮）。
5. 回到 Cursor 对话：确认预填内容后按 Enter，或手动说「请处理 DrawPaint 待办请求」。
6. Agent 读截图与 prompt，生成图片后通过 `insert_drawpaint_image` 插回；保持画布标签页打开，便于 pending-inserts / snapshot 刷新生效。

## 技能与 MCP

### Skills

| Skill | 作用 |
|-------|------|
| `drawpaint` | 总入口：打开画布、读 pending、按类型分流、清理待办 |
| `drawpaint-image-gen` | 按 AI 图片框尺寸生图并替换 holder；无框时也可独立插入 |
| `drawpaint-image-edit` | 根据标注截图生成修订图，放到源图右侧 |

### MCP 工具（`drawpaint`）

| 工具 | 作用 |
|------|------|
| `open_drawpaint_canvas` | 返回画布 URL / 健康状态 |
| `get_drawpaint_pending_request` | 读取画布写入的待办 |
| `get_drawpaint_selection` | 当前选择元数据（含是否 AI 图片 holder） |
| `insert_drawpaint_image` | 插入 / 替换 holder / 放到锚点旁（Cowart 对齐参数） |
| `clear_drawpaint_pending_request` | 处理完成后清理待办 |
| `get_drawpaint_snapshot_info` | 存储路径与状态 |

`insert_drawpaint_image` 常用参数：`imagePath`、`anchorShapeId`、`placement`、`margin`、`matchAnchor`、`replaceAiImageHolder`、`displayWidth` / `displayHeight`、`fileName` 等。

配置见 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "drawpaint": {
      "command": "node",
      "args": ["server/mcp.mjs"]
    }
  }
}
```

## 本地开发

```bash
npm install
npm run dev      # 画布 + API（推荐日常使用）
npm run build
npm run preview
npm run server   # 仅 HTTP API
npm run mcp      # 仅 MCP 进程（一般由 Cursor 拉起）
```

### 端口

| 服务 | 默认端口 |
|------|----------|
| 画布 Web | `43217` |
| API | `43218` |

### 环境变量

| 变量 | 含义 |
|------|------|
| `DRAWPAINT_PORT` | 画布 Web 端口 |
| `DRAWPAINT_API_PORT` | API 端口 |
| `DRAWPAINT_PROJECT_DIR` | 项目根目录（影响 `canvas/` 位置） |

### 目录结构

```text
DrawPaint/
├── src/                      # 画布前端（React + tldraw）
├── server/
│   ├── dev.mjs               # Vite + API 一键启动
│   ├── http.mjs              # REST API
│   ├── mcp.mjs               # Cursor MCP
│   ├── insert-image.mjs      # 插图 / 替换 holder
│   └── storage.mjs           # canvas 读写
├── canvas/                   # 运行时数据（默认 gitignore 大部分内容）
├── .cursor/
│   ├── mcp.json
│   ├── commands/drawpaint.md
│   └── skills/
├── scripts/                  # 维护用脚本（如 GitHub env 弹窗配置）
└── docs/superpowers/         # 设计与计划文档
```

## 限制（MVP）

- 不是 Cursor 原生 Webview 内嵌，需浏览器或 Simple Browser。
- Agent 不会因 deeplink 自动执行；需你在对话里按 Enter，或手动触发「处理待办」。
- 生图本身依赖你当前 Cursor 可用的图片模型 / 工具；本仓库负责画布、待办链路与插回。
- AI HTML、AI Slides 等 Cowart 进阶能力尚未作为默认交付（见设计文档路线图）。

## 致谢

- 画布能力基于 [tldraw/tldraw](https://github.com/tldraw/tldraw)。
- 产品工作流对标 [zhongerxin/cowart](https://github.com/zhongerxin/cowart)。
