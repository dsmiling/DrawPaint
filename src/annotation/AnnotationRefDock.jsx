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
 * Fixed bottom bar when an annotation arrow is selected.
 * (Avoids follow-dock being clipped / off-screen under tldraw.)
 */
export function AnnotationRefDock({
  editor,
  arrowId,
  pickingFromCanvas,
  onStartPickCanvas,
  onCancelPickCanvas,
  showToast,
}) {
  const fileRef = useRef(null);
  const [, bump] = useState(0);

  useEffect(() => {
    if (!editor) return undefined;
    return editor.store.listen(() => bump((n) => n + 1), {
      scope: "document",
    });
  }, [editor]);

  if (!editor || !arrowId) return null;

  const shape = editor.getShape(arrowId);
  if (!shape || shape.type !== "arrow") return null;

  const refs = getAnnotationRefs(shape);
  const room = Math.max(0, ANNOTATION_REF_MAX - refs.length);
  const label = String(shape.props?.text || "").trim();

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
        addAnnotationRef(editor, arrowId, {
          source: "upload",
          relativePath: saved.relativePath,
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
    <div className="dp-ref-bar" role="dialog" aria-label="标注参考图">
      <div className="dp-ref-bar__head">
        <strong>标注参考图</strong>
        <span className="dp-ref-bar__sub">
          {label ? `「${label}」` : "（无文字）"} · {refs.length}/{ANNOTATION_REF_MAX}
        </span>
      </div>

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
        <p className="dp-ref-bar__empty">还没有参考图。把图2挂到这个箭头上，表示「把这些元素放到箭头指向处」。</p>
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
          : "箭头文字=改哪里 · 参考图=放什么"}
      </div>
    </div>
  );
}
