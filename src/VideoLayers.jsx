import { useEffect, useState } from "react";
import { durationOf } from "../shared/video-editing.js";
import VideoLibraryPanel from "./VideoLibraryPanel.jsx";
import { videoQueueLabel } from "../shared/video-queue.js";
import { IconButton } from "./UiIcon.jsx";
import { FrameSequenceCanvas } from "./FrameSequencePreview.jsx";

export const sourceUrl = source => source?.type === "job" ? `/api/video/jobs/${source.id}/file` : source ? `/api/video/assets/${source.id}.${source.ext || "mp4"}` : "";
export const assetKey = asset => `${asset.source.type}:${asset.source.id}`;

export default function VideoLayers({ clips, sequences = new Map(), generationJobs, selectedIds, onSelect, onMenu, onChange, onNew, onImport, library, selectedAssetKeys, playingAssetKey, onSelectAsset, onAssetMenu, onRefresh, libraryOpen, setLibraryOpen, folders, folderId, onFolderSelect, onFolderMenu, onFolderDrop, onNewFolder, libraryWorking }) {
  const [query, setQuery] = useState(""), [filter, setFilter] = useState("all");
  useEffect(() => { if (libraryOpen && filter === "draft") setFilter("all"); }, [libraryOpen, filter]);
  const matches = item => (item.name || "").toLowerCase().includes(query.trim().toLowerCase()) && (filter === "all" || filter === "animation" && item.frameAnimation?.enabled || filter === "video" && !item.frameAnimation?.enabled || filter === "draft" && item.status === "draft");
  const items = clips.filter(matches), assets = library.filter(matches);
  return <>
    <div className="vs-left-tabs" role="tablist" aria-label="片段与素材"><button role="tab" aria-selected={!libraryOpen} onClick={() => setLibraryOpen(false)}>画布片段 <span>{clips.length}</span></button><button role="tab" aria-selected={libraryOpen} onClick={() => setLibraryOpen(true)}>视频素材</button></div>
    <div className="vs-left-create"><IconButton icon="newVideo" label="新建片段" className="vs-primary" onClick={onNew} /><IconButton icon="upload" label="导入视频" onClick={onImport} /></div>
    <input className="vs-left-search" aria-label={libraryOpen ? "搜索视频素材" : "搜索画布片段"} placeholder={libraryOpen ? "搜索素材名称…" : "搜索片段名称…"} value={query} onChange={event => setQuery(event.target.value)} />
    <select className="vs-left-filter" aria-label="片段类型筛选" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部类型</option><option value="video">正常视频</option><option value="animation">帧动画视频</option>{!libraryOpen && <option value="draft">待生成片段</option>}</select>
    {libraryOpen ? <VideoLibraryPanel library={library} assets={assets} folders={folders} folderId={folderId} onFolderSelect={onFolderSelect} onFolderMenu={onFolderMenu} onFolderDrop={onFolderDrop} onNewFolder={onNewFolder} selectedAssetKeys={selectedAssetKeys} playingAssetKey={playingAssetKey} onSelectAsset={onSelectAsset} onAssetMenu={onAssetMenu} onRefresh={onRefresh} working={libraryWorking} /> : <div className="vs-layer-list" role="list" aria-label="视频片段列表">
      {!clips.length && <div className="vs-empty-small">点击“新建片段”建立视频节点，再到右侧上传首帧并生成；也可导入或添加已有视频。</div>}
      {clips.length > 0 && !items.length && <div className="vs-empty-small">没有匹配的片段。</div>}
      {[...items].sort((a, b) => a.track - b.track || a.position - b.position).map(clip => <div role="listitem" key={clip.id} className={`vs-layer-row ${selectedIds.includes(clip.id) ? "is-selected" : ""} ${clip.hidden ? "is-hidden" : ""}`}>
        <button className="vs-layer-main" aria-label={`选择片段 ${clip.name}`} aria-pressed={selectedIds.includes(clip.id)} onClick={event => onSelect(clip, "list", event)} onContextMenu={event => onMenu(event, clip)}>
          <span className="vs-layer-thumb">{sequences.get(clip.id) ? <FrameSequenceCanvas sequence={sequences.get(clip.id)} /> : clip.source && clip.status === "completed" ? <video src={sourceUrl(clip.source)} preload="metadata" muted playsInline /> : clip.firstImageId ? <img src={`/api/video/reference-images/${clip.firstImageId}.png`} alt="" /> : <span>{clip.status === "draft" ? "＋" : "◌"}</span>}</span>
          <span className="vs-layer-meta"><b title={clip.name}>{clip.name || "未命名片段"}</b><small>{sequences.get(clip.id) ? `序列帧 · ${sequences.get(clip.id).manifest.frameCount} 帧` : clip.status === "draft" ? "待生成" : clip.status === "running" ? videoQueueLabel(generationJobs?.get(clip.source?.id)) : clip.status === "failed" ? "失败" : clip.frameAnimation?.enabled ? "帧动画" : "视频"} · V{clip.track + 1} · {durationOf(clip).toFixed(1)} 秒</small></span>
        </button><div className="vs-layer-controls"><button aria-label={`${clip.hidden ? "显示" : "隐藏"}片段 ${clip.name}`} aria-pressed={Boolean(clip.hidden)} title="控制时间线预览与导出显隐" onClick={() => onChange(clip.id, { hidden: !clip.hidden })}>{clip.hidden ? "◌" : "◉"}</button><button aria-label={`${clip.locked ? "解锁" : "锁定"}片段 ${clip.name}`} aria-pressed={Boolean(clip.locked)} onClick={() => onChange(clip.id, { locked: !clip.locked })}>{clip.locked ? "▣" : "◇"}</button></div>
      </div>)}
    </div>}
  </>;
}
