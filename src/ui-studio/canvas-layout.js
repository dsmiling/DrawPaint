// Keep source atlases in the job history; the canvas contains only usable results.
export function jobImageLayout(job, origin = { x: 0, y: 0 }) {
  const scale=origin.scale ?? 1;
  return job.slices.map(slice => ({ ...slice, sourceX: slice.x, sourceY: slice.y,
    sourceW:slice.w,sourceH:slice.h,
    x: origin.x + slice.x*scale, y: origin.y + slice.y*scale,w:slice.w*scale,h:slice.h*scale, role: "slice" }));
}

export function besideSourceLayout(job, bounds) {
  return {x:bounds.x+bounds.w+Math.max(24,Math.min(80,bounds.w*.15)),y:bounds.y,
    scale:Math.min(bounds.w/job.width,bounds.h/job.height)};
}

export function redundantAtlasIds(shapes) {
  const resultRevisions = new Set(shapes.filter(shape => shape.meta?.uiRole === "slice")
    .map(shape => `${shape.parentId}/${shape.meta.uiJobId}/${shape.meta.uiRevision}`));
  return shapes.filter(shape => shape.meta?.uiRole === "atlas" &&
    resultRevisions.has(`${shape.parentId}/${shape.meta.uiJobId}/${shape.meta.uiRevision}`)).map(shape => shape.id);
}
