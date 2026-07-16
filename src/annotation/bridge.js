/** Bridge ImageToolbar → App without deep prop drilling. */
let annotationEditHandler = null;

export function setAnnotationEditHandler(handler) {
  annotationEditHandler = handler;
}

export async function requestAnnotationEdit(editor, imageShapeId) {
  if (typeof annotationEditHandler !== "function") {
    throw new Error("标注修改处理器未就绪。");
  }
  return annotationEditHandler(editor, imageShapeId);
}
