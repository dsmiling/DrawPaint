const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function videoProjectSnapshot(project) {
  const clips = project.clips || [];
  return { clips, width: project.width || 640, height: project.height || 640, view: {
    graphPan: project.view?.graphPan || { x: 0, y: 0 }, graphZoom: project.view?.graphZoom || 100,
    timelineZoom: project.view?.timelineZoom || 50, selectedIds: project.view?.selectedIds || (clips.length ? [clips[0].id] : []),
  } };
}

// Merge independent edits against the last saved content. A competing edit to
// the same field or a changed-and-deleted clip needs explicit resolution.
export function mergeVideoProjectSnapshots(base, local, remote) {
  const merged = { ...remote, clips: [], view: { ...local.view } };
  for (const key of ["width", "height"]) {
    if (equal(local[key], base[key])) merged[key] = remote[key];
    else if (equal(remote[key], base[key]) || equal(local[key], remote[key])) merged[key] = local[key];
    else return null;
  }
  const originals = new Map(base.clips.map(clip => [clip.id, clip]));
  const ours = new Map(local.clips.map(clip => [clip.id, clip]));
  const theirs = new Map(remote.clips.map(clip => [clip.id, clip]));
  const ids = new Set([...theirs.keys(), ...ours.keys()]);
  for (const id of ids) {
    const original = originals.get(id), mine = ours.get(id), other = theirs.get(id);
    if (!original) {
      if (mine && other && !equal(mine, other)) return null;
      merged.clips.push(mine || other); continue;
    }
    if (!mine || !other) {
      if (!equal(mine || other, original)) return null;
      continue;
    }
    const clip = {};
    for (const key of new Set([...Object.keys(original), ...Object.keys(mine), ...Object.keys(other)])) {
      let value;
      if (equal(mine[key], original[key])) value = other[key];
      else if (equal(other[key], original[key]) || equal(mine[key], other[key])) value = mine[key];
      else return null;
      if (value !== undefined) clip[key] = value;
    }
    merged.clips.push(clip);
  }
  merged.view.selectedIds = (local.view?.selectedIds || []).filter(id => merged.clips.some(clip => clip.id === id));
  return merged;
}
