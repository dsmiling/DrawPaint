// Tldraw installs shortcuts on document.body while its editor is focused.
// Panel and dialog keys must never reach that listener.
export function isolatePanelKey(event) {
  if (!event.target?.closest?.(".tl-container")) event.stopPropagation();
}

export function blurCanvasForPanel(event, editor) {
  if (!event.target?.closest?.(".tl-container")) editor?.blur();
}
