import { updateLayerDocument } from "./document-edits.js";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useValue } from "tldraw";
import { assetUrl, uiApi } from "./api.js";
import { buildLayerTree, flattenLayerTree, layerTreeForShapes, searchLayerTree, nodeKey, sliceForShape, moveLayerNode } from "./layer-tree.js";
import { selectUiNode, uiNodeShapes, uiNodeVisible, setUiNodeVisible, uiShapePage } from "./canvas.js";
import NodeInspector from "./NodeInspector.jsx";
import { hierarchyVisibility } from "./visibility.js";
import { canvasResult } from "../../shared/ui-delivery.mjs";
import { trackCoordinateOrigins } from "./coordinates.js";
import { duplicateUiNode, deleteUiNode, updateCopyMetadata } from "./layer-actions.js";

export default function LayerPanel({ jobs, editor, ready, busy, onRefine, onSelect, onError, onRefresh }) {
  const [normalCollapsed, setNormalCollapsed] = useState(new Set());
  const [query, setQuery] = useState("");
  const [searchCollapsed, setSearchCollapsed] = useState(new Set());
  const searching = Boolean(query.trim());
  const collapsed = searching ? searchCollapsed : normalCollapsed;
  const setCollapsed = searching ? setSearchCollapsed : setNormalCollapsed;
  const [focused, setFocused] = useState(null);
  const [menu, setMenu] = useState(null);
  const menuRef = useRef(null);
  const treeRef = useRef(null), revealedSelection = useRef(null), pendingReveal = useRef(null);
  const dragRef = useRef(null), renameSaving = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [drop, setDrop] = useState(null), [rename, setRename] = useState(null);
  const [treeSelection, setTreeSelection] = useState(null);
  useEffect(() => {
    if (!menu) return;
    const element = menuRef.current;
    if (element) {
      const rect = element.getBoundingClientRect();
      element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))}px`;
      element.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
    }
    const close = () => setMenu(null);
    const pointer = event => { if (!menuRef.current?.contains(event.target)) close(); };
    const key = event => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); close();
        document.getElementById(`layer-${nodeKey(menu.node)}`)?.focus();
      }
    };
    window.addEventListener("pointerdown", pointer, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", close);
    const scroll = event => { if (!menuRef.current?.contains(event.target)) close(); };
    window.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("pointerdown", pointer, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [menu]);
  const selected = useValue("UI layer selection", () => editor?.getSelectedShapes() || [], [editor]);
  const layout = useValue("UI hierarchy layout", () => editor?.getDocumentSettings().meta.uiHierarchy || {}, [editor]);
  const edits = useValue("UI layer copies and deletions", () => editor?.getDocumentSettings().meta.uiLayerEdits || {}, [editor]);
  const roots = useMemo(() => buildLayerTree(jobs, layout, edits), [jobs, layout, edits]);
  const pageId = useValue("UI layer page", () => editor?.getCurrentPageId(), [editor]);
  const pageRoots = useValue("UI current page layers", () => layerTreeForShapes(roots, editor?.getCurrentPageShapes() || []), [editor, roots]);
  const allNodes = flattenLayerTree(roots).map(r => r.node);
  const visibility = useValue("UI hierarchy visibility", () => Object.fromEntries(allNodes.map(n => [nodeKey(n), uiNodeVisible(editor, n)])), [editor, roots]);
  const filteredRoots = useMemo(() => searchLayerTree(pageRoots, query), [pageRoots, query]);
  const rows = flattenLayerTree(filteredRoots, collapsed);
  const branchKeys = flattenLayerTree(filteredRoots).filter(({ node }) => node.children.length).map(({ node }) => nodeKey(node));
  function changeQuery(value) {
    setQuery(value); setSearchCollapsed(new Set()); setFocused(null); setMenu(null);
  }
  function expandAll() {
    setCollapsed(previous => new Set([...previous].filter(key => !branchKeys.includes(key))));
  }
  function collapseAll() {
    setCollapsed(previous => new Set([...previous, ...branchKeys]));
  }
  useEffect(() => {
    setMenu(null); setRename(null); setDrop(null); setFocused(null); setTreeSelection(null);
    dragRef.current = null; setDragging(false);
  }, [pageId]);
  const sameJob = selected.length && selected[0].meta?.uiJobId && selected.every(s => s.meta?.uiJobId === selected[0].meta.uiJobId && s.meta?.uiRevision === selected[0].meta.uiRevision);
  const active = sameJob ? selected.length === 1 ? selected[0].meta : { uiJobId: selected[0].meta.uiJobId, uiRevision: selected[0].meta.uiRevision } : null;
  const selectedTreeNode = allNodes.find(n => nodeKey(n) === treeSelection);
  const treeShapes = selectedTreeNode ? uiNodeShapes(editor, selectedTreeNode).filter(s => uiShapePage(editor, s) === editor.getCurrentPageId()) : [];
  const matchesTree = treeShapes.length > 0 && treeShapes.length === selected.length && treeShapes.every(s => selected.some(p => p.id === s.id));
  const canvasNode = selected.length === 1 && selected[0].meta?.uiNodeKey ? allNodes.find(n => nodeKey(n) === selected[0].meta.uiNodeKey) : null;
  const resolvedNode = matchesTree ? selectedTreeNode : canvasNode;
  const activeJob = resolvedNode ? resolvedNode.job : active && jobs.map(canvasResult).find(j => j.id === active.uiJobId && j.revision === active.uiRevision);
  // Legacy canvas snapshots identify slices by name rather than sliceId.
  const activeSlice = resolvedNode ? resolvedNode.slice : sliceForShape(activeJob, active);
  const activeKey = resolvedNode ? nodeKey(resolvedNode) : activeJob && nodeKey({ jobId: activeJob.id, revision: activeJob.revision, sliceId: activeSlice?.id });
  const activeNode = allNodes.find(n => nodeKey(n) === activeKey);
  const parentNode = allNodes.find(n => n.children.some(child => nodeKey(child) === activeKey));
  const selectionIdentity = JSON.stringify([pageId, activeKey, selected.map(shape => shape.id).sort()]);
  useLayoutEffect(() => {
    if (!activeKey) { revealedSelection.current = null; pendingReveal.current = null; return; }
    // Reveal once per selection, so manual scrolling/collapsing and canvas dragging stay usable.
    if (revealedSelection.current === selectionIdentity) return;
    const findPath = (nodes, ancestors = []) => {
      for (const node of nodes) {
        const key = nodeKey(node);
        if (key === activeKey) return ancestors;
        const path = findPath(node.children, [...ancestors, key]);
        if (path) return path;
      }
      return null;
    };
    const ancestors = findPath(pageRoots);
    if (!ancestors) return;
    revealedSelection.current = selectionIdentity;
    pendingReveal.current = activeKey;
    // Clear a search only when it would hide the newly selected canvas image.
    const filteredOut = !findPath(filteredRoots);
    if (filteredOut) changeQuery("");
    const updateCollapsed = filteredOut ? setNormalCollapsed : setCollapsed;
    updateCollapsed(previous => {
      if (!ancestors.some(key => previous.has(key))) return previous;
      const next = new Set(previous);
      ancestors.forEach(key => next.delete(key));
      return next;
    });
    setFocused(activeKey);
  }, [selectionIdentity, activeKey, pageRoots, filteredRoots, setCollapsed]);
  useLayoutEffect(() => {
    const key = pendingReveal.current, container = treeRef.current;
    if (!key || !container) return;
    const row = document.getElementById(`layer-${key}`);
    if (!row || !container.contains(row)) return;
    const bounds = container.getBoundingClientRect(), target = row.getBoundingClientRect();
    if (target.top < bounds.top || target.bottom > bounds.bottom) {
      container.scrollTop += target.top - bounds.top - (container.clientHeight - target.height) / 2;
    }
    pendingReveal.current = null;
  }, [rows]);
  const activeNodeRef = useRef(null);
  activeNodeRef.current = activeNode;
  useEffect(() => {
    if (editor && ready) return trackCoordinateOrigins(editor, roots, () => activeNodeRef.current);
  }, [editor, ready, roots]);
  const tabStop = rows.some(r => nodeKey(r.node) === focused) ? focused : rows.some(r => nodeKey(r.node) === activeKey) ? activeKey : (rows[0] && nodeKey(rows[0].node));
  const toggle = key => setCollapsed(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  function select(node) {
    node = flattenLayerTree(pageRoots).find(r => nodeKey(r.node) === nodeKey(node))?.node || node;
    setFocused(nodeKey(node)); setTreeSelection(nodeKey(node)); onSelect(node.jobId);
    if (ready && node.job.status !== "ready" && !node.job.canvasCandidate) { editor.selectNone(); return; }
    if (ready && (node.job.status === "ready" || node.job.canvasCandidate) && !selectUiNode(editor, node)) onError("该节点已从画布移除，可在任务记录中恢复。");
  }
  function startRename(node) {
    if (!ready || node.job.status !== "ready") { onError("该任务尚无可编辑素材"); return; }
    select(node); editor.blur(); setRename({ node, value: node.name });
  }
  async function commitRename() {
    if (!rename || renameSaving.current) return;
    const name = rename.value.trim(), node = rename.node;
    if (!name) { onError("名称不能为空"); return; }
    if (name === node.name) { setRename(null); return; }
    renameSaving.current = true;
    try {
      if (node.instanceKey) updateCopyMetadata(editor, node, { name });
      else await uiApi(`jobs/${node.jobId}/metadata`, { revision: node.revision, metadataRevision: node.job.metadataRevision || 0,
        ...(node.slice ? { slices: [{ id: node.sliceId, name }] } : { presetName: name }) });
      setRename(null); await onRefresh();
    } catch (error) { onError(error.message); } finally { renameSaving.current = false; }
  }
  function dragOver(event, node) {
    if (!dragRef.current || !ready) return;
    event.preventDefault(); event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect(), ratio = (event.clientY - rect.top) / rect.height;
    setDrop({ key: node ? nodeKey(node) : null, placement: !node ? "inside" : ratio < .25 ? "before" : ratio > .75 ? "after" : "inside" });
    event.dataTransfer.dropEffect = "move";
  }
  function dropNode(event, node) {
    event.preventDefault(); event.stopPropagation();
    const key = dragRef.current, target = node ? nodeKey(node) : null;
    try {
      if (!key || !ready) return;
      // Use the release position: the final dragover may still describe the
      // middle of the row when the pointer quickly crosses its edge.
      const rect = event.currentTarget.getBoundingClientRect(), ratio = (event.clientY - rect.top) / rect.height;
      const placement = !node ? "inside" : ratio < .25 ? "before" : ratio > .75 ? "after" : "inside";
      const next = { ...layout, ...moveLayerNode(roots, key, target, placement) };
      const nextTree = buildLayerTree(jobs, next, edits);
      const source = allNodes.find(n => nodeKey(n) === key);
      const pages = new Set([...(source ? uiNodeShapes(editor, source) : []), ...(node ? uiNodeShapes(editor, node) : [])].map(s => uiShapePage(editor, s)));
      if (node && pages.size > 1) throw new Error("请先将两个节点的图片放在同一页面，再调整父子关系");
      editor.markHistoryStoppingPoint("调整 UI 层级");
      editor.run(() => {
        updateLayerDocument(editor, { ...editor.getDocumentSettings().meta, uiHierarchy: next });
        const hiddenKeys = new Set(editor.store.allRecords().flatMap(s => s.meta?.uiHiddenBy || []));
        const moved = flattenLayerTree(nextTree).find(r => nodeKey(r.node) === key)?.node;
        if (moved) for (const { node: child } of flattenLayerTree([moved])) {
          if (child.slice) editor.updateShapes(uiNodeShapes(editor, { ...child, children: undefined }).map(s => hierarchyVisibility(s, nodeKey(child), next, hiddenKeys)));
        }
        // Keep sibling drawing order consistent with the top-to-bottom layer tree.
        const parent = flattenLayerTree(nextTree).find(r => nodeKey(r.node) === next[key].parent)?.node;
        const reorder = list => { for (const n of [...list].reverse()) {
          const own = n.slice ? uiNodeShapes(editor, { ...n, children: undefined }).filter(s => uiShapePage(editor, s) === editor.getCurrentPageId()) : [];
          if (own.length) editor.bringToFront(own); reorder(n.children);
        } };
        reorder(parent ? parent.children : nextTree.filter(n => pages.has(uiShapePage(editor, uiNodeShapes(editor, n)[0] || {}))));
      });
      if (target) setCollapsed(previous => { const result = new Set(previous); result.delete(target); return result; });
      const moved = flattenLayerTree(buildLayerTree(jobs, next, edits)).find(r => nodeKey(r.node) === key)?.node;
      if (moved?.job.status === "ready") select(moved);
    } catch (error) { onError(error.message); }
    finally { dragRef.current = null; setDragging(false); setDrop(null); }
  }
  function action(name, node) {
    setMenu(null);
    node = allNodes.find(n => nodeKey(n) === nodeKey(node)) || node;
    try {
      if (name === "rename") startRename(node);
      if (name === "duplicate") select(duplicateUiNode(editor, jobs, roots, node));
      if (name === "delete") { deleteUiNode(editor, node); setTreeSelection(null); }
      if (name === "visibility") setUiNodeVisible(editor, node, !uiNodeVisible(editor, node));
      if (name === "locate") select(node);
      if (name === "refine") onRefine({ job: node.job, slice: node.slice });
    } catch (error) { onError(error.message); }
  }
  function menuKeyboard(event) {
    event.stopPropagation();
    const buttons = [...menuRef.current.querySelectorAll('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement);
    let next;
    if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
    if (event.key === "ArrowUp") next = (index - 1 + buttons.length) % buttons.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = buttons.length - 1;
    if (next !== undefined) { event.preventDefault(); buttons[next]?.focus(); }
    if (event.key === "Tab") setMenu(null);
  }
  function openMenu(event, node, keyboard = false) {
    event.preventDefault(); event.stopPropagation();
    select(node); editor?.blur();
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ node, x: Math.max(8, Math.min(keyboard ? rect.left + 24 : event.clientX, window.innerWidth - 238)),
      y: Math.max(8, Math.min(keyboard ? rect.bottom : event.clientY, window.innerHeight - 110)) });
  }
  function keyboard(event, index) {
    const { node, depth } = rows[index], key = nodeKey(node);
    if (event.target.closest("input, button, select, textarea")) return;
    if (ready && (event.key === "Delete" || event.key === "Backspace" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d"))) {
      event.preventDefault(); event.stopPropagation();
      action(event.key.toLowerCase() === "d" ? "duplicate" : "delete", node); return;
    }
    if (event.key === "F2") { event.preventDefault(); event.stopPropagation(); startRename(node); return; }
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { openMenu(event, node, true); return; }
    let target;
    if (event.key === "ArrowDown") target = rows[Math.min(rows.length - 1, index + 1)];
    else if (event.key === "ArrowUp") target = rows[Math.max(0, index - 1)];
    else if (event.key === "Home") target = rows[0];
    else if (event.key === "End") target = rows.at(-1);
    else if (event.key === "ArrowRight") { if (collapsed.has(key)) toggle(key); else if (node.children.length) target = rows[index + 1]; }
    else if (event.key === "ArrowLeft") { if (node.children.length && !collapsed.has(key)) toggle(key); else target = rows.slice(0, index).reverse().find(r => r.depth < depth); }
    else if (event.key === "Enter" || event.key === " ") select(node);
    else return;
    event.preventDefault();
    event.stopPropagation();
    if (target) { const targetKey = nodeKey(target.node); setFocused(targetKey); document.getElementById(`layer-${targetKey}`)?.focus(); }
  }
  return <aside className="uis-layers" aria-label="UI 图层面板">
    <div className="uis-layer-heading"><strong>预设与图层</strong><div className="uis-layer-tools">
      <button type="button" title="全部展开" aria-label="全部展开" disabled={!branchKeys.length} onClick={expandAll}>
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 6 4-4 4 4M10 2v6m-4 6 4 4 4-4m-4-2v6" /></svg>
      </button>
      <button type="button" title="全部收起" aria-label="全部收起" disabled={!branchKeys.length} onClick={collapseAll}>
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 3 4 4 4-4M10 1v6m-4 10 4-4 4 4m-4-4v6" /></svg>
      </button>
    </div></div>
    <div className="uis-layer-search" onPointerDown={() => editor?.blur()} onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); changeQuery(""); } }}>
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg>
      <input type="search" aria-label="搜索预设与图层名称" placeholder="搜索名称…" value={query} onChange={event => changeQuery(event.target.value)} />
    </div>
    <div ref={treeRef} className="uis-layer-tree" role="tree" aria-label="UI 父子图层">
      {!rows.length && <p className="uis-hint">{searching ? "没有匹配的名称" : "当前画布暂无图层"}</p>}
      {rows.map(({ node, depth }, index) => {
        const key = nodeKey(node), isSelected = key === activeKey;
        return <div key={key} id={`layer-${key}`} role="treeitem" aria-level={depth + 1} aria-selected={isSelected}
          aria-expanded={node.children.length ? !collapsed.has(key) : undefined} tabIndex={key === tabStop ? 0 : -1}
          draggable={ready && !rename} onDragStart={event => { dragRef.current = key; setDragging(true); setMenu(null); event.dataTransfer.setData("text/plain", key); event.dataTransfer.effectAllowed = "move"; }}
          onDragOver={event => dragOver(event, node)} onDrop={event => dropNode(event, node)} onDragEnd={() => { dragRef.current = null; setDragging(false); setDrop(null); }}
          className={`uis-layer-row ${isSelected ? "is-selected" : ""} ${drop?.key === key ? `drop-${drop.placement}` : ""} ${visibility[key] ? "" : "is-hidden"}`} style={{ paddingLeft: 8 + Math.min(depth, 12) * 14 }}
          onClick={() => select(node)} onContextMenuCapture={event => openMenu(event, node)} onKeyDown={event => keyboard(event, index)}>
          <button className="uis-layer-toggle" tabIndex={-1} aria-label={collapsed.has(key) ? "展开图层" : "折叠图层"} disabled={!node.children.length}
            onClick={event => { event.stopPropagation(); toggle(key); }}>{node.children.length ? collapsed.has(key) ? "▸" : "▾" : "·"}</button>
          {node.slice || node.job.atlasFile ? <img draggable={false} className="uis-checker" src={assetUrl(node.job, node.slice?.file || node.job.atlasFile)} alt="" /> : <span className="uis-layer-folder">▱</span>}
          <div className="uis-layer-name">{rename && nodeKey(rename.node) === key ? <input autoFocus aria-label="重命名图层" maxLength={120} value={rename.value} onFocus={e => e.target.select()} onChange={e => setRename({ ...rename, value: e.target.value })} onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onBlur={commitRename} onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); commitRename(); } if (e.key === "Escape") { e.preventDefault(); setRename(null); } }} /> : <strong title={node.name} onDoubleClick={event => { event.stopPropagation(); startRename(node); }}>{node.name}</strong>}</div>
          <button className="uis-layer-eye" title={visibility[key] ? "隐藏" : "显示"} aria-label={`${visibility[key] ? "隐藏" : "显示"} ${node.name}`} aria-pressed={Boolean(visibility[key])} disabled={!ready || node.job.status !== "ready" && !node.job.canvasCandidate} onClick={event => { event.stopPropagation(); setUiNodeVisible(editor, node, !visibility[key]); }}>{visibility[key] ? "◉" : "○"}</button>
        </div>;
      })}
      {dragging && <div className={`uis-layer-root-drop ${drop?.key === null ? "drop-inside" : ""}`} onDragOver={event => dragOver(event, null)} onDrop={event => dropNode(event, null)}>拖到这里移出父节点</div>}
    </div>
    <div className="uis-layer-inspector" onPointerDown={() => editor?.blur()}>
      {activeJob ? <>
        <NodeInspector key={activeKey} treeNode={activeNode} parentNode={parentNode} job={activeJob} slice={activeSlice} editor={editor} busy={busy || !ready} onChange={onRefresh} onError={onError} onRefine={onRefine} />
      </> : <p className="uis-hint">选择图层查看属性</p>}
    </div>
    {menu && <div ref={menuRef} className="uis-layer-context" role="menu" aria-label="图层操作" style={{ left: menu.x, top: menu.y }} onKeyDown={menuKeyboard} onContextMenu={event => event.preventDefault()}>
      <p title={menu.node.name}>{menu.node.name}</p>
      <button role="menuitem" disabled={!ready || menu.node.job.status !== "ready"} onClick={() => action("duplicate", menu.node)}><span>复制副本</span><kbd>Ctrl D</kbd></button>
      <button role="menuitem" disabled={!ready || menu.node.job.status !== "ready"} onClick={() => action("rename", menu.node)}><span>重命名</span><kbd>F2</kbd></button>
      <button role="menuitem" disabled={!ready || menu.node.job.status !== "ready"} onClick={() => action("visibility", menu.node)}>{visibility[nodeKey(menu.node)] ? "隐藏" : "显示"}</button>
      <button role="menuitem" disabled={!ready || menu.node.job.status !== "ready"} onClick={() => action("locate", menu.node)}>定位到画布</button>
      <div role="separator" />
      <button className="is-ai" role="menuitem" disabled={busy || !ready || Boolean(menu.node.instanceKey) || menu.node.job.status !== "ready"} title={menu.node.instanceKey ? "请在原始节点继续细分" : undefined} onClick={() => action("refine", menu.node)}>拆分</button>
      <div role="separator" />
      <button className="is-danger" role="menuitem" disabled={!ready} title="删除此节点及子节点，可撤销；保留任务原始素材" onClick={() => action("delete", menu.node)}><span>删除{menu.node.children.length ? "节点及子节点" : ""}</span><kbd>Del</kbd></button>
    </div>}
  </aside>;
}
