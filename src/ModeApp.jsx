import { lazy, Suspense, useState } from "react";
import App from "./App.jsx";
const UiStudio = lazy(() => import("./ui-studio/UiStudio.jsx"));

export default function ModeApp() {
  const [mode, setMode] = useState(() => new URLSearchParams(location.search).get("mode") === "ui" ? "ui" : "canvas");
  const [uiOpened, setUiOpened] = useState(mode === "ui");
  const [canvasOpened, setCanvasOpened] = useState(mode === "canvas");
  function change(value) {
    setMode(value); if (value === "ui") setUiOpened(true); else setCanvasOpened(true);
    const url = new URL(location.href); if (value === "ui") url.searchParams.set("mode", "ui"); else url.searchParams.delete("mode");
    history.replaceState(null, "", url);
  }
  return <div className="dp-mode-root"><nav className="dp-mode-nav" aria-label="工作模式"><strong>DrawPaint</strong>
    <button aria-pressed={mode === "canvas"} onClick={() => change("canvas")}>绘画画布</button>
    <button aria-pressed={mode === "ui"} onClick={() => change("ui")}>素材工坊</button>
    <span>{mode === "ui" ? "效果图 / 组件拆解 / 界面拼装" : "无限画布 / AI 图片 / 标注改图"}</span></nav>
    {canvasOpened && <div className="dp-mode-content" style={{ display: mode === "canvas" ? "block" : "none" }}><App /></div>}
    {uiOpened && <div className="dp-mode-content" style={{ display: mode === "ui" ? "block" : "none" }}><Suspense fallback={<p>正在打开素材工坊…</p>}><UiStudio /></Suspense></div>}
  </div>;
}
