import { useEffect, useState } from "react";

const storageKeys = {
  canvas: "drawpaint.canvas.image-provider",
  "ui-studio": "drawpaint.ui-studio.image-provider",
};

export default function useImageProvider(mode) {
  const key = storageKeys[mode];
  const [provider, setProvider] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      if (saved !== null) return saved === "qwen" ? "qwen" : "agent";
      // Migrate only this mode's existing preference; never copy another mode.
      if (mode === "ui-studio") {
        const draft = JSON.parse(localStorage.getItem("drawpaint.ui-studio.draft") || "null");
        if (draft?.imageProvider === "qwen") return "qwen";
      }
    } catch { /* A mode remains usable when browser storage is unavailable. */ }
    return "agent";
  });
  useEffect(() => {
    try { localStorage.setItem(key, provider); } catch { /* Keep the current mode's in-memory choice. */ }
  }, [key, provider]);
  return [provider, setProvider];
}
