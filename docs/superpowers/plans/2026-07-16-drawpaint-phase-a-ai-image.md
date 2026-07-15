# DrawPaint Cowart Parity — Phase A Implementation Plan

> **For agentic workers:** Implement task-by-task. Later phases B/C have separate follow-up plans after A is testable.

**Goal:** Ship Cowart-parity AI image holders (frame + meta), generation panel, deeplink pending requests, and MCP `insert_drawpaint_image` replace-holder behavior.

**Architecture:** Port Cowart holder semantics onto existing Vite+tldraw+HTTP+MCP stack; snapshot mutation + pending-inserts for live UI.

**Tech Stack:** React 19, tldraw 3.x, Node HTTP API, MCP SDK, Cursor deeplink + skills.

## Global Constraints

- Meta: `drawpaintAiImageHolder` (compat read `cowartAiImageHolder`).
- Holder = tldraw `frame`, not custom ShapeUtil.
- Replace holder by default on insert when anchor is AI holder.
- Deeplink prefill only; no auto-send.
- Do not break existing drag-upload / annotate buttons while refactoring.

---

## Task 1: Holder helpers + toolbar create

**Files:** `src/holders.js` (new), `src/App.jsx`

- [ ] Add helpers: `isAiImageHolderShape`, `createAiImageHolderAtViewportCenter`, aspect presets, meta getters (drawpaint + cowart compat).
- [ ] Add toolbar button **AI 图片** that creates holder and selects it.
- [ ] Manual test: create frame named AI 图片 with meta flag; survives save/reload.

## Task 2: Selection panel for AI holder

**Files:** `src/App.jsx`, `src/api.js`

- [ ] When selected shape is AI holder, show Cowart-like panel: prompt, aspect hint (w×h), reference multi-select/upload (max 10), send.
- [ ] On send: upload refs, write pending `type: ai_image_generate` with target size + `anchorShapeId`, open deeplink (`CHAT_BOOT_PROMPT` + details).
- [ ] Manual test: pending-request.json contains sizes and anchor id; Cursor opens.

## Task 3: MCP insert parity (snapshot + queue)

**Files:** `server/mcp.mjs`, `server/storage.mjs`, optionally `server/insert-image.mjs` (new)

- [ ] Implement Cowart-like `insert_drawpaint_image`: copy file → assets, patch snapshot (create asset+image shape, optionally delete holder), write pending-inserts for live canvas OR reload snapshot.
- [ ] Support `replaceAiImageHolder`, `anchorShapeId`, `placement`, `margin`, `matchAnchor`.
- [ ] Enrich `get_drawpaint_selection` with `isAiImageHolder`.
- [ ] Manual test: with canvas closed, MCP insert updates snapshot; reopen shows image. With canvas open, poll applies or reload.

## Task 4: Skill port

**Files:** `.cursor/skills/drawpaint-image-gen/SKILL.md`, update `.cursor/skills/drawpaint/SKILL.md`

- [ ] Port cowart-image-gen workflow to DrawPaint tool names.
- [ ] Document deeplink entry: “请处理 DrawPaint 待办请求”.

## Task 5: Smoke verify

- [ ] `npm run dev`; create holder; queue fake insert via MCP/node script; confirm replace bounds.
- [ ] Update README Phase A section.

---

## Follow-ups (not this plan)

- Phase B: annotation place-right-only skill + MCP placement defaults.
- Phase C: AI HTML draft holder + `insert_drawpaint_html_draft`.
