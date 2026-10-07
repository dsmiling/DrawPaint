import { lazy, Suspense, useEffect, useState } from "react";
import App from "./App.jsx";
import VideoStudio from "./VideoCanvases.jsx";
import { IconButton } from "./UiIcon.jsx";
const UiStudio = lazy(() => import("./ui-studio/UiStudio.jsx"));

export default function ModeApp() {
  const [mode, setMode] = useState(() => ["ui", "video"].includes(new URLSearchParams(location.search).get("mode")) ? new URLSearchParams(location.search).get("mode") : "canvas");
  const [uiOpened, setUiOpened] = useState(mode === "ui");
  const [canvasOpened, setCanvasOpened] = useState(mode === "canvas");
  const [videoOpened, setVideoOpened] = useState(mode === "video");
  const [canvasImage, setCanvasImage] = useState(null);
  useEffect(() => {
    const onUseImage = event => { setCanvasImage(event.detail); change("video"); };
    window.addEventListener("drawpaint:video-image", onUseImage);
    return () => window.removeEventListener("drawpaint:video-image", onUseImage);
  }, []);
  function change(value) {
    setMode(value); if (value === "ui") setUiOpened(true); else if (value === "canvas") setCanvasOpened(true); else if (value === "video") setVideoOpened(true);
    const url = new URL(location.href); if (value !== "canvas") url.searchParams.set("mode", value); else url.searchParams.delete("mode");
    history.replaceState(null, "", url);
  }
  return <div className="dp-mode-root"><nav className="dp-mode-nav" aria-label="工作模式"><strong>DrawPaint</strong>
    <IconButton icon="brush" label="绘画画布" aria-pressed={mode === "canvas"} onClick={() => change("canvas")} />
    <IconButton icon="assets" label="素材工坊" aria-pressed={mode === "ui"} onClick={() => change("ui")} />
    <IconButton icon="video" label="视频工坊" aria-pressed={mode === "video"} onClick={() => change("video")} />
    </nav>
    {canvasOpened && <div className="dp-mode-content" style={{ display: mode === "canvas" ? "block" : "none" }}><App /></div>}
    {uiOpened && <div className="dp-mode-content" style={{ display: mode === "ui" ? "block" : "none" }}><Suspense fallback={<p>正在打开素材工坊…</p>}><UiStudio /></Suspense></div>}
    {videoOpened && <div className="dp-mode-content" style={{ display: mode === "video" ? "block" : "none" }}><VideoStudio canvasImage={canvasImage} active={mode === "video"} /></div>}
  </div>;
}
