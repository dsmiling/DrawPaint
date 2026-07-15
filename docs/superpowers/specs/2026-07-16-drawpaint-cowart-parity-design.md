# DrawPaint ↔ Cowart Parity Design

**Date:** 2026-07-16  
**Status:** Approved  
**Delivery order:** Phase A → B → C (Slides optional as Phase D)

## Goal

Bring DrawPaint to Cowart’s product logic for infinite-canvas AI workflows in Cursor: AI image holders, annotation-driven edits, and AI HTML drafts. Keep the existing Cursor deeplink bridge (prefill chat; user presses Enter) instead of Codex native widgets.

## Non-goals / intentional differences

- No Codex MCP Apps / `ext-apps` Host Bridge / `sendFollowUpMessage` auto-send.
- Deeplinks never auto-execute; user confirms with Enter (Cursor platform limit).
- Phase D (AI Slides) is out of the first three delivery slices unless pulled in later.

## Architecture

```
Browser (tldraw UI, ported Cowart holder UX)
    ↔ HTTP API (:43218) + canvas/ project files
    ↔ pending-request.json + deeplink → Cursor Agent
    ↔ DrawPaint MCP (insert/replace/place, selection, assets)
```

**Holder model (Cowart-identical semantics):** tldraw `frame` shapes + meta flags (not custom ShapeUtils).

| Kind | Meta | Default size |
|------|------|--------------|
| AI 图片 | `drawpaintAiImageHolder: true` (+ read compat `cowartAiImageHolder`) | aspect presets |
| AI HTML | `drawpaintAiDraftHolder: true` (+ compat `cowartAiDraftHolder`) | 1024×576 |
| AI Slides (D) | `drawpaintAiSlides: true` | 1048×600 outer |

## Phase A — AI image holder

### UI

1. Toolbar tool **AI 图片** creates a centered frame with holder meta and name `AI 图片`.
2. Aspect presets: 1:1, 3:2, 2:3, 4:3, 3:4, 16:9, 9:16 (Cowart list).
3. When selected: generation panel with prompt, up to 10 reference images (canvas pick or upload), send button.
4. Send: save refs to `canvas/pages/<page>/assets/`, write `pending-request.json` with type `ai_image_generate`, `anchorShapeId`, `targetWidth`, `targetHeight`, `targetAspectRatio`, prompt, reference paths; open Cursor prompt deeplink.

### Agent / MCP

Mirror `cowart-image-gen`:

- If selection is an AI holder → generate for slot size → `insert_drawpaint_image` with `anchorShapeId` and `replaceAiImageHolder: true` (default).
- Replacement: same parent/x/y/rotation/w/h as holder; delete holder (+ descendants); normal `image` shape; meta `drawpaintGeneratedForAiImageHolder`, `drawpaintReplacedAiImageHolder`.
- No holder → standalone insert on page (beside selection or clear area); meta `drawpaintGeneratedStandalone`.
- Never overwrite asset files; timestamped names.

### Skills

Port `cowart-image-gen` → `.cursor/skills/drawpaint-image-gen/SKILL.md` adapted for DrawPaint MCP names and Cursor image tools.

## Phase B — Annotation edit

Mirror `cowart-image-edit`:

1. User annotates with draw/arrow/text; clicks **按标注修改**.
2. Export selection (image + annotations) to assets; pending type `annotate_edit` + screenshot path.
3. Agent treats screenshot as authoritative brief; output clean bitmap (no arrows/labels/chrome).
4. `insert_drawpaint_image` with `placement: "right"`, `margin: 40`, `matchAnchor: true`, `replaceAiImageHolder: false`.
5. Never replace/move/delete originals or annotations; place to the right of anchor (image or AI frame bounds); if overlap, shift further right by `anchorWidth + 40`.

### Skills

Port `cowart-image-edit` → `drawpaint-image-edit`.

## Phase C — AI HTML draft

1. Toolbar **AI HTML** → frame 1024×576, meta draft holder, name `AI HTML`.
2. Generation panel → pending type `ai_html_generate` → deeplink.
3. MCP `insert_drawpaint_html_draft`: write HTML under page assets, embed in holder (iframe), optional update-in-place.
4. Agent produces single-file runnable HTML; follow Cowart draft prompt contracts (16:9 canvas).

## Shared MCP surface (target)

| Tool | Role |
|------|------|
| `open_drawpaint_canvas` | URL + health |
| `get_drawpaint_selection` | selection + `isAiImageHolder` flags |
| `get_drawpaint_pending_request` / `clear_…` | request queue |
| `insert_drawpaint_image` | Cowart-parity insert/replace/place |
| `insert_drawpaint_html_draft` | Phase C |
| `save_drawpaint_reference_image` | optional explicit ref save |
| `get_drawpaint_snapshot_info` | paths |

`insert_drawpaint_image` args (parity): `imagePath`, `anchorShapeId`, `placement`, `margin`, `matchAnchor`, `replaceAiImageHolder`, `displayWidth/Height`, `altText`, `annotationScreenshot`, `shapeMeta`, `fileName`.

**Important:** Prefer mutating the on-disk tldraw snapshot (like Cowart MCP) so inserts work even if the browser tab is mid-poll; keep pending-inserts queue as a live-refresh path when the canvas is open.

## Storage

```
canvas/
  selection.json
  pending-request.json
  pending-inserts.json
  pages/default/
    snapshot.json          # tldraw document (+ session)
    assets/                # images + html drafts
```

Page-local asset URLs served as `/api/assets/<file>` (Cowart uses `/page-assets/...`; Map in MCP docs).

## Testing checklist

- A: create holder → send → agent insert replaces holder at same bounds.
- A: no holder → standalone insert.
- B: annotate → edit → new image to the right; original + marks remain.
- C: AI HTML → HTML embeds and persists across reload.
- Deeplink still opens Cursor with prefilled process instructions.

## Implementation notes

- Prefer extracting Cowart holder helpers from `App.jsx` patterns rather than inventing new UX.
- tldraw v3 `frame` shapes; register custom toolbar buttons via `Tldraw` overrides / `onMount` tools.
- Keep React without StrictMode (already required for tldraw dispose).
