import { useEffect, useRef, useState } from "react";
import { folderDescendants, folderPath, videoAssetKey } from "../shared/video-library.js";

export function FolderIcon({ open = false }) {
  return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true"><path d={open ? "M3 9V5h7l2 2h9v3M3 9h19l-3 10H3z" : "M3 5h7l2 2h9v12H3z"} /></svg>;
}
function Preview({ item, playing }) {
  const ref = useRef(null);
  useEffect(() => { const video = ref.current; if (video) { if (playing) video.play().catch(() => {}); else video.pause(); } }, [playing]);
  const url = item.source.type === "job" ? `/api/video/jobs/${item.source.id}/file` : `/api/video/assets/${item.source.id}.${item.source.ext || "mp4"}`;
  return <video ref={ref} src={url} preload="metadata" muted playsInline loop />;
}

export default function VideoLibraryPanel({ library, assets, folders, folderId, onFolderSelect, onFolderMenu, onFolderDrop, onNewFolder, selectedAssetKeys, playingAssetKey, onSelectAsset, onAssetMenu, onRefresh, working }) {
  const [refreshing, setRefreshing] = useState(false), [collapsed, setCollapsed] = useState(new Set()), [dropTarget, setDropTarget] = useState(undefined);
  useEffect(() => { const ancestors = folderPath(folders, folderId).map(folder => folder.parentId); setCollapsed(current => new Set([...current].filter(id => !ancestors.includes(id)))); }, [folderId, folders]);
  async function refresh() { setRefreshing(true); try { await onRefresh(); } finally { setRefreshing(false); } }
  const destination = folderId === "root" ? null : folderId;
  const visible = folderId === "all" ? assets : assets.filter(item => (item.folderId ?? null) === destination);
  const children = folderId === "all" ? [] : folders.filter(folder => folder.parentId === destination);
  const count = id => { const ids = folderDescendants(folders, id); return library.filter(item => ids.has(item.folderId ?? null)).length; };
  const dragTarget = id => ({
    onDragOver: event => { if (working) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = event.dataTransfer.types.includes("Files") ? "copy" : "move"; setDropTarget(id); },
    onDragLeave: event => { if (!event.currentTarget.contains(event.relatedTarget)) setDropTarget(undefined); },
    onDrop: event => { event.preventDefault(); event.stopPropagation(); setDropTarget(undefined); onFolderDrop(event, id); },
  });
  const renderFolder = (id, name, depth = 1) => {
    const nested = folders.filter(folder => folder.parentId === id), expanded = !collapsed.has(id);
    return <div key={id ?? "root"}>
      <div role="treeitem" aria-label={`文件夹 ${name}`} aria-level={depth} aria-selected={folderId === (id ?? "root")} aria-expanded={nested.length ? expanded : undefined} className={`vs-folder-row ${folderId === (id ?? "root") ? "is-selected" : ""} ${dropTarget === id ? "is-drop-target" : ""}`} style={{ paddingLeft: 4 + (depth - 1) * 13 }} tabIndex={0} draggable={id !== null} onClick={() => onFolderSelect(id ?? "root")} onContextMenu={event => onFolderMenu(event, id)} onKeyDown={event => { event.stopPropagation(); if (["Enter", "ArrowLeft", "ArrowRight"].includes(event.key)) event.preventDefault(); if (event.key === "Enter") onFolderSelect(id ?? "root"); if (event.key === "ArrowRight" || event.key === "ArrowLeft") setCollapsed(current => { const next = new Set(current); if (event.key === "ArrowLeft") next.add(id); else next.delete(id); return next; }); if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") onFolderMenu(event, id); }} onDragStart={event => { event.stopPropagation(); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-drawpaint-video-folder", id); }} {...dragTarget(id)}>
        <button type="button" className="vs-folder-toggle" aria-label={`${expanded ? "收起" : "展开"}文件夹 ${name}`} tabIndex={-1} disabled={!nested.length} onClick={event => { event.stopPropagation(); setCollapsed(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }}>{nested.length ? expanded ? "▾" : "▸" : ""}</button><FolderIcon open={expanded && Boolean(nested.length)} /><span>{name}</span><small>{count(id)}</small>
      </div>{expanded && nested.length > 0 && <div role="group">{nested.map(folder => renderFolder(folder.id, folder.name, depth + 1))}</div>}
    </div>;
  };
  return <div className="vs-library" aria-label="视频素材库">
    <div className="vs-folder-tree" role="tree" aria-label="视频素材目录"><div role="treeitem" aria-label="全部素材" aria-selected={folderId === "all"} className={`vs-folder-row ${folderId === "all" ? "is-selected" : ""}`} tabIndex={0} onClick={() => onFolderSelect("all")} onKeyDown={event => { event.stopPropagation(); if (event.key === "Enter") onFolderSelect("all"); }}><span className="vs-folder-all">▦</span><span>全部素材</span><small>{library.length}</small></div>{renderFolder(null, "素材库")}</div>
    <nav className="vs-folder-breadcrumb" aria-label="当前素材目录">{folderId === "all" ? <span>全部素材</span> : <><button onClick={() => onFolderSelect("root")}>素材库</button>{folderPath(folders, destination).map(folder => <span key={folder.id}> / <button onClick={() => onFolderSelect(folder.id)}>{folder.name}</button></span>)}</>}</nav>
    <div className="vs-library-heading"><span aria-label={`视频素材数量 ${visible.length}`}>{visible.length}{selectedAssetKeys.length > 1 ? ` · 已选 ${selectedAssetKeys.length}` : ""}</span><div><button type="button" className="vs-library-refresh" aria-label="新建素材文件夹" title="新建文件夹" disabled={working} onClick={onNewFolder}><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 5h7l2 2h9v12H3zM12 10v6M9 13h6" /></svg></button><button type="button" className={`vs-library-refresh ${refreshing ? "is-refreshing" : ""}`} aria-label="刷新视频素材" title="刷新" disabled={refreshing || working} onClick={refresh}><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 17.9 17" /></svg></button></div></div>
    {children.map(folder => <button key={folder.id} className={`vs-library-folder ${dropTarget === folder.id ? "is-drop-target" : ""}`} aria-label={`打开文件夹 ${folder.name}`} onClick={() => onFolderSelect(folder.id)} onContextMenu={event => onFolderMenu(event, folder.id)} {...dragTarget(folder.id)}><FolderIcon /><span>{folder.name}</span><small>{count(folder.id)}</small></button>)}
    {visible.map((item, index) => <article key={videoAssetKey(item)} data-source-key={videoAssetKey(item)} role="button" tabIndex={0} draggable={!working} aria-label={`选择视频素材 ${index + 1}：${item.name || "生成视频"}`} aria-pressed={selectedAssetKeys.includes(videoAssetKey(item))} className={`vs-library-item ${selectedAssetKeys.includes(videoAssetKey(item)) ? "is-selected" : ""}`} onClick={event => onSelectAsset(item, event)} onContextMenu={event => onAssetMenu(event, item)} onDragStart={event => { const keys = selectedAssetKeys.includes(videoAssetKey(item)) ? selectedAssetKeys : [videoAssetKey(item)]; event.dataTransfer.effectAllowed = "copyMove"; event.dataTransfer.setData("application/x-drawpaint-video-assets", JSON.stringify(keys)); }} onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape" || event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectAsset(item, event.key === "Escape" ? undefined : event); } if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") onAssetMenu(event, item); }}>
      {item.status === "completed" ? <Preview item={item} playing={playingAssetKey === videoAssetKey(item)} /> : <span className="vs-library-pending" aria-label={item.status === "running" ? "生成中" : "暂不可用"}>{item.status === "running" ? <span className="vs-library-spinner" /> : "◷"}</span>}
    </article>)}
    {!visible.length && !children.length && <div className="vs-library-empty" aria-label="文件夹为空"><FolderIcon /></div>}
  </div>;
}
