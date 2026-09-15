export const uiCameraOptions = { wheelBehavior: "pan" };

export function installCtrlWheelZoom(editor) {
  const container = editor.getContainer();
  const wheel = event => {
    if (!event.ctrlKey || !event.target?.closest?.('.tl-canvas')) return;
    if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    // Capture before tldraw's gesture handler; passive:false also prevents browser zoom.
    event.preventDefault(); event.stopImmediatePropagation();
    if (!event.deltaY || editor.getCameraOptions().isLocked) return;
    const viewport = editor.getViewportScreenBounds(), camera = editor.getCamera();
    const point = editor.screenToPage({ x: event.clientX, y: event.clientY });
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.h : 1);
    const steps = editor.getCameraOptions().zoomSteps;
    const z = Math.max(steps[0], Math.min(steps.at(-1), camera.z * Math.exp(-Math.max(-100, Math.min(100, pixels)) * Math.log(1.2) / 100)));
    editor.stopCameraAnimation();
    editor.setCamera({ x: (event.clientX - viewport.x) / z - point.x,
      y: (event.clientY - viewport.y) / z - point.y, z });
  };
  container.addEventListener('wheel', wheel, { capture: true, passive: false });
  return () => container.removeEventListener('wheel', wheel, { capture: true });
}
