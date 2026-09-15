import { ANNOTATION_SCALE_BOOST } from "./constants.js";

/** Base arrow scale (zoom-aware) × boost so label text stays readable. */
export function getAnnotationScale(editor) {
  let base = 1;
  try {
    if (editor.user?.getIsDynamicResizeMode?.()) {
      base = 1 / editor.getZoomLevel();
    }
  } catch {
    // ignore
  }
  return base * ANNOTATION_SCALE_BOOST;
}
