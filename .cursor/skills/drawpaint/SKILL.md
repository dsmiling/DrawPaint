---
name: drawpaint
description: >-
  Use when the user mentions DrawPaint, canvas annotation edits, pending
  DrawPaint requests, inserting generated images into the DrawPaint canvas,
  or wants to open the DrawPaint infinite canvas.
---

# DrawPaint Skill

DrawPaint is a local tldraw canvas for this project. The canvas UI runs at
`http://127.0.0.1:43217`. Agent integration is via the `drawpaint` MCP tools
and files under `canvas/`.

## Prerequisites

If the canvas is not open, tell the user to run in the project root:

```bash
npm run dev
```

Then open `http://127.0.0.1:43217` (browser or Cursor Simple Browser).

## Tools

- `open_drawpaint_canvas` — return canvas URL / health
- `get_drawpaint_pending_request` — read the request written by the canvas
- `get_drawpaint_selection` — current selection metadata (+ `isAiImageHolder`)
- `insert_drawpaint_image` — Cowart-parity insert / replace holder / place beside
- `clear_drawpaint_pending_request` — clear after handling
- `get_drawpaint_snapshot_info` — storage paths / status

## When user clicks canvas 「发送到 Cursor 对话」 / 「生成并发送到 Cursor」

The canvas writes `canvas/pending-request.json` and opens a Cursor prompt
deeplink with a prefilled message. The user still presses Enter to send
(Cursor deeplinks never auto-execute). Then follow the pending-request flow
below.

## When user says 「处理 DrawPaint 待办请求」 / deeplink prompt arrives

1. Call `get_drawpaint_pending_request`.
2. If empty, say there is no pending request.
3. If `type` is `ai_image_generate`, follow skill **drawpaint-image-gen**.
4. If `type` is `annotate_edit`, follow skill **drawpaint-image-edit**
   (screenshot is authoritative; place clean result to the right of the source image).
5. Otherwise follow the prompt text literally.
6. Always `clear_drawpaint_pending_request` when done.

## Notes

- Keep the canvas tab open so pending-inserts / snapshot reload can apply.
- Selection is mirrored to `canvas/selection.json`.
- Snapshots live at `canvas/pages/default/snapshot.json`.
- AI image holders are `frame` shapes with `meta.drawpaintAiImageHolder: true`.
- Use the dedicated **标注** tool for annotation arrows (auto label edit, tail label).
- Select an **image** then click toolbar **按标注修改** — nearby arrows/text are auto-included.