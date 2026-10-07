import { useCallback, useEffect, useRef, useState } from "react";

export default function useVideoGenerationQueue(active) {
  const [queue, setQueue] = useState({ jobs: [], connected: true, error: null });
  const mounted = useRef(false), inFlight = useRef(null);
  const refresh = useCallback(() => {
    if (inFlight.current) return inFlight.current;
    inFlight.current = (async () => {
      try {
        const response = await fetch("/api/video/queue"), value = await response.json();
        if (!response.ok) throw new Error(value.error || "读取生成队列失败");
        if (mounted.current) setQueue(value);
      } catch {
        if (mounted.current) setQueue(current => ({ ...current, connected: false, error: "队列连接暂时中断，正在重新连接…" }));
      } finally { inFlight.current = null; }
    })();
    return inFlight.current;
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (active) refresh();
    const timer = active ? setInterval(refresh, 3000) : null;
    return () => { mounted.current = false; if (timer) clearInterval(timer); };
  }, [active, refresh]);
  return { queue, refresh };
}
