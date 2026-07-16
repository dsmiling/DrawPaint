import {
  DefaultColorStyle,
  StateNode,
  createShapeId,
} from "tldraw";
import {
  ANNOTATION_BEND_RATIO,
  ANNOTATION_DEFAULT_COLOR,
  ANNOTATION_LABEL_POSITION,
  ANNOTATION_MAX_BEND,
  ANNOTATION_MIN_BEND,
  ANNOTATION_MIN_LENGTH,
  ANNOTATION_TOOL_ID,
} from "./constants.js";

function getAnnotationColor(editor) {
  const color = editor.getStyleForNextShape(DefaultColorStyle);
  return color === DefaultColorStyle.defaultValue ? ANNOTATION_DEFAULT_COLOR : color;
}

function getDefaultAnnotationArrowBend(dx, dy, scale) {
  const length = Math.hypot(dx, dy);
  if (length === 0) return 0;
  const bend = Math.min(
    Math.max(length * ANNOTATION_BEND_RATIO, ANNOTATION_MIN_BEND * scale),
    ANNOTATION_MAX_BEND * scale,
  );
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? -bend : bend;
  }
  return bend;
}

function unlockGlobalToolLock(editor) {
  if (!editor.getInstanceState().isToolLocked) return;
  editor.updateInstanceState({ isToolLocked: false });
}

function getAnnotationScale(editor) {
  try {
    if (editor.user?.getIsDynamicResizeMode?.()) {
      return 1 / editor.getZoomLevel();
    }
  } catch {
    // ignore
  }
  return 1;
}

/** tldraw 3: enter label edit (Cowart v5 uses startEditingShapeWithRichText). */
export function startEditingAnnotationArrowLabel(editor, arrowId) {
  const shape = editor.getShape(arrowId);
  if (!shape || !editor.canEditShape?.(shape)) {
    if (!shape) return;
  }

  editor.select(arrowId);
  editor.setEditingShape(arrowId);
  try {
    editor.setCurrentTool("select.editing_shape", {
      target: "shape",
      shape,
    });
  } catch {
    editor.setCurrentTool("select");
    editor.setEditingShape(arrowId);
  }
  pinAnnotationArrowLabelPosition(editor, arrowId);
  try {
    editor.getCurrentTool()?.setCurrentToolIdMask?.(ANNOTATION_TOOL_ID);
  } catch {
    // optional
  }
  editor.emit?.("select-all-text", { shapeId: arrowId });
}

export function pinAnnotationArrowLabelPosition(editor, arrowId, attempt = 0) {
  const run = () => {
    const shape = editor.getShape(arrowId);
    if (!shape) return;
    const meta = shape.meta || {};
    if (
      meta.drawpaintAnnotationArrow !== true &&
      meta.cowartAnnotationArrow !== true
    ) {
      return;
    }
    if (shape.props.labelPosition !== ANNOTATION_LABEL_POSITION) {
      editor.updateShapes([
        {
          id: arrowId,
          type: "arrow",
          props: { labelPosition: ANNOTATION_LABEL_POSITION },
        },
      ]);
    }
    if (attempt < 2 && editor.getEditingShapeId() === arrowId) {
      pinAnnotationArrowLabelPosition(editor, arrowId, attempt + 1);
    }
  };
  if (editor.timers?.setTimeout) {
    editor.timers.setTimeout(run, 16);
  } else {
    window.setTimeout(run, 16);
  }
}

class DrawpaintAnnotationIdle extends StateNode {
  static id = "idle";

  onEnter() {
    this.editor.setCursor({ type: "cross", rotation: 0 });
  }

  onPointerDown(info) {
    this.parent.transition("pointing", info);
  }

  onCancel() {
    this.editor.setCurrentTool("select");
  }
}

class DrawpaintAnnotationPointing extends StateNode {
  static id = "pointing";

  arrowId = null;
  markId = "";
  origin = null;

  onEnter() {
    const origin = this.editor.inputs.originPagePoint;
    const scale = getAnnotationScale(this.editor);
    const color = getAnnotationColor(this.editor);
    const arrowId = createShapeId();

    this.arrowId = arrowId;
    this.origin = { x: origin.x, y: origin.y };
    this.markId = this.editor.markHistoryStoppingPoint(`creating_annotation:${arrowId}`);

    this.editor.createShape({
      id: arrowId,
      type: "arrow",
      x: origin.x,
      y: origin.y,
      meta: {
        drawpaintAnnotationArrow: true,
        cowartAnnotationArrow: true,
      },
      props: {
        kind: "arc",
        dash: "draw",
        size: "m",
        fill: "none",
        color,
        labelColor: color,
        bend: 0,
        start: { x: 0, y: 0 },
        end: { x: 1, y: 0 },
        arrowheadStart: "none",
        arrowheadEnd: "arrow",
        text: "",
        labelPosition: ANNOTATION_LABEL_POSITION,
        font: "draw",
        scale,
      },
    });
  }

  onPointerMove() {
    this.updateArrowEnd();
  }

  onPointerUp() {
    this.complete();
  }

  onCancel() {
    this.cancel();
  }

  onInterrupt() {
    this.cancel();
  }

  updateArrowEnd() {
    if (!this.arrowId || !this.origin) return;
    const point = this.editor.inputs.currentPagePoint;
    this.editor.updateShapes([
      {
        id: this.arrowId,
        type: "arrow",
        props: {
          end: {
            x: point.x - this.origin.x,
            y: point.y - this.origin.y,
          },
        },
      },
    ]);
  }

  complete() {
    if (!this.arrowId || !this.origin) {
      this.editor.setCurrentTool(ANNOTATION_TOOL_ID);
      return;
    }

    this.updateArrowEnd();

    const point = this.editor.inputs.currentPagePoint;
    const dx = point.x - this.origin.x;
    const dy = point.y - this.origin.y;
    const length = Math.hypot(dx, dy);

    if (length < ANNOTATION_MIN_LENGTH / this.editor.getZoomLevel()) {
      this.editor.bailToMark(this.markId);
      this.parent.transition("idle");
      return;
    }

    const scale = getAnnotationScale(this.editor);
    this.editor.updateShapes([
      {
        id: this.arrowId,
        type: "arrow",
        props: {
          bend: getDefaultAnnotationArrowBend(dx, dy, scale),
        },
      },
    ]);

    startEditingAnnotationArrowLabel(this.editor, this.arrowId);
  }

  cancel() {
    if (this.arrowId) {
      this.editor.bailToMark(this.markId);
    }
    this.parent.transition("idle");
  }
}

export class DrawpaintAnnotationTool extends StateNode {
  static id = ANNOTATION_TOOL_ID;
  static initial = "idle";

  static children() {
    return [DrawpaintAnnotationIdle, DrawpaintAnnotationPointing];
  }

  onEnter() {
    unlockGlobalToolLock(this.editor);
  }
}

export { unlockGlobalToolLock };
