import { useCallback, useEffect, useRef, useState } from "react";
import {
  AssetRecordType,
  Tldraw,
  createShapeId,
  getSnapshot,
  loadSnapshot,
} from "tldraw";
import "tldraw/tldraw.css";
import {
  ackPendingInserts,
  blobToDataUrl,
  fileToDataUrl,
  getPendingInserts,
  getSnapshot as fetchSnapshot,
  saveSelection,
  saveSnapshot,
  submitAgentRequest,
  uploadAsset,
} from "./api.js";
import {
  ANNOTATION_TOOL_ID,
  ANNOTATION_TOOL_LABEL,
  ANNOTATION_EDIT_TOOL_LABEL,
  AnnotationRefDock,
  DrawpaintAnnotationTool,
  DrawpaintImageToolbar,
  addAnnotationRef,
  bindAnnotationEditingToolLock,
  bindAnnotationShapeSync,
  ensureAnnotationArrow,
  isImageShape,
  prepareAnnotationEditRequest,
  setAnnotationEditHandler,
  unlockGlobalToolLock,
} from "./annotation/index.js";
import {
  AI_IMAGE_ASPECT_PRESETS,
  createAiImageHolderAtViewportCenter,
  isAiImageHolderShape,
  summarizeHolderForRequest,
} from "./holders.js";

const tldrawComponents = {
  ImageToolbar: DrawpaintImageToolbar,
};

/** Build a Cursor prompt deeplink (opens chat with prefilled text; user must confirm send). */
function buildCursorPromptDeeplink(promptText) {
  const maxEncoded = 7500;
  let text = promptText.trim();
  let encoded = encodeURIComponent(text);
  if (encoded.length > maxEncoded) {
    text = [
      "请处理 DrawPaint 待办请求。",
      "完整内容已写入 canvas/pending-request.json，请用 MCP get_drawpaint_pending_request 读取后执行。",
      "",
      "摘要：",
      promptText.slice(0, 1200),
      "…",
    ].join("\n");
    encoded = encodeURIComponent(text);
  }
  return `cursor://anysphere.cursor-deeplink/prompt?text=${encoded}`;
}

function openCursorChat(promptText) {
  const href = buildCursorPromptDeeplink(promptText);
  // Protocol handler works best via an anchor click (esp. inside Simple Browser).
  const a = document.createElement("a");
  a.href = href;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  return href;
}

const CHAT_BOOT_PROMPT = `请立即处理 DrawPaint 待办请求：
1. 调用 get_drawpaint_pending_request（或读 canvas/pending-request.json）
2. 若 type 为 ai_image_generate：按 drawpaint-image-gen Skill；按 targetWidth/Height 生图，再用 insert_drawpaint_image（anchorShapeId + replaceAiImageHolder: true）替换 AI 图片框
3. 若 type 为 annotate_edit：按 drawpaint-image-edit Skill；阅读标注截图，生成干净新图，insert_drawpaint_image（anchorShapeId=原图, placement: right, margin: 40, matchAnchor: true, replaceAiImageHolder: false）
4. clear_drawpaint_pending_request`;

function buildAiImageHolderPrompt({ prompt, holder, references }) {
  const refLines =
    references.length === 0
      ? ["Reference images: none"]
      : [
          `Reference images: ${references.length}`,
          "Reference image local paths:",
          ...references.map((r, i) => `${i + 1}. ${r.relativePath}`),
          "Use these local files as visual references.",
        ];

  return [
    "请为 DrawPaint 的 AI 图片框生成最终位图，并用 MCP 替换该框。",
    "",
    "## 用户 Prompt",
    prompt.trim() || "（无）",
    "",
    `Target canvas slot: ${Math.round(holder.targetWidth)} x ${Math.round(holder.targetHeight)} canvas units.`,
    `Target aspect ratio: ${holder.targetAspectRatio} (${holder.targetAspectDecimal.toFixed(4)} width/height).`,
    "Compose the final bitmap for this ratio so it fits the slot without cropping or stretching.",
    "",
    `anchorShapeId: ${holder.anchorShapeId}`,
    "insert_drawpaint_image: set replaceAiImageHolder true (default) with this anchorShapeId.",
    "",
    ...refLines,
  ].join("\n");
}

/** Upload dropped/pasted files to local DrawPaint API so they persist. */
const drawpaintAssets = {
  async upload(_asset, file) {
    const dataUrl = await fileToDataUrl(file);
    const saved = await uploadAsset(dataUrl, file.name || "upload.png");
    return { src: saved.url };
  },
  resolve(asset) {
    return asset.props.src || null;
  },
};

function extractPlainText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value !== "object") return "";

  // tldraw richText: { type, content: [...] }
  const chunks = [];
  const walk = (node) => {
    if (!node) return;
    if (typeof node === "string") {
      chunks.push(node);
      return;
    }
    if (typeof node.text === "string") chunks.push(node.text);
    if (Array.isArray(node.content)) node.content.forEach(walk);
    if (Array.isArray(node)) node.forEach(walk);
  };
  walk(value);
  return chunks.join("").trim();
}

function summarizeShape(editor, shape) {
  const bounds = editor.getShapePageBounds(shape.id);
  const richText =
    extractPlainText(shape.props?.richText) ||
    extractPlainText(shape.props?.text) ||
    "";
  return {
    id: shape.id,
    type: shape.type,
    x: shape.x,
    y: shape.y,
    rotation: shape.rotation ?? 0,
    parentId: shape.parentId,
    w: bounds?.w ?? shape.props?.w ?? null,
    h: bounds?.h ?? shape.props?.h ?? null,
    meta: shape.meta || {},
    isAiImageHolder:
      shape.type === "frame" &&
      (shape.meta?.drawpaintAiImageHolder === true ||
        shape.meta?.cowartAiImageHolder === true),
    props: {
      text: richText || null,
      altText: shape.props?.altText ?? null,
      geo: shape.props?.geo ?? null,
      url: shape.props?.url ?? null,
      name: shape.props?.name ?? null,
      w: shape.props?.w ?? null,
      h: shape.props?.h ?? null,
      labelColor: shape.props?.labelColor ?? null,
    },
  };
}

function describeShapeLine(s, i) {
  const desc =
    s.props?.text?.trim() ||
    s.props?.altText?.trim() ||
    s.props?.name?.trim() ||
    "-";
  return `${i + 1}. [${s.type}] id=${s.id} size=${Math.round(s.w || 0)}x${Math.round(s.h || 0)} desc=${desc}`;
}

function buildGeneratePrompt({ prompt, selection }) {
  const selected = (selection?.shapes || []).map(describeShapeLine).join("\n");

  const altTexts = (selection?.shapes || [])
    .map((s) => s.props?.altText?.trim())
    .filter(Boolean);

  return [
    "请处理 DrawPaint 画布发来的生图/改图请求。",
    "",
    "## 用户 Prompt",
    prompt.trim() ||
      (altTexts.length ? altTexts.join("\n") : "（无）"),
    "",
    "## 图片 Alternative Text / 描述",
    altTexts.length ? altTexts.map((t, i) => `${i + 1}. ${t}`).join("\n") : "（无）",
    "",
    "## 当前选区",
    selected || "（未选中形状）",
    "",
    "完成后请用 insert_drawpaint_image 把结果图插入画布，并 clear_drawpaint_pending_request。",
  ].join("\n");
}

async function insertImageFromUrl(editor, url, opts = {}) {
  const res = await fetch(url);
  const blob = await res.blob();
  const dataUrl = await blobToDataUrl(blob);
  const img = await createImageBitmap(blob);
  const w = img.width;
  const h = img.height;
  img.close?.();

  const assetId = AssetRecordType.createId();
  editor.createAssets([
    {
      id: assetId,
      type: "image",
      typeName: "asset",
      props: {
        name: opts.name || "drawpaint-image",
        src: dataUrl,
        w,
        h,
        mimeType: blob.type || "image/png",
        isAnimated: false,
      },
      meta: {},
    },
  ]);

  const selected = editor.getSelectedShapes().find((s) => s.type === "image");
  const bounds = selected ? editor.getShapePageBounds(selected.id) : null;
  const id = createShapeId();

  if (opts.replaceSelected && selected && bounds) {
    editor.createShape({
      id,
      type: "image",
      x: bounds.x,
      y: bounds.y,
      props: {
        assetId,
        w: bounds.w,
        h: bounds.h,
      },
    });
    editor.deleteShapes([selected.id]);
    editor.select(id);
    return id;
  }

  const point = editor.getViewportPageBounds().center;
  const x = bounds ? bounds.x + bounds.w + 40 : point.x - w / 2;
  const y = bounds ? bounds.y : point.y - h / 2;
  editor.createShape({
    id,
    type: "image",
    x,
    y,
    props: {
      assetId,
      w: Math.min(w, 900),
      h: Math.min(h, 900) * (Math.min(w, 900) / w),
    },
  });
  editor.select(id);
  return id;
}

function computeFollowDockStyle(editor, shapeIds) {
  if (!editor || !shapeIds?.length) return null;
  const boxes = shapeIds
    .map((id) => editor.getShapePageBounds(id))
    .filter(Boolean);
  if (!boxes.length) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }

  const bl = editor.pageToViewport({ x: minX, y: maxY });
  const br = editor.pageToViewport({ x: maxX, y: maxY });
  const frameW = Math.max(1, br.x - bl.x);
  const vp = editor.getViewportScreenBounds();
  const maxW = Math.max(280, (vp?.width || 800) - 24);
  const width = Math.min(Math.max(frameW, 320), Math.min(560, maxW));

  let left = bl.x + frameW / 2 - width / 2;
  let top = bl.y + 12;
  left = Math.max(8, Math.min(left, maxW - width + 8));
  const maxTop = Math.max(8, (vp?.height || 600) - 160);
  top = Math.max(8, Math.min(top, maxTop));

  return { left, top, width };
}

function HolderGenerateDock({
  prompt,
  setPrompt,
  busy,
  onGenerate,
  lastRequestId,
  holderInfo,
  referenceItems,
  setReferenceItems,
  refInputRef,
  dockStyle,
}) {
  if (!holderInfo || !dockStyle) return null;

  const removeRef = (id) => {
    setReferenceItems((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target?.url) URL.revokeObjectURL(target.url);
      return prev.filter((item) => item.id !== id);
    });
  };

  return (
    <div
      className="dp-dock"
      role="dialog"
      aria-label="AI 图片生成"
      style={{
        left: dockStyle.left,
        top: dockStyle.top,
        width: dockStyle.width,
      }}
    >
      {referenceItems.length > 0 ? (
        <div className="dp-dock__thumbs">
          {referenceItems.map((item) => (
            <div key={item.id} className="dp-dock__thumb">
              <img src={item.url} alt={item.file.name || "参考图"} />
              <button
                type="button"
                className="dp-dock__thumb-remove"
                title="移除参考图"
                onClick={() => removeRef(item.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="dp-dock__row">
        <button
          type="button"
          className="dp-dock__ref"
          title="添加参考图"
          onClick={() => refInputRef.current?.click()}
        >
          参考图
        </button>
        <input
          ref={refInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files || [])];
            e.target.value = "";
            if (!files.length) return;
            setReferenceItems((prev) => {
              const room = Math.max(0, 10 - prev.length);
              const next = files.slice(0, room).map((file) => ({
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                file,
                url: URL.createObjectURL(file),
              }));
              return [...prev, ...next];
            });
          }}
        />
        <input
          className="dp-dock__prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="描述你想生成的图片"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && prompt.trim() && !busy) {
              e.preventDefault();
              onGenerate();
            }
          }}
        />
        <button
          type="button"
          className="dp-dock__send"
          disabled={busy || !prompt.trim()}
          onClick={onGenerate}
        >
          发送
        </button>
      </div>
      <div className="dp-dock__meta">
        {lastRequestId ? `已唤起对话 ${lastRequestId.slice(0, 8)}…（请在 Cursor 按 Enter 发送）` : "回车或点发送 → Cursor"}
      </div>
    </div>
  );
}

function SizeSidePanel({
  holderInfo,
  aspectPresetId,
  setAspectPresetId,
  onApplyAspectPreset,
  onApplyCustomSize,
}) {
  const [widthText, setWidthText] = useState("");
  const [heightText, setHeightText] = useState("");

  useEffect(() => {
    if (!holderInfo) return;
    setWidthText(String(Math.round(holderInfo.targetWidth)));
    setHeightText(String(Math.round(holderInfo.targetHeight)));
  }, [holderInfo?.anchorShapeId, holderInfo?.targetWidth, holderInfo?.targetHeight]);

  if (!holderInfo) return null;

  const commitSize = () => {
    const w = Math.max(32, Math.round(Number(widthText)) || 0);
    const h = Math.max(32, Math.round(Number(heightText)) || 0);
    if (!w || !h) {
      setWidthText(String(Math.round(holderInfo.targetWidth)));
      setHeightText(String(Math.round(holderInfo.targetHeight)));
      return;
    }
    setWidthText(String(w));
    setHeightText(String(h));
    onApplyCustomSize(w, h);
  };

  return (
    <aside className="dp-size-panel" aria-label="AI 图片尺寸">
      <h2>尺寸 / 比例</h2>
      <div className="dp-size-panel__fields">
        <label>
          宽
          <input
            type="number"
            min={32}
            step={1}
            value={widthText}
            onChange={(e) => setWidthText(e.target.value)}
            onBlur={commitSize}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitSize();
              }
            }}
          />
        </label>
        <span className="dp-size-panel__x">×</span>
        <label>
          高
          <input
            type="number"
            min={32}
            step={1}
            value={heightText}
            onChange={(e) => setHeightText(e.target.value)}
            onBlur={commitSize}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitSize();
              }
            }}
          />
        </label>
      </div>
      <p className="dp-size-panel__ratio">{holderInfo.targetAspectRatio}</p>
      <label className="dp-size-panel__presets-label">比例预设</label>
      <div className="dp-size-panel__presets">
        {AI_IMAGE_ASPECT_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={aspectPresetId === p.id ? "active" : ""}
            onClick={() => {
              setAspectPresetId(p.id);
              onApplyAspectPreset(p.id);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <p className="dp-size-panel__hint">
        修改宽高或比例会调整当前 AI 图片框；提示词与参考图在框下方输入。
      </p>
    </aside>
  );
}

/** Cowart-style: selected image gets an action strip (not a generate prompt). */
function ImageAnnotateDock({
  busy,
  onAnnotate,
  lastRequestId,
  dockStyle,
  imageShapeId,
}) {
  if (!imageShapeId || !dockStyle) return null;

  return (
    <div
      className="dp-dock dp-dock--annotate"
      role="dialog"
      aria-label="标注修改"
      style={{
        left: dockStyle.left,
        top: dockStyle.top,
        width: Math.max(dockStyle.width || 320, 360),
      }}
    >
      <div className="dp-dock__row">
        <div className="dp-dock__hint-inline">
          自动收集附近标注与元素参考图 · 点按钮提交
        </div>
        <button
          type="button"
          className="dp-dock__send"
          disabled={busy}
          onClick={() => onAnnotate(imageShapeId)}
        >
          {busy ? "提交中…" : ANNOTATION_EDIT_TOOL_LABEL}
        </button>
        {lastRequestId ? (
          <button
            type="button"
            className="dp-dock__ghost"
            onClick={() => openCursorChat(CHAT_BOOT_PROMPT)}
          >
            再开对话
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default function App() {
  const editorRef = useRef(null);
  const saveTimer = useRef(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("启动中…");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  /** AI 图片框生成提示词（面板本地态，对齐 Cowart：换框不清空，发送后清空） */
  const [generatePrompt, setGeneratePrompt] = useState("");
  const [lastRequestId, setLastRequestId] = useState(null);
  const [holderInfo, setHolderInfo] = useState(null);
  const [selectedImageId, setSelectedImageId] = useState(null);
  const [selectedAnnotationArrowId, setSelectedAnnotationArrowId] = useState(null);
  const [pickingRefForArrowId, setPickingRefForArrowId] = useState(null);
  const [editorInstance, setEditorInstance] = useState(null);
  const [aspectPresetId, setAspectPresetId] = useState("1-1");
  const [referenceItems, setReferenceItems] = useState([]);
  const [dockStyle, setDockStyle] = useState(null);

  const showToast = useCallback((msg) => {
    setToast(msg);
    window.setTimeout(() => setToast(""), 2800);
  }, []);

  const refreshDockPosition = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) {
      setDockStyle(null);
      return;
    }
    const ids = [...editor.getSelectedShapeIds()];
    setDockStyle(computeFollowDockStyle(editor, ids));
  }, []);

  useEffect(() => {
    // Drop legacy project-notes key (UI removed; must not leak into prompts).
    try {
      localStorage.removeItem("drawpaint.projectNotes");
    } catch {
      // ignore
    }
  }, []);

  const persistSelection = useCallback(async (editor) => {
    const shapes = editor.getSelectedShapes().map((s) => summarizeShape(editor, s));
    const bounds =
      shapes.length > 0
        ? editor.getSelectionPageBounds()
        : null;
    const only = editor.getSelectedShapes();

    // Canvas-pick mode: next clicked image becomes an element ref on the arrow.
    if (pickingRefForArrowId && only.length === 1 && isImageShape(only[0])) {
      try {
        addAnnotationRef(editor, pickingRefForArrowId, {
          source: "canvas",
          shapeId: only[0].id,
          name: only[0].props?.altText || "canvas-image",
        });
        showToast("已把画布图片挂到标注上");
        setPickingRefForArrowId(null);
        editor.select(pickingRefForArrowId);
        setSelectedAnnotationArrowId(pickingRefForArrowId);
        setSelectedImageId(null);
        setHolderInfo(null);
        setDockStyle(computeFollowDockStyle(editor, [pickingRefForArrowId]));
        await saveSelection({
          shapes: editor.getSelectedShapes().map((s) => summarizeShape(editor, s)),
          bounds: editor.getSelectionPageBounds()
            ? (() => {
                const b = editor.getSelectionPageBounds();
                return { x: b.x, y: b.y, w: b.w, h: b.h };
              })()
            : null,
        });
        return;
      } catch (error) {
        showToast(error.message || "挂载失败");
        setPickingRefForArrowId(null);
      }
    }

    if (only.length === 1 && isAiImageHolderShape(only[0])) {
      const info = summarizeHolderForRequest(only[0]);
      setHolderInfo(info);
      setSelectedImageId(null);
      setSelectedAnnotationArrowId(null);
      const matched = AI_IMAGE_ASPECT_PRESETS.find(
        (p) => Math.abs(p.w / p.h - (info.targetWidth || 1) / (info.targetHeight || 1)) < 0.02,
      );
      if (matched) setAspectPresetId(matched.id);
    } else if (only.length === 1 && only[0].type === "arrow") {
      ensureAnnotationArrow(editor, only[0]);
      setHolderInfo(null);
      setSelectedImageId(null);
      setSelectedAnnotationArrowId(only[0].id);
    } else if (only.length === 1 && isImageShape(only[0])) {
      setHolderInfo(null);
      setSelectedAnnotationArrowId(null);
      setSelectedImageId(only[0].id);
    } else {
      setHolderInfo(null);
      setSelectedImageId(null);
      setSelectedAnnotationArrowId(null);
    }
    setDockStyle(computeFollowDockStyle(editor, only.map((s) => s.id)));
    await saveSelection({
      shapes,
      bounds: bounds
        ? { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h }
        : null,
    });
  }, [pickingRefForArrowId, showToast]);

  const applyAspectPreset = useCallback(
    (presetId) => {
      const editor = editorRef.current;
      if (!editor) return;
      const selected = editor.getSelectedShapes();
      if (selected.length !== 1 || !isAiImageHolderShape(selected[0])) return;
      const preset = AI_IMAGE_ASPECT_PRESETS.find((p) => p.id === presetId);
      if (!preset) return;
      editor.updateShape({
        id: selected[0].id,
        type: "frame",
        props: { w: preset.w, h: preset.h },
      });
      persistSelection(editor).catch(() => {});
    },
    [persistSelection],
  );

  const applyCustomSize = useCallback(
    (w, h) => {
      const editor = editorRef.current;
      if (!editor) return;
      const selected = editor.getSelectedShapes();
      if (selected.length !== 1 || !isAiImageHolderShape(selected[0])) return;
      editor.updateShape({
        id: selected[0].id,
        type: "frame",
        props: { w, h },
      });
      const matched = AI_IMAGE_ASPECT_PRESETS.find(
        (p) => Math.abs(p.w / p.h - w / h) < 0.02,
      );
      setAspectPresetId(matched?.id || "");
      persistSelection(editor).catch(() => {});
    },
    [persistSelection],
  );

  const scheduleSave = useCallback((editor) => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      try {
        const snap = getSnapshot(editor.store);
        await saveSnapshot(snap.document, snap.session);
        setStatus(`已保存 ${new Date().toLocaleTimeString()}`);
      } catch (error) {
        setStatus(`保存失败: ${error.message}`);
      }
    }, 600);
  }, []);

  const handleMount = useCallback(
    (editor) => {
      editorRef.current = editor;
      setEditorInstance(editor);
      let cancelled = false;

      (async () => {
        try {
          const remote = await fetchSnapshot();
          if (cancelled) return;
          if (remote?.document) {
            loadSnapshot(editor.store, {
              document: remote.document,
              session: remote.session || undefined,
            });
          }
          setReady(true);
          setStatus("画布就绪");
        } catch (error) {
          if (cancelled) return;
          setStatus(`加载失败: ${error.message}`);
          setReady(true);
        }
      })();

      const unsubSave = editor.store.listen(() => scheduleSave(editor), {
        source: "user",
        scope: "document",
      });
      const unsubSelection = editor.store.listen(
        () => {
          persistSelection(editor).catch(() => {});
        },
        { scope: "session", source: "all" },
      );
      const unsubSelectionDoc = editor.store.listen(
        () => {
          // Arrow meta promotion / shape edits also need a selection refresh.
          persistSelection(editor).catch(() => {});
        },
        { scope: "document", source: "user" },
      );
      // Keep dock glued under the selection while panning/zooming
      const unsubCamera = editor.store.listen(
        () => {
          refreshDockPosition();
        },
        { scope: "session" },
      );
      const unsubAnnotationSync = bindAnnotationShapeSync(editor);
      const unsubAnnotationEditLock = bindAnnotationEditingToolLock(editor);
      persistSelection(editor).catch(() => {});

      // tldraw expects onMount to return a dispose function (not a Promise)
      return () => {
        cancelled = true;
        unsubSave?.();
        unsubSelection?.();
        unsubSelectionDoc?.();
        unsubCamera?.();
        unsubAnnotationSync?.();
        unsubAnnotationEditLock?.();
        if (saveTimer.current) window.clearTimeout(saveTimer.current);
        if (editorRef.current === editor) editorRef.current = null;
        setEditorInstance((current) => (current === editor ? null : current));
      };
    },
    [persistSelection, refreshDockPosition, scheduleSave],
  );

  // Poll pending inserts from MCP / Agent
  useEffect(() => {
    if (!ready) return undefined;
    let cancelled = false;

    async function tick() {
      const editor = editorRef.current;
      if (!editor || cancelled) return;
      try {
        const { items } = await getPendingInserts();
        if (!items?.length) return;
        const needsReload = items.some((i) => i.reloadSnapshot);
        if (needsReload) {
          const remote = await fetchSnapshot();
          if (remote?.document) {
            loadSnapshot(editor.store, {
              document: remote.document,
              session: remote.session || undefined,
            });
          }
          await ackPendingInserts(items.map((i) => i.id));
          showToast(`画布已更新（${items.length}）`);
          setStatus(`已同步 ${new Date().toLocaleTimeString()}`);
          return;
        }
        for (const item of items) {
          if (item.type === "insert_image" && item.url) {
            await insertImageFromUrl(editor, item.url, {
              replaceSelected: item.replaceSelected || item.replaceAiImageHolder,
              name: item.prompt || "agent-image",
            });
          }
        }
        await ackPendingInserts(items.map((i) => i.id));
        showToast(`已插入 ${items.length} 张图`);
        scheduleSave(editor);
      } catch {
        // ignore transient poll errors
      }
    }

    const id = window.setInterval(tick, 1500);
    tick();
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [ready, scheduleSave, showToast]);

  const currentSelectionPayload = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return { shapes: [], bounds: null };
    const shapes = editor.getSelectedShapes().map((s) => summarizeShape(editor, s));
    const bounds = editor.getSelectionPageBounds();
    return {
      shapes,
      bounds: bounds ? { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h } : null,
    };
  }, []);

  const onGenerate = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;
    setBusy(true);
    try {
      const selection = currentSelectionPayload();
      const selected = editor.getSelectedShapes();
      const holderShape =
        selected.length === 1 && isAiImageHolderShape(selected[0])
          ? selected[0]
          : null;
      const holder = holderShape ? summarizeHolderForRequest(holderShape) : null;

      const references = [];
      for (const item of referenceItems.slice(0, 10)) {
        const dataUrl = await fileToDataUrl(item.file);
        const saved = await uploadAsset(dataUrl, item.file.name || "reference.png");
        references.push(saved);
      }

      const fullPrompt = holder
        ? buildAiImageHolderPrompt({
            prompt: generatePrompt,
            holder,
            references,
          })
        : buildGeneratePrompt({ prompt: generatePrompt, selection });

      const { request } = await submitAgentRequest({
        type: holder ? "ai_image_generate" : "generate",
        prompt: fullPrompt,
        selection,
        anchorShapeId: holder?.anchorShapeId || null,
        targetWidth: holder?.targetWidth || null,
        targetHeight: holder?.targetHeight || null,
        targetAspectRatio: holder?.targetAspectRatio || null,
        referencePaths: references.map((r) => r.relativePath),
      });
      setLastRequestId(request.id);
      const launchPrompt = [
        CHAT_BOOT_PROMPT,
        "",
        `请求 ID：${request.id}`,
        holder ? `AI 图片框：${holder.anchorShapeId}` : "",
        "",
        fullPrompt,
      ]
        .filter(Boolean)
        .join("\n");
      openCursorChat(launchPrompt);
      showToast("已打开 Cursor；请在对话里按 Enter 发送");
      setStatus(`已唤起对话 ${request.id.slice(0, 8)}…`);
      for (const item of referenceItems) {
        if (item.url) URL.revokeObjectURL(item.url);
      }
      setReferenceItems([]);
      setGeneratePrompt("");
    } catch (error) {
      showToast(`失败: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }, [
    currentSelectionPayload,
    generatePrompt,
    referenceItems,
    showToast,
  ]);

  const onAnnotationEdit = useCallback(
    async (editorOrId, maybeImageShapeId) => {
      const editor = editorRef.current;
      // Toolbar passes (editor, id); dock passes (id)
      const imageShapeId =
        typeof editorOrId === "string" ? editorOrId : maybeImageShapeId;
      const ed = typeof editorOrId === "object" && editorOrId?.getShape ? editorOrId : editor;
      if (!ed || !imageShapeId) {
        showToast("请先选中一张图片");
        return;
      }
      setBusy(true);
      showToast("正在导出标注截图…");
      try {
        const prepared = await prepareAnnotationEditRequest(ed, imageShapeId, {
          uploadAsset,
        });
        const selection = {
          shapes: prepared.shapeIds.map((id) => {
            const shape = ed.getShape(id);
            return shape ? summarizeShape(ed, shape) : { id };
          }),
          bounds: null,
        };
        const { request } = await submitAgentRequest({
          type: "annotate_edit",
          prompt: prepared.fullPrompt,
          selection,
          screenshotRelativePath: prepared.screenshotRelativePath,
          anchorShapeId: imageShapeId,
          referencePaths: prepared.referencePaths || [],
          elementRefs: prepared.elementRefs || [],
        });
        setLastRequestId(request.id);
        const refCount = prepared.elementRefs?.length || 0;
        const launchPrompt = [
          CHAT_BOOT_PROMPT,
          "",
          `请求 ID：${request.id}`,
          `原图 shape：${imageShapeId}`,
          `附近标注：${prepared.annotationCount} 个`,
          `元素参考图：${refCount} 张`,
          `标注截图：${prepared.screenshotRelativePath}`,
          "",
          prepared.fullPrompt,
        ].join("\n");
        openCursorChat(launchPrompt);
        showToast(
          `已提交（标注 ${prepared.annotationCount} · 参考图 ${refCount}）· 请在 Cursor 按 Enter`,
        );
        setStatus(`已唤起对话 ${request.id.slice(0, 8)}…`);
      } catch (error) {
        console.error("[DrawPaint] annotation edit:", error);
        showToast(`失败: ${error.message || String(error)}`);
        throw error;
      } finally {
        setBusy(false);
      }
    },
    [showToast],
  );

  useEffect(() => {
    setAnnotationEditHandler(onAnnotationEdit);
    return () => setAnnotationEditHandler(null);
  }, [onAnnotationEdit]);

  const fileInputRef = useRef(null);
  const refInputRef = useRef(null);

  const onPickImage = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onFileChosen = useCallback(
    async (event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      const editor = editorRef.current;
      if (!file || !editor) return;
      if (!file.type.startsWith("image/")) {
        showToast("请选择图片文件");
        return;
      }
      try {
        setBusy(true);
        await editor.putExternalContent({
          type: "files",
          files: [file],
          point: editor.getViewportPageBounds().center,
        });
        showToast("图片已添加到画布");
        scheduleSave(editor);
      } catch (error) {
        showToast(`上传失败: ${error.message}`);
      } finally {
        setBusy(false);
      }
    },
    [scheduleSave, showToast],
  );

  return (
    <div className="dp-shell">
      <header className="dp-topbar">
        <div className="dp-brand">DrawPaint</div>
        <button
          type="button"
          className="primary"
          onClick={() => {
            const editor = editorRef.current;
            if (!editor) return;
            createAiImageHolderAtViewportCenter(editor, aspectPresetId);
            persistSelection(editor).catch(() => {});
            showToast("已创建 AI 图片框");
          }}
        >
          AI 图片
        </button>
        <button type="button" onClick={onPickImage}>
          上传图片
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          style={{ display: "none" }}
          onChange={onFileChosen}
        />
        <button
          type="button"
          className="primary"
          title={ANNOTATION_TOOL_LABEL}
          onClick={() => {
            const editor = editorRef.current;
            if (!editor) return;
            unlockGlobalToolLock(editor);
            editor.setCurrentTool(ANNOTATION_TOOL_ID);
          }}
        >
          {ANNOTATION_TOOL_LABEL}
        </button>
        <button type="button" onClick={() => editorRef.current?.setCurrentTool("draw")}>
          画笔
        </button>
        <button type="button" onClick={() => editorRef.current?.setCurrentTool("text")}>
          文字
        </button>
        <button type="button" onClick={() => editorRef.current?.setCurrentTool("geo")}>
          形状
        </button>
        <button type="button" onClick={() => editorRef.current?.setCurrentTool("select")}>
          选择
        </button>
        <div className="dp-status">
          {pickingRefForArrowId
            ? "选图模式：点击画布上的图片挂到标注"
            : selectedAnnotationArrowId
              ? "已选标注箭头 · 底部可附加参考图"
              : status}
        </div>
      </header>
      <div className="dp-main">
        <div className="dp-canvas">
          <Tldraw
            assets={drawpaintAssets}
            components={tldrawComponents}
            tools={[DrawpaintAnnotationTool]}
            onMount={handleMount}
          />
        </div>
        {holderInfo ? (
          <>
            <SizeSidePanel
              holderInfo={holderInfo}
              aspectPresetId={aspectPresetId}
              setAspectPresetId={setAspectPresetId}
              onApplyAspectPreset={applyAspectPreset}
              onApplyCustomSize={applyCustomSize}
            />
            <HolderGenerateDock
              prompt={generatePrompt}
              setPrompt={setGeneratePrompt}
              busy={busy}
              onGenerate={onGenerate}
              lastRequestId={lastRequestId}
              holderInfo={holderInfo}
              referenceItems={referenceItems}
              setReferenceItems={setReferenceItems}
              refInputRef={refInputRef}
              dockStyle={dockStyle}
            />
          </>
        ) : selectedAnnotationArrowId && (editorInstance || editorRef.current) ? (
          <AnnotationRefDock
            editor={editorInstance || editorRef.current}
            arrowId={selectedAnnotationArrowId}
            pickingFromCanvas={Boolean(pickingRefForArrowId)}
            onStartPickCanvas={() => {
              setPickingRefForArrowId(selectedAnnotationArrowId);
              showToast("请点击画布上的图片（如图2）");
            }}
            onCancelPickCanvas={() => {
              setPickingRefForArrowId(null);
              showToast("已取消选图");
            }}
            showToast={showToast}
          />
        ) : (
          <ImageAnnotateDock
            busy={busy}
            onAnnotate={onAnnotationEdit}
            lastRequestId={lastRequestId}
            dockStyle={dockStyle}
            imageShapeId={selectedImageId}
          />
        )}
        {toast ? <div className="dp-toast">{toast}</div> : null}
      </div>
    </div>
  );
}
