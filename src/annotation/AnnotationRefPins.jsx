import { useEffect, useState } from "react";
import {
  getAnnotationRefs,
  isAnnotationArrowShape,
  previewUrlForRef,
} from "./refs.js";
import {
  getAnnotationRefPinAnchor,
  getAnnotationRefPinThumbSize,
} from "./refPinLayout.js";

/**
 * Persistent on-canvas thumbnails for annotation element refs.
 * Shown under the arrow label even when the arrow is not selected.
 */
export function AnnotationRefPins({ editor, selectedArrowId, dockOpen }) {
  const [, bump] = useState(0);

  useEffect(() => {
    if (!editor) return undefined;
    const refresh = () => bump((n) => n + 1);
    const unsubDoc = editor.store.listen(refresh, { scope: "document" });
    const unsubSession = editor.store.listen(refresh, { scope: "session" });
    return () => {
      unsubDoc();
      unsubSession();
    };
  }, [editor]);

  if (!editor) return null;

  const thumb = getAnnotationRefPinThumbSize(editor);
  const pins = [];

  for (const shape of editor.getCurrentPageShapes()) {
    if (!isAnnotationArrowShape(shape)) continue;
    // Edit dock already shows thumbs for the open arrow.
    if (dockOpen && selectedArrowId && shape.id === selectedArrowId) continue;
    const refs = getAnnotationRefs(shape);
    if (!refs.length) continue;
    const anchor = getAnnotationRefPinAnchor(editor, shape);
    if (!anchor) continue;
    pins.push({ shape, refs, anchor });
  }

  if (!pins.length) return null;

  return (
    <div className="dp-ref-pins" aria-hidden={false}>
      {pins.map(({ shape, refs, anchor }) => {
        const width = refs.length * thumb + Math.max(0, refs.length - 1) * 4 + 6;
        return (
          <button
            key={shape.id}
            type="button"
            className="dp-ref-pin"
            title="点击选中标注以管理参考图"
            style={{
              left: anchor.x - width / 2,
              top: anchor.y,
              "--dp-ref-pin-thumb": `${thumb}px`,
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              editor.setCurrentTool("select");
              editor.select(shape.id);
            }}
          >
            {refs.map((ref) => {
              const src = previewUrlForRef(editor, ref);
              return (
                <span key={ref.id} className="dp-ref-pin__thumb">
                  {src ? (
                    <img src={src} alt="" draggable={false} />
                  ) : (
                    <span className="dp-ref-pin__fallback">图</span>
                  )}
                </span>
              );
            })}
          </button>
        );
      })}
    </div>
  );
}
