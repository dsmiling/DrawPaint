export { componentLabels as layerLabels } from "../../shared/ui-schema.mjs";
export const nodeKey = node => node.instanceKey || `${node.jobId}/${node.revision || "pending"}/${node.sliceId || "root"}`;
export function sliceForShape(job, meta) {
  if (!job || !meta || meta.uiRole !== "slice") return undefined;
  return job.slices?.find(s => meta.uiSliceId ? s.id === meta.uiSliceId : meta.sourceRect ? ["x", "y", "w", "h"].every(k => s[k] === meta.sourceRect[k]) : s.name === meta.uiName);
}

// Relationships use immutable source revisions, never reused slice names/indices.
export function buildLayerTree(jobs, layout = {}, edits = {}) {
  jobs = jobs.filter(j => !["classify", "plan"].includes(j.operation)).map(canvasResult);
  const nodes = new Map();
  const roots = [];
  for (const job of jobs) {
    const root = { jobId: job.id, revision: job.revision, sliceId: null, job,
      name: job.presetName || (job.operation === "decompose" ? `细分 · ${job.parent.name}` : job.prompt), children: [] };
    nodes.set(nodeKey(root), root);
    for (const slice of [...(job.slices || [])].sort((a, b) => (b.zIndex || 0) - (a.zIndex || 0))) {
      const child = { jobId: job.id, revision: job.revision, sliceId: slice.id, job, slice, name: slice.name, children: [] };
      root.children.push(child); nodes.set(nodeKey(child), child);
    }
  }
  for (const job of jobs) {
    const root = nodes.get(nodeKey({ jobId: job.id, revision: job.revision }));
    const parent = job.parent && nodes.get(nodeKey({ jobId: job.parent.jobId, revision: job.parent.revision, sliceId: job.parent.sliceId }));
    if (parent) parent.children.push(root);
    else { root.historical = Boolean(job.parent); roots.push(root); }
  }
  // Editing the hierarchy never changes the immutable AI source relationship.
  const parents = new Map();
  const remember = (list, parent) => list.forEach(n => { parents.set(nodeKey(n), parent); remember(n.children, nodeKey(n)); });
  remember(roots, null);
  for (const [key, copy] of Object.entries(edits.copies || {})) {
    const source = nodes.get(copy.sourceKey);
    if (!source) continue;
    const slice = source.slice ? { ...source.slice, ...copy.slice, name: copy.name } : undefined;
    nodes.set(key, { ...source, instanceKey: key, slice, name: copy.name, children: [] });
    parents.set(key, copy.parent && (nodes.has(copy.parent) || edits.copies[copy.parent]) ? copy.parent : null);
  }
  for (const [key, entry] of Object.entries(layout)) {
    if (nodes.has(key) && (entry?.parent === null || nodes.has(entry?.parent))) parents.set(key, entry.parent);
  }
  for (const key of nodes.keys()) {
    const seen = new Set([key]); let p = parents.get(key);
    while (p) { if (seen.has(p)) { parents.set(key, null); break; } seen.add(p); p = parents.get(p); }
  }
  roots.length = 0;
  nodes.forEach(n => { n.children = []; });
  const deleted = new Set(edits.deleted || []);
  const isDeleted = key => { while (key) { if (deleted.has(key)) return true; key = parents.get(key); } return false; };
  nodes.forEach((n, key) => { if (isDeleted(key)) return; const p = parents.get(key); (p ? nodes.get(p).children : roots).push(n); });
  const sort = list => {
    const order = new Map(list.map((n, i) => [nodeKey(n), i]));
    list.sort((a, b) => (layout[nodeKey(a)]?.order ?? order.get(nodeKey(a))) - (layout[nodeKey(b)]?.order ?? order.get(nodeKey(b))));
    list.forEach(n => sort(n.children));
  };
  sort(roots);
  return roots;
}

function locate(roots, key, parent = null) {
  for (const node of roots) {
    if (nodeKey(node) === key) return { node, siblings: roots, parent };
    const found = locate(node.children, key, nodeKey(node));
    if (found) return found;
  }
}

function relocateNode(roots, key, parentKey, beforeKey) {
  const source = locate(roots, key), parent = parentKey === null ? null : locate(roots, parentKey);
  if (!source || (parentKey !== null && !parent)) throw new Error("图层已更新，请重新选择节点");
  if (key === parentKey || (parent && locate(source.node.children, parentKey))) throw new Error("不能将节点放到自身或子节点下");
  const destination = parent ? parent.node.children : roots;
  if (beforeKey === key && destination === source.siblings) return;
  source.siblings.splice(source.siblings.indexOf(source.node), 1);
  const index = beforeKey ? destination.findIndex(n => nodeKey(n) === beforeKey) : -1;
  destination.splice(index < 0 ? destination.length : index, 0, source.node);
}

export function moveLayerNode(roots, sourceKey, targetKey, placement = "inside") {
  const copy = nodes => nodes.map(n => ({ ...n, children: copy(n.children) }));
  const next = copy(roots), target = targetKey && locate(next, targetKey);
  if (sourceKey === targetKey) throw new Error("不能拖到节点自身");
  if (targetKey && !target) throw new Error("目标节点不存在");
  const parentKey = !target ? null : placement === "inside" ? targetKey : target.parent;
  const beforeKey = placement === "before" ? targetKey : placement === "after" ? nodeKey(target.siblings[target.siblings.indexOf(target.node) + 1] || {}) : null;
  relocateNode(next, sourceKey, parentKey, beforeKey);
  const layout = {};
  const visit = (nodes, parent) => nodes.forEach((n, order) => { layout[nodeKey(n)] = { parent, order }; visit(n.children, nodeKey(n)); });
  visit(next, null);
  return layout;
}

export function flattenLayerTree(roots, collapsed = new Set(), depth = 0) {
  return roots.flatMap(node => [{ node, depth }, ...(collapsed.has(nodeKey(node)) ? [] : flattenLayerTree(node.children, collapsed, depth + 1))]);
}

// Keep only images present on this page, plus the ancestors needed to show their hierarchy.
export function layerTreeForShapes(roots, shapes) {
  const images = shapes.filter(shape => shape.type === "image");
  const prune = nodes => nodes.flatMap(node => {
    const children = prune(node.children);
    const present = node.sliceId && images.some(({ meta }) => {
      if (node.instanceKey) return meta?.uiNodeKey === node.instanceKey;
      if (meta?.uiNodeKey || meta?.uiJobId !== node.jobId || meta?.uiRevision !== node.revision) return false;
      return meta.uiSliceId ? meta.uiSliceId === node.sliceId : sliceForShape(node.job, meta)?.id === node.sliceId;
    });
    return present || children.length ? [{ ...node, children }] : [];
  });
  return prune(roots);
}

export function searchLayerTree(roots, query) {
  const terms = query.normalize("NFKC").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return roots;
  const search = nodes => nodes.flatMap(node => {
    const name = (node.name || "").normalize("NFKC").toLocaleLowerCase();
    if (terms.every(term => name.includes(term))) return [node];
    const children = search(node.children);
    return children.length ? [{ ...node, children }] : [];
  });
  return search(roots);
}

// A copy keeps immutable asset provenance but receives independent document identity.
export function copyLayerBranch(roots, key, edits, makeKey) {
  const source = locate(roots, key);
  if (!source) throw new Error("图层已更新，请重新选择节点");
  const mapping = {}, copies = { ...edits.copies };
  const siblings = new Set(source.siblings.map(n => n.name));
  let name = `${source.node.name} 副本`, suffix = 2;
  while (siblings.has(name)) name = `${source.node.name} 副本 ${suffix++}`;
  const visit = (node, parent) => {
    const oldKey = nodeKey(node), newKey = makeKey(); mapping[oldKey] = newKey;
    copies[newKey] = { sourceKey: copies[oldKey]?.sourceKey || oldKey, parent,
      name: oldKey === key ? name : node.name, ...(node.slice ? { slice: { ...node.slice } } : {}) };
    node.children.forEach(child => visit(child, newKey));
  };
  visit(source.node, source.parent);
  return { edits: { ...edits, copies }, mapping, key: mapping[key] };
}
import { canvasResult } from "../../shared/ui-delivery.mjs";
