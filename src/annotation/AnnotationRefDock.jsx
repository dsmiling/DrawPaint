import { useEffect, useRef, useState } from "react";
import { fileToDataUrl, uploadAsset } from "../api.js";
import {
  ANNOTATION_REF_MAX,
  addAnnotationRef,
  getAnnotationRefs,
  previewUrlForRef,
  removeAnnotationRef,
} from "./refs.js";

/**
 * Follow-dock under the annotation arrow (opened on double-click / after draw).
 * Text is edited here; the on-canvas arrow label stays read-only.
 */
export function AnnotationRefDock({
  editor,
  arrowId,
  dockStyle,
  pickingFromCanvas,
  onStartPickCanvas,
  onCancelPickCanvas,
  onClose,
  showToast,
}) {
  const fileRef = useRef(null);
  const composingRef = useRef(false);
  const [, bump] = useState(0);
  const [draftText, setDraftText] = useState("");

  useEffect(() => {
    if (!editor || !arrowId) return;
    const shape = editor.getShape(arrowId);
    setDraftText(String(shape?.props?.text || ""));
  }, [editor, arrowId]);

  useEffect(() => {
    if (!editor || !arrowId) return undefined;
    return editor.store.listen(() => {
      // Skip during IME composition — controlled re-renders leave pinyin residue.
      if (composingRef.current) return;
      const shape = editor.getShape(arrowId);
      if (shape?.type === "arrow") {
        const next = String(shape.props?.text || "");
        setDraftText((prev) => (prev === next ? prev : next));
      }
      bump((n) => n + 1);
    }, { scope: "document" });
  }, [editor, arrowId]);

  if (!editor || !arrowId || !dockStyle) return null;

  const shape = editor.getShape(arrowId);
  if (!shape || shape.type !== "arrow") return null;

  const refs = getAnnotationRefs(shape);
  const room = Math.max(0, ANNOTATION_REF_MAX - refs.length);

  const commitLabelText = (text) => {
    editor.updateShape({
      id: arrowId,
      type: "arrow",
      props: { text },
    });
  };

  const onUpload = async (event) => {
    const files = [...(event.target.files || [])];
    event.target.value = "";
    if (!files.length) return;
    let added = 0;
    for (const file of files.slice(0, room)) {
      if (!file.type.startsWith("image/")) continue;
      try {
        const dataUrl = await fileToDataUrl(file);
        const saved = await uploadAsset(dataUrl, file.name || "annotation-ref.png");
        if (!saved?.relativePath && !saved?.filePath) {
          throw new Error("上传成功但未返回文件路径");
        }
        addAnnotationRef(editor, arrowId, {
          source: "upload",
          relativePath: saved.relativePath,
          filePath: saved.filePath || null,
          url: saved.url,
          name: file.name || "upload",
        });
        added += 1;
      } catch (error) {
        showToast?.(`上传失败: ${error.message}`);
      }
    }
    if (added) showToast?.(`已附加 ${added} 张参考图`);
  };

  return (
    <div
      className="dp-dock dp-dock--annotate-ref"
      role="dialog"
      aria-label="编辑标注"
      style={{
        left: dockStyle.left,
        top: dockStyle.top,
        width: Math.max(dockStyle.width || 320, 380),
      }}
    >
      <div className="dp-ref-bar__head">
        <strong>编辑标注</strong>
        <span className="dp-ref-bar__sub">
          参考图 {refs.length}/{ANNOTATION_REF_MAX}
        </span>
        {onClose ? (
          <button type="button" className="dp-ref-bar__close" onClick={onClose} title="关闭">
            ×
          </button>
        ) : null}
      </div>

      <label className="dp-ref-bar__label">标注文字（改哪里）</label>
      <textarea
        className="dp-ref-bar__text"
        rows={2}
        value={draftText}
        placeholder="例如：替换面部 / 删除辫子"
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          const text = event.currentTarget.value;
          setDraftText(text);
          commitLabelText(text);
        }}
        onChange={(event) => {
          const text = event.target.value;
          setDraftText(text);
          // Commit only after IME finishes; mid-composition writes break pinyin.
          if (!composingRef.current) {
            commitLabelText(text);
          }
        }}
        onKeyDown={(event) => {
          // Keep shortcuts from reaching the canvas (delete shape, etc.)
          // Do not preventDefault — that breaks IME confirm keys.
          event.stopPropagation();
        }}
      />

      <label className="dp-ref-bar__label">参考图（放什么）</label>
      {refs.length > 0 ? (
        <div className="dp-dock__thumbs">
          {refs.map((ref) => {
            const src = previewUrlForRef(editor, ref);
            return (
              <div key={ref.id} className="dp-dock__thumb" title={ref.name || ref.source}>
                {src ? (
                  <img src={src} alt={ref.name || "参考图"} />
                ) : (
                  <div className="dp-dock__thumb-fallback">图</div>
                )}
                <button
                  type="button"
                  className="dp-dock__thumb-remove"
                  title="移除"
                  onClick={() => {
                    removeAnnotationRef(editor, arrowId, ref.id);
                    showToast?.("已移除参考图");
                  }}
                >
                  ×
                </button>
                <span className="dp-dock__thumb-badge">
                  {ref.source === "canvas" ? "画布" : "上传"}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="dp-ref-bar__empty">
          还没有参考图。把图2挂到这个箭头上，表示「把这些元素放到箭头指向处」。
        </p>
      )}

      <div className="dp-dock__row">
        <button
          type="button"
          className="dp-dock__ref"
          disabled={room <= 0 || pickingFromCanvas}
          onClick={() => fileRef.current?.click()}
        >
          上传图片
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={onUpload}
        />
        {pickingFromCanvas ? (
          <button type="button" className="dp-dock__send" onClick={onCancelPickCanvas}>
            取消选图
          </button>
        ) : (
          <button
            type="button"
            className="dp-dock__send"
            disabled={room <= 0}
            onClick={onStartPickCanvas}
          >
            从画布选图
          </button>
        )}
      </div>
      <div className="dp-dock__meta">
        {pickingFromCanvas
          ? "请点击画布上的另一张图片（如图2）"
          : "单击箭头可改指向 · 双击打开本面板"}
      </div>
    </div>
  );
}
