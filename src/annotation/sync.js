import { ANNOTATION_LABEL_POSITION } from "./constants.js";
import { requestAnnotationDockOpen } from "./dockBridge.js";

function isAnnotationArrowMeta(meta) {
  return meta?.drawpaintAnnotationArrow === true || meta?.cowartAnnotationArrow === true;
}

/** Pin labelPosition + sync labelColor for annotation arrows (Cowart). */
export function bindAnnotationShapeSync(editor) {
  let syncing = false;
  return editor.store.listen(
    ({ changes }) => {
      if (syncing) return;
      const updates = [];
      for (const entry of Object.values(changes.updated || {})) {
        const next = Array.isArray(entry) ? entry[1] : entry;
        if (next?.typeName !== "shape" || next.type !== "arrow") continue;
        if (!isAnnotationArrowMeta(next.meta)) continue;

        const props = {};
        if (next.props?.color !== next.props?.labelColor) {
          props.labelColor = next.props.color;
        }
        if (next.props?.labelPosition !== ANNOTATION_LABEL_POSITION) {
          props.labelPosition = ANNOTATION_LABEL_POSITION;
        }
        if (Object.keys(props).length === 0) continue;
        updates.push({ id: next.id, type: "arrow", props });
      }
      if (!updates.length) return;
      syncing = true;
      try {
        editor.updateShapes(updates);
      } finally {
        syncing = false;
      }
    },
    { source: "all", scope: "document" },
  );
}

function openAnnotationDockFor(editor, arrowId) {
  try {
    editor.setEditingShape(null);
  } catch {
    // ignore
  }
  try {
    editor.setCurrentTool("select");
  } catch {
    // ignore
  }
  editor.select(arrowId);
  requestAnnotationDockOpen(arrowId);
}

/**
 * Annotation arrow labels are read-only on-canvas.
 * Any attempt to edit the label (double-click / Enter) opens the dock instead.
 */
export function bindAnnotationEditingToolLock(editor) {
  const unsubEdit = editor.store.listen(
    ({ changes }) => {
      for (const entry of Object.values(changes.updated || {})) {
        const previous = Array.isArray(entry) ? entry[0] : null;
        const next = Array.isArray(entry) ? entry[1] : entry;
        if (previous?.typeName !== "instance_page_state") continue;

        const editingId = next?.editingShapeId;
        if (!editingId || previous.editingShapeId === editingId) continue;

        const shape = editor.getShape(editingId);
        if (!isAnnotationArrowMeta(shape?.meta)) continue;

        const run = () => openAnnotationDockFor(editor, editingId);
        if (editor.timers?.requestAnimationFrame) {
          editor.timers.requestAnimationFrame(run);
        } else {
          requestAnimationFrame(run);
        }
      }
    },
    { source: "all", scope: "session" },
  );

  // Double-click arrow body (not only label) also opens the dock.
  const onEvent = (info) => {
    if (info?.type !== "click" || info?.name !== "double_click") return;
    if (info.phase && info.phase !== "up" && info.phase !== "settle") return;

    let shape = info.target === "shape" ? info.shape : null;
    if (!shape && info.target === "selection") {
      const only = editor.getSelectedShapes();
      if (only.length === 1) shape = only[0];
    }
    if (!shape || shape.type !== "arrow" || !isAnnotationArrowMeta(shape.meta)) {
      return;
    }
    openAnnotationDockFor(editor, shape.id);
  };

  editor.on?.("event", onEvent);

  return () => {
    unsubEdit?.();
    editor.off?.("event", onEvent);
  };
}
