---
name: drawpaint-image-edit
description: >-
  Edit a DrawPaint canvas image from annotation screenshots. Use when the user
  asks to revise an image by annotations, or when a pending request type is
  annotate_edit. Treat the annotation screenshot as the authoritative brief;
  place a clean new bitmap to the right of the source image without removing
  the original or its marks.
---

# DrawPaint Image Edit

Cowart-parity skill for annotation-driven image revision on DrawPaint.

## When to use

- Pending request `type: annotate_edit`
- User says 按标注修改 / revise from annotations / inpaint from marks
- A DrawPaint annotation screenshot path is provided

## Workflow

1. Call `get_drawpaint_pending_request` (and optionally `get_drawpaint_selection`).
2. Open and read the annotation screenshot (`screenshotRelativePath` / prompt path).
   - Arrows point at edit locations (**WHERE**).
   - Text on arrows (and nearby text) is the edit instruction.
3. If the request / prompt lists **标注参考图 / 元素参考** (`elementRefs` / `referencePaths`):
   - These images are **WHAT** to place at the pointed locations.
   - Compose those elements into image 1 at the annotated spots; match image-1 style.
4. Generate a **clean** revised bitmap:
   - Apply the requested edits / placements.
   - Do **not** paint arrows, labels, selection chrome, or tool UI into the result.
   - Preserve subject, style, and composition except where annotations ask to change.
5. Call `insert_drawpaint_image` with:
   - `imagePath`: absolute path to the new file
   - `anchorShapeId`: the **source image** shape id from the request / prompt
   - `placement`: `"right"`
   - `margin`: `40`
   - `matchAnchor`: `true`
   - `replaceAiImageHolder`: `false`
6. Call `clear_drawpaint_pending_request`.
7. Keep the DrawPaint canvas tab open so it can reload (~1.5s poll).

## Guardrails

- Never delete, move, or replace the original image or annotation shapes.
- Never overwrite existing asset filenames; use timestamped names.
- Prefer MCP insert over hand-editing tldraw JSON.
- If no nearby annotations were detected, still revise from the screenshot/export provided.
- Element reference images are content sources, not backgrounds to paste raw with chrome.