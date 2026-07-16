import { useCallback, useEffect, useState } from "react";
import {
  DefaultImageToolbar,
  DefaultImageToolbarContent,
  TldrawUiButtonIcon,
  useEditor,
  useValue,
} from "tldraw";
import { requestAnnotationEdit } from "./bridge.js";
import { isImageShape } from "./collect.js";
import {
  ANNOTATION_EDIT_STATUS_RESET_MS,
  ANNOTATION_EDIT_TOOL_LABEL,
} from "./constants.js";

function stopToolbarSteal(event) {
  // tldraw contextual toolbar steals pointerdown unless prevented
  event.preventDefault();
  event.stopPropagation();
}

function AnnotationEditToolbarButton({ imageShapeId }) {
  const editor = useEditor();
  const [status, setStatus] = useState("idle");

  useEffect(() => {
    setStatus("idle");
  }, [imageShapeId]);

  useEffect(() => {
    if (status === "idle" || status === "sending") return undefined;
    const timer = window.setTimeout(() => setStatus("idle"), ANNOTATION_EDIT_STATUS_RESET_MS);
    return () => window.clearTimeout(timer);
  }, [status]);

  async function handleClick(event) {
    stopToolbarSteal(event);
    if (status === "sending") return;
    setStatus("sending");
    try {
      await requestAnnotationEdit(editor, imageShapeId);
      setStatus("sent");
    } catch (error) {
      console.error("[DrawPaint] annotation edit failed:", error);
      setStatus("error");
    }
  }

  const title =
    status === "sending"
      ? "正在提交标注修改…"
      : status === "sent"
        ? "已提交标注修改"
        : status === "error"
          ? "提交失败，请重试"
          : ANNOTATION_EDIT_TOOL_LABEL;

  return (
    <button
      type="button"
      aria-label={title}
      className="tlui-button tlui-button__icon dp-annotation-edit-toolbar-button"
      data-status={status}
      disabled={status === "sending"}
      onPointerDown={stopToolbarSteal}
      onClick={handleClick}
      title={title}
    >
      <TldrawUiButtonIcon
        icon={status === "sent" ? "check" : status === "error" ? "warning-triangle" : "tool-highlight"}
        small
      />
      <span className="dp-annotation-edit-toolbar-label">{ANNOTATION_EDIT_TOOL_LABEL}</span>
    </button>
  );
}

function InlineAltTextEditor({ shapeId, onClose }) {
  const editor = useEditor();
  const shape = editor.getShape(shapeId);
  const [value, setValue] = useState(() => shape?.props?.altText || "");

  useEffect(() => {
    setValue(shape?.props?.altText || "");
  }, [shapeId, shape?.props?.altText]);

  const commit = () => {
    editor.updateShape({
      id: shapeId,
      type: "image",
      props: { altText: value },
    });
    onClose();
  };

  return (
    <div className="dp-alt-editor" onPointerDown={stopToolbarSteal}>
      <input
        className="dp-alt-editor__input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Alternative text"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <button type="button" className="tlui-button tlui-button__icon" onClick={commit} title="确认">
        <TldrawUiButtonIcon icon="check" small />
      </button>
      <button type="button" className="tlui-button tlui-button__icon" onClick={onClose} title="取消">
        <TldrawUiButtonIcon icon="cross-2" small />
      </button>
    </div>
  );
}

function DrawpaintImageToolbarContent() {
  const editor = useEditor();
  const imageShapeId = useValue(
    "drawpaint selected image shape id",
    () => {
      const shape = editor.getOnlySelectedShape();
      return isImageShape(shape) ? shape.id : null;
    },
    [editor],
  );
  const isInCropTool = useValue(
    "drawpaint image crop tool state",
    () => editor.isIn("select.crop."),
    [editor],
  );
  const [isEditingAltText, setIsEditingAltText] = useState(false);

  const handleManipulatingEnd = useCallback(() => {
    editor.setCroppingShape(null);
    editor.setCurrentTool("select.idle");
  }, [editor]);
  const handleManipulatingStart = useCallback(
    () => editor.setCurrentTool("select.crop.idle"),
    [editor],
  );
  const handleEditAltTextStart = useCallback(() => setIsEditingAltText(true), []);
  const handleEditAltTextClose = useCallback(() => setIsEditingAltText(false), []);

  useEffect(() => {
    setIsEditingAltText(false);
  }, [imageShapeId]);

  if (!imageShapeId) return null;

  if (isEditingAltText) {
    return <InlineAltTextEditor shapeId={imageShapeId} onClose={handleEditAltTextClose} />;
  }

  return (
    <>
      <DefaultImageToolbarContent
        imageShapeId={imageShapeId}
        isManipulating={isInCropTool}
        onEditAltTextStart={handleEditAltTextStart}
        onManipulatingEnd={handleManipulatingEnd}
        onManipulatingStart={handleManipulatingStart}
      />
      {!isInCropTool ? <AnnotationEditToolbarButton imageShapeId={imageShapeId} /> : null}
    </>
  );
}

export function DrawpaintImageToolbar() {
  return (
    <DefaultImageToolbar>
      <DrawpaintImageToolbarContent />
    </DefaultImageToolbar>
  );
}
