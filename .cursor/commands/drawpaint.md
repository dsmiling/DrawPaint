# 处理 DrawPaint 待办

读取并处理当前项目的 DrawPaint 待办请求：

1. 调用 MCP `get_drawpaint_pending_request`（或读取 `canvas/pending-request.json`）
2. 按请求类型生成/修改图片（`annotate_edit` 时先看标注截图）
3. 用 `insert_drawpaint_image` 把结果插回画布（局部修改时 `replaceSelected: true`）
4. 调用 `clear_drawpaint_pending_request`
