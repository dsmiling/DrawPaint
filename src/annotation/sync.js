import { ANNOTATION_LABEL_POSITION } from "./constants.js";

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

/**
 * After finishing annotation label edit: stay on select with the arrow selected
 * so the element-reference dock can appear. (Continuous draw: click 标注 again.)
 */
export function bindAnnotationEditingToolLock(editor) {
  return editor.store.listen(
    ({ changes }) => {
      for (const entry of Object.values(changes.updated || {})) {
        const previous = Array.isArray(entry) ? entry[0] : null;
        const next = Array.isArray(entry) ? entry[1] : entry;
        if (previous?.typeName !== "instance_page_state") continue;
        if (!previous.editingShapeId || next.editingShapeId) continue;

        const arrowId = previous.editingShapeId;
        const shape = editor.getShape(arrowId);
        if (!isAnnotationArrowMeta(shape?.meta)) continue;

        const resume = () => {
          if (editor.getEditingShapeId()) return;
          try {
            editor.setCurrentTool("select");
          } catch {
            // ignore
          }
          editor.select(arrowId);
        };
        if (editor.timers?.requestAnimationFrame) {
          editor.timers.requestAnimationFrame(resume);
        } else {
          requestAnimationFrame(resume);
        }
      }
    },
    { source: "all", scope: "session" },
  );
}
