---
name: drawpaint-image-gen
description: >-
  Generate a final AI bitmap for the DrawPaint canvas. Use when the user asks
  to create/fill/replace an AI image on DrawPaint, or when a pending request
  type is ai_image_generate. If an AI 图片 holder is selected (or
  anchorShapeId points to one), use it as the size target and replace it with
  the generated image by default.
---

# DrawPaint Image Gen

Cowart-parity skill for DrawPaint. Holders are tldraw `frame` shapes with:

```json
{ "meta": { "drawpaintAiImageHolder": true } }
```

(`cowartAiImageHolder: true` is also accepted.)

## Workflow

1. Call `get_drawpaint_pending_request` and/or `get_drawpaint_selection`.
2. If there is an AI holder (`isAiImageHolder` / meta / pending `anchorShapeId`):
   - Use `targetWidth`, `targetHeight`, `targetAspectRatio` from the request or holder `props.w/h`.
   - Put those into the image generation prompt (compose for the slot; no stretch/crop).
   - Generate a bitmap with available image tools.
   - Call `insert_drawpaint_image` with:
     - `imagePath`: absolute path to the new file
     - `anchorShapeId`: the holder id
     - `replaceAiImageHolder`: true (default)
3. If no holder: generate anyway and insert standalone (`replaceAiImageHolder: false`); place beside selection or clear area.
4. Call `clear_drawpaint_pending_request`.
5. Keep the DrawPaint canvas tab open so it can reload the snapshot (~1.5s poll).

## Guardrails

- Never overwrite existing asset filenames; use timestamped names.
- Do not refuse solely because no holder is selected.
- Prefer MCP insert over hand-editing tldraw JSON.
