import { useEffect, useState } from "react";

export default function useVideoSequences(canvasId, active, completedExportId) {
  const [sequences, setSequences] = useState([]), [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false, controller;
    const refresh = async () => {
      controller?.abort(); controller = new AbortController();
      try {
        const response = await fetch(`/api/video/sequences?canvasId=${encodeURIComponent(canvasId)}`, { signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "无法读取已生成的帧动画");
        if (!cancelled) { setSequences(result.sequences); setError(""); }
      } catch (cause) { if (!cancelled && cause.name !== "AbortError") setError(cause.message); }
    };
    refresh();
    const timer = active ? setInterval(refresh, 5000) : null;
    return () => { cancelled = true; controller?.abort(); clearInterval(timer); };
  }, [canvasId, active, completedExportId]);
  return { sequences, error };
}
