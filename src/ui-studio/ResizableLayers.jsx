import { useEffect, useRef, useState } from "react";

const storageKey = "drawpaint.ui-studio.layers-width";
const clamp = width => Math.max(185, Math.min(620, width));

export default function ResizableLayers({ children }) {
  const panel = useRef(null), drag = useRef(null);
  const [resizing, setResizing] = useState(false);
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      return Number.isFinite(saved) && saved >= 185 ? clamp(saved) : null;
    } catch { return null; }
  });
  useEffect(() => {
    if (resizing) return;
    try {
      if (width === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, String(width));
    } catch { /* Resizing still works when browser storage is unavailable. */ }
  }, [width, resizing]);
  const finish = event => {
    drag.current = null; setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <div ref={panel} className={`uis-resizable-layers${resizing ? " is-resizing" : ""}`} style={width === null ? undefined : { "--uis-layers-width": `${width}px` }}>
    {children}
    <div className="uis-layer-resizer" role="separator" aria-label="调整左侧栏宽度" aria-orientation="vertical" aria-valuemin={185} aria-valuemax={620} aria-valuenow={width ?? undefined} tabIndex={0}
      title="拖动调整宽度，双击恢复默认" onDoubleClick={() => setWidth(null)}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width: panel.current.getBoundingClientRect().width };
        setResizing(true);
      }}
      onPointerMove={event => { if (drag.current) setWidth(clamp(drag.current.width + event.clientX - drag.current.x)); }}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={() => { drag.current = null; setResizing(false); }}
      onKeyDown={event => {
        const current = panel.current.getBoundingClientRect().width;
        const next = { ArrowLeft: current - 20, ArrowRight: current + 20, Home: 185, End: 620 }[event.key];
        if (next !== undefined) { event.preventDefault(); setWidth(clamp(next)); }
      }} />
  </div>;
}
