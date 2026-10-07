export const DEFAULT_VIDEO_FOLDERS = [
  { id: "generated", name: "生成视频", parentId: null },
  { id: "normal", name: "正常视频", parentId: "generated" },
  { id: "animation", name: "帧动画视频", parentId: "generated" },
  { id: "imported", name: "导入视频", parentId: null },
];
export const videoAssetKey = asset => `${asset.source.type}:${asset.source.id}`;
export function folderPath(folders, id) {
  const result = [], seen = new Set();
  while (id != null && !seen.has(id)) {
    seen.add(id); const folder = folders.find(item => item.id === id);
    if (!folder) break;
    result.unshift(folder); id = folder.parentId;
  }
  return result;
}
export function folderDescendants(folders, id) {
  const ids = new Set([id]);
  for (let pass = 0; pass < folders.length; pass++) {
    let added = false;
    for (const folder of folders) if (ids.has(folder.parentId) && !ids.has(folder.id)) { ids.add(folder.id); added = true; }
    if (!added) break;
  }
  return ids;
}
