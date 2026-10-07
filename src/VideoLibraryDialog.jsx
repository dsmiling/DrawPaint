import { useEffect, useRef, useState } from "react";
import { folderDescendants, folderPath } from "../shared/video-library.js";

export default function VideoLibraryDialog({ action, folders, onSubmit, onClose, working }) {
  const dialog = useRef(null), naming = ["create-folder", "rename-folder", "rename-asset"].includes(action.kind);
  const [name, setName] = useState(action.name || "新建文件夹"), [destination, setDestination] = useState(action.parentId || ""), [error, setError] = useState("");
  useEffect(() => { dialog.current.showModal(); if (naming) dialog.current.querySelector("input")?.select(); }, []);
  const title = ({ "create-folder": "新建文件夹", "rename-folder": "重命名文件夹", "move-folder": "移动文件夹", "rename-asset": "重命名素材", "move-assets": `移动 ${action.keys?.length || 1} 个素材` })[action.kind];
  const excluded = action.kind === "move-folder" ? folderDescendants(folders, action.id) : new Set();
  async function submit(event) {
    event.preventDefault(); setError("");
    try { await onSubmit({ action: action.kind, ...(action.id ? { id: action.id } : {}), ...(action.key ? { key: action.key } : {}), ...(action.keys ? { keys: action.keys } : {}), ...(naming ? { name: name.trim(), ...(action.kind === "create-folder" ? { parentId: action.parentId } : {}) } : action.kind === "move-folder" ? { parentId: destination || null } : { folderId: destination || null }) }); }
    catch (cause) { setError(cause.message); }
  }
  return <dialog ref={dialog} className="vs-canvas-dialog" aria-label={title} onCancel={event => { if (working) event.preventDefault(); else onClose(); }}><form onSubmit={submit}><h2>{title}</h2>{naming ? <label>名称<input aria-label="名称" autoFocus required maxLength={action.kind === "rename-asset" ? 100 : 80} value={name} disabled={working} onChange={event => setName(event.target.value)} /></label> : <label>目标文件夹<select aria-label="目标文件夹" value={destination} disabled={working} onChange={event => setDestination(event.target.value)}><option value="">素材库</option>{folders.filter(folder => !excluded.has(folder.id)).map(folder => <option key={folder.id} value={folder.id}>{folderPath(folders, folder.id).map(item => item.name).join(" / ")}</option>)}</select></label>}{error && <p role="alert" className="vs-canvas-error">{error}</p>}<div><button type="button" disabled={working} onClick={onClose}>取消</button><button type="submit" disabled={working || naming && !name.trim()}>{working ? "正在保存…" : "保存"}</button></div></form></dialog>;
}
