/** Open annotation text+refs dock from tool / edit-guard without prop drilling. */
let openDockHandler = null;

export function setAnnotationDockOpenHandler(handler) {
  openDockHandler = handler;
}

export function requestAnnotationDockOpen(arrowId) {
  if (typeof openDockHandler === "function" && arrowId) {
    openDockHandler(arrowId);
  }
}
