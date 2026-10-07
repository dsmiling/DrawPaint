const paths = {
  brush: "M14 3l7 7-9 9-7-7zM5 12l-2 9 9-2M14 3l-2 2M19 8l2 2",
  assets: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  video: "M3 5h18v14H3zM3 9h18M7 5v4M12 5v4M17 5v4M10 12l5 2-5 2z",
  select: "M4 3l15 10-7 1-3 7z",
  hand: "M8 12V6a2 2 0 0 1 4 0v6M12 10V4a2 2 0 0 1 4 0v8M16 10V7a2 2 0 0 1 4 0v9c0 4-2 6-6 6h-2c-2 0-3-1-4-3l-5-6a2 2 0 0 1 3-3l2 2",
  undo: "M8 4L3 9l5 5M3 9h11a6 6 0 0 1 0 12",
  redo: "M16 4l5 5-5 5M21 9H10a6 6 0 0 0 0 12",
  arrange: "M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h6v6h-6zM9 6h6M6 9v6M18 9v6M9 18h6",
  magnet: "M5 3v9a7 7 0 0 0 14 0V3h-5v9a2 2 0 0 1-4 0V3zM5 7h5M14 7h5",
  minus: "M5 12h14", plus: "M5 12h14M12 5v14",
  fit: "M9 3H3v6M15 3h6v6M3 15v6h6M21 15v6h-6M8 8h8v8H8z",
  nodes: "M3 3h7v7H3zM14 14h7v7h-7zM10 6h7v8M6 10v7h8",
  preview: "M3 4h18v16H3zM10 8l6 4-6 4z",
  play: "M8 4l12 8-12 8z", pause: "M7 4v16M17 4v16",
  rewind: "M5 4v16M19 5l-10 7 10 7z", next: "M19 4v16M5 5l10 7-10 7z",
  newVideo: "M3 5h11v14H3zM14 10l7-4v12l-7-4M6 12h5M8.5 9.5v5",
  upload: "M12 16V3M7 8l5-5 5 5M3 15v6h18v-6",
  download: "M12 3v13M7 11l5 5 5-5M3 15v6h18v-6",
  frames: "M8 3h13v13M3 8h13v13H3zM6 12h7M6 16h7",
  newCanvas: "M3 3h18v18H3zM12 7v10M7 12h10",
  rename: "M4 16l-1 5 5-1L21 7l-4-4zM14 6l4 4",
  save: "M3 3h15l3 3v15H3zM7 3v6h10V3M7 21v-7h10v7",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5",
  moon: "M20 15a9 9 0 0 1-11-11 9 9 0 1 0 11 11",
  grip: "M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01",
  lock: "M7 10V7a5 5 0 0 1 10 0v3M4 10h16v11H4zM12 14v3",
  hidden: "M3 3l18 18M10 5a12 12 0 0 1 11 7 13 13 0 0 1-4 5M14 19a12 12 0 0 1-11-7 13 13 0 0 1 4-5M10 10a3 3 0 0 0 4 4",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l3 2",
  pending: "M4 4h16M4 20h16M6 4v4l6 4-6 4v4M18 4v4l-6 4 6 4v4",
  queue: "M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01",
  warning: "M12 3L2 21h20zM12 9v5M12 17h.01",
  split: "M12 3v18M4 7l4 5-4 5M20 7l-4 5 4 5",
  close: "M6 6l12 12M18 6L6 18",
};

export default function UiIcon({ name, size = 18, className }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === "grip" ? 3 : 1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

export function IconButton({ icon, label, shortcut, className = "", ...props }) {
  return <button type="button" className={`dp-icon-button ${className}`} aria-label={label} title={shortcut ? `${label} · ${shortcut}` : label} {...props}><UiIcon name={icon} /></button>;
}
