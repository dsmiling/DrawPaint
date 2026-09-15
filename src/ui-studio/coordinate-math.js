export const worldToLocal = (world, parent = { x: 0, y: 0 }) => ({ x: world.x - parent.x, y: world.y - parent.y });
export const localToWorld = (local, parent = { x: 0, y: 0 }) => ({ x: local.x + parent.x, y: local.y + parent.y });

// A component moving inside a preset must not move that preset's origin.
export function commonTranslation(before, after, allowSingle = false) {
  if (!before.length || before.length !== after.length || (before.length === 1 && !allowSingle)) return null;
  const previous = new Map(before.map(p => [p.id, p]));
  let delta;
  for (const point of after) {
    const old = previous.get(point.id);
    if (!old || old.page !== point.page) return null;
    const current = { x: point.x - old.x, y: point.y - old.y };
    if (!Number.isFinite(current.x) || !Number.isFinite(current.y)) return null;
    if (delta && (Math.abs(current.x - delta.x) > 1e-6 || Math.abs(current.y - delta.y) > 1e-6)) return null;
    delta = current;
  }
  return delta && (Math.abs(delta.x) > 1e-8 || Math.abs(delta.y) > 1e-8) ? delta : null;
}
