// Track which nodes hide an image, so revealing a parent preserves hidden children.
export function visibilityChange(shape, key, visible) {
  const hiddenBy = new Set(shape.meta.uiHiddenBy || []);
  const opacity = hiddenBy.size ? shape.meta.uiVisibleOpacity ?? 1 : shape.opacity || shape.meta.uiVisibleOpacity || 1;
  if (visible) hiddenBy.delete(key); else hiddenBy.add(key);
  return { id: shape.id, type: shape.type, opacity: hiddenBy.size ? 0 : opacity,
    meta: { ...shape.meta, uiVisibleOpacity: opacity, uiHiddenBy: [...hiddenBy] } };
}

export function hierarchyVisibility(shape, ownKey, layout, hiddenKeys) {
  const ancestors = new Set([ownKey]); let parent = layout[ownKey]?.parent;
  while (parent && !ancestors.has(parent)) { ancestors.add(parent); parent = layout[parent]?.parent; }
  const hiddenBy = [...hiddenKeys].filter(key => ancestors.has(key));
  const opacity = shape.meta.uiHiddenBy?.length ? shape.meta.uiVisibleOpacity ?? 1 : shape.opacity;
  return { id: shape.id, type: shape.type, opacity: hiddenBy.length ? 0 : opacity,
    meta: { ...shape.meta, uiVisibleOpacity: opacity, uiHiddenBy: hiddenBy } };
}
