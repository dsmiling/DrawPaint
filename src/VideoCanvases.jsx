import { useEffect, useRef, useState } from "react";
import VideoWorkspace from "./VideoStudio.jsx";
import { IconButton } from "./UiIcon.jsx";

async function request(url, options) {
  const response = await fetch(url, options), value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}
const jsonOptions = (method, value) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });

export default function VideoCanvases({ canvasImage, active = true }) {
  const [canvases, setCanvases] = useState([]), [canvasId, setCanvasId] = useState(null);
  const [state, setState] = useState({ status: "loading", busy: false, ready: false });
  const [working, setWorking] = useState(false), [error, setError] = useState("");
  const [naming, setNaming] = useState(null), [name, setName] = useState("");
  const [incomingImage, setIncomingImage] = useState(null);
  const workspace = useRef(null), activeAction = useRef(false), dialog = useRef(null);
  const clipboardRef = useRef([]);
  const current = canvases.find(item => item.id === canvasId);

  async function loadCanvases() {
    try {
      const result = await request("/api/video/canvases");
      setCanvases(result.canvases); setError("");
      setCanvasId(previous => {
        let remembered;
        try { remembered = localStorage.getItem("drawpaint.video-studio.canvas"); } catch { /* Optional preference. */ }
        const linked = new URLSearchParams(location.search).get("canvasId");
        const requested = previous || linked || remembered;
        return result.canvases.some(item => item.id === requested) ? requested : "default";
      });
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { loadCanvases(); }, []);
  useEffect(() => {
    if (!canvasId) return;
    try { localStorage.setItem("drawpaint.video-studio.canvas", canvasId); } catch { /* Saving still works. */ }
  }, [canvasId]);
  useEffect(() => { if (canvasImage) setIncomingImage(canvasImage); }, [canvasImage]);
  useEffect(() => { if (naming) { dialog.current?.showModal(); dialog.current?.querySelector("input")?.select(); } }, [naming]);

  function saved(project) {
    setCanvases(items => items.map(item => item.id === project.id ? { ...item, name: project.name, width: project.width, height: project.height, clipCount: project.clips.length, updatedAt: project.updatedAt } : item));
  }
  async function run(action) {
    if (activeAction.current) return;
    activeAction.current = true; setWorking(true); setError("");
    try { await workspace.current.flush(); await action(); }
    catch (e) { setError(e.message); }
    finally { activeAction.current = false; setWorking(false); }
  }
  async function switchCanvas(id) {
    if (id === canvasId) return;
    await run(async () => { setIncomingImage(null); setState({ status: "loading", busy: false, ready: false }); setCanvasId(id); });
  }
  function openName(kind) {
    setName(kind === "rename" ? current.name : `画布 ${canvases.length + 1}`); setNaming(kind);
  }
  async function submitName(event) {
    event.preventDefault();
    await run(async () => {
      if (naming === "new") {
        const project = await request("/api/video/canvases", jsonOptions("POST", { name: name.trim() }));
        setCanvases(items => [...items, { ...project, clipCount: 0 }]);
        setIncomingImage(null); setState({ status: "loading", busy: false, ready: false }); setCanvasId(project.id);
      } else {
        const project = await request(`/api/video/canvases/${canvasId}`, jsonOptions("PATCH", { name: name.trim() }));
        saved(project);
      }
      setNaming(null);
    });
  }
  const disabled = working || state.busy || !state.ready;
  const nameDialog = naming && <dialog ref={dialog} className="vs-canvas-dialog" onCancel={event => { if (working) event.preventDefault(); else setNaming(null); }}>
    <form onSubmit={submitName}><h2>{naming === "new" ? "新建视频画布" : "重命名画布"}</h2><label>画布名称<input autoFocus required maxLength={80} value={name} disabled={working} onChange={event => setName(event.target.value)} /></label>
      <p>{naming === "new" ? "每个画布分别保存片段、时间线和首尾帧设置。" : "修改名称后，画布中的片段和时间线继续保留。"}</p>
      {error && <p role="alert" className="vs-canvas-error">{error}</p>}<div><button type="button" disabled={working} onClick={() => setNaming(null)}>取消</button><button type="submit" disabled={working || !name.trim()}>{working ? "正在保存…" : naming === "new" ? "创建画布" : "保存名称"}</button></div>
    </form>
  </dialog>;
  const toolbar = <div className="vs-canvas-toolbar" aria-label="视频画布管理">
    <label>画布 <select aria-label="选择视频画布" value={canvasId || ""} disabled={disabled} onChange={event => switchCanvas(event.target.value)}>{canvases.map(item => <option key={item.id} value={item.id}>{item.name} · {item.clipCount} 个片段</option>)}</select></label>
    <IconButton icon="newCanvas" label="新建画布" disabled={disabled} onClick={() => openName("new")} />
    <IconButton icon="rename" label="重命名画布" disabled={disabled} onClick={() => openName("rename")} />
    <IconButton icon="save" label="保存画布" disabled={disabled} onClick={() => run(async () => {})} />
    <span className={`vs-canvas-save ${state.status === "error" ? "is-error" : ""}`} role="status">{working ? "正在保存…" : { loading: "正在加载…", dirty: "待保存", saving: "正在保存…", saved: "已保存 · 自动保存", error: "保存失败" }[state.status]}</span>
    {error && <span className="vs-canvas-error" role="alert">{error}</span>}
    {nameDialog}
  </div>;
  if (!canvasId) return <div className="vs-shell"><div className="vs-notice">{error || "正在加载视频画布…"}{error && <button onClick={loadCanvases}>重试</button>}</div></div>;
  return <VideoWorkspace key={canvasId} ref={workspace} canvasId={canvasId} canvasName={current?.name || "画布"} canvasImage={incomingImage} canvasToolbar={toolbar} locked={working} onState={setState} onSaved={saved} active={active} clipboardRef={clipboardRef} />;
}
