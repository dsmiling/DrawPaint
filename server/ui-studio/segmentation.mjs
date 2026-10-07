// Deterministic pixel processing for separated UI atlases. No model/network calls.
import { componentMetadata } from "../../shared/ui-schema.mjs";
export { detectBackground, removeBackground } from "../../shared/background-removal.mjs";
export function normalizeOptions(value = {}) {
  const number = (key, fallback, min, max) => {
    const n = Number(value[key] ?? fallback);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid ${key}`);
    return Math.round(n);
  };
  const background = value.background || "auto";
  if (background !== "auto" && !/^#[\da-f]{6}$/i.test(background)) throw new Error("Invalid background color");
  return {
    removeBackground: value.removeBackground !== false,
    autoSplit: value.autoSplit !== false,
    background,
    removalMode: value.removalMode === "color" ? "color" : "edge",
    tolerance: number("tolerance", 24, 0, 150),
    feather: number("feather", 8, 0, 60),
    minArea: number("minArea", 12, 1, 10000),
    padding: number("padding", 2, 0, 100),
  };
}


// Eight-connected components keep diagonal strokes together, and return a label
// map so a large bounding box never duplicates unrelated nested objects.
export function findComponents(data, width, height) {
  const labels = new Int32Array(width * height);
  const queue = new Uint32Array(width * height);
  const components = []; let next = 0;
  for (let p = 0; p < labels.length; p++) {
    if (labels[p] || data[p * 4 + 3] === 0) continue;
    const id = ++next; let head = 0, tail = 1;
    queue[0] = p; labels[p] = id;
    let x0 = width, y0 = height, x1 = 0, y1 = 0;
    while (head < tail) {
      const q = queue[head++], x = q % width, y = Math.floor(q / width);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
        const k = q + dy * width + dx;
        if (!labels[k] && data[k * 4 + 3] > 0) { labels[k] = id; queue[tail++] = k; }
      }
    }
    components.push({ componentIds: [id], x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area: tail });
  }
  return { labels, components };
}

export function makeSlices(components, width, height, options) {
  // Enclosed disconnected details (e.g. a button label) belong to its outer frame.
  // Large nested objects remain separate, as in the supplied health-bar example.
  const main = components.filter(c => c.area >= options.minArea).map(c => ({ ...c, componentIds: [...c.componentIds] }));
  const absorbed = new Set();
  for (const child of main) {
    const parent = main.filter(p => p !== child && p.w * p.h > child.w * child.h * 4 &&
      child.x > p.x && child.y > p.y && child.x + child.w < p.x + p.w && child.y + child.h < p.y + p.h)
      .sort((a, b) => a.w * a.h - b.w * b.h)[0];
    if (parent && child.w < parent.w * 0.5 && child.h < parent.h * 0.5) {
      parent.componentIds.push(...child.componentIds); absorbed.add(child);
    }
  }
  // Propagate absorbed descendants so deep nesting cannot discard pixels.
  for (let pass = 0; pass < 3; pass++) for (const parent of main) {
    for (const child of main) if (parent !== child && parent.componentIds.includes(child.componentIds[0])) {
      parent.componentIds = [...new Set([...parent.componentIds, ...child.componentIds])];
    }
  }
  return main.filter(c => !absorbed.has(c)).sort((a, b) => a.y - b.y || a.x - b.x).map((c, i) => {
    const x = Math.max(0, c.x - options.padding), y = Math.max(0, c.y - options.padding);
    return { ...c, id: `slice-${i + 1}`, name: `ui_${String(i + 1).padStart(3, "0")}`,
      x, y, w: Math.min(width, c.x + c.w + options.padding) - x,
      h: Math.min(height, c.y + c.h + options.padding) - y };
  });
}

export function validateSlices(slices, width, height) {
  if (!Array.isArray(slices) || !slices.length || slices.length > 500) throw new Error("切片数量须为 1–500");
  const ids = new Set();
  return slices.map((s, i) => {
    const { x, y, w, h } = s;
    if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w < 1 || h < 1 || x + w > width || y + h > height) throw new Error(`切片 ${i + 1} 超出原图范围`);
    const id = `slice-${i + 1}`;
    let name = String(s.name || `ui_${i + 1}`).replace(/[^\p{L}\p{N}_-]/gu, "_").slice(0, 80) || `ui_${i + 1}`;
    if (ids.has(name)) name += `_${i + 1}`;
    while (ids.has(name)) name += "_";
    ids.add(name);
    const componentIds = Array.isArray(s.componentIds) ? [...new Set(s.componentIds.filter(n => Number.isInteger(n) && n > 0))] : null;
    return { ...componentMetadata(s), id, name, x, y, w, h, componentIds };
  });
}

export function cropSlice(data, width, slice, labels) {
  const output = new Uint8Array(slice.w * slice.h * 4);
  const owned = slice.componentIds?.length ? new Set(slice.componentIds) : null;
  for (let y = 0; y < slice.h; y++) for (let x = 0; x < slice.w; x++) {
    const p = (slice.y + y) * width + slice.x + x;
    if (owned && !owned.has(labels[p])) continue;
    const i = (y * slice.w + x) * 4;
    output.set(data.subarray(p * 4, p * 4 + 4), i);
  }
  return output;
}
