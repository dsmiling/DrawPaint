// Deterministic pixel processing for separated UI atlases. No model/network calls.
import { componentMetadata } from "../../shared/ui-schema.mjs";
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

export function detectBackground(data, width, height) {
  const buckets = new Map();
  const sample = (x, y) => {
    const i = (y * width + x) * 4;
    if (data[i + 3] < 250) return;
    const key = `${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`;
    const b = buckets.get(key) || [0, 0, 0, 0];
    b[0]++; for (let c = 0; c < 3; c++) b[c + 1] += data[i + c];
    buckets.set(key, b);
  };
  for (let x = 0; x < width; x++) { sample(x, 0); sample(x, height - 1); }
  for (let y = 1; y < height - 1; y++) { sample(0, y); sample(width - 1, y); }
  const best = [...buckets.values()].sort((a, b) => b[0] - a[0])[0];
  return best ? best.slice(1).map(v => Math.round(v / best[0])) : [255, 255, 255];
}

export function removeBackground(input, width, height, options) {
  const data = new Uint8ClampedArray(input);
  const n = width * height;
  const bg = options.background === "auto" ? detectBackground(data, width, height)
    : [1, 3, 5].map(i => parseInt(options.background.slice(i, i + 2), 16));
  // Real transparent atlases must not have their foreground recolored by keying.
  let transparentBorder = 0;
  for (let x = 0; x < width; x++) {
    if (data[x * 4 + 3] === 0) transparentBorder++;
    if (data[((height - 1) * width + x) * 4 + 3] === 0) transparentBorder++;
  }
  for (let y = 0; y < height; y++) {
    if (data[(y * width) * 4 + 3] === 0) transparentBorder++;
    if (data[(y * width + width - 1) * 4 + 3] === 0) transparentBorder++;
  }
  if (!options.removeBackground || transparentBorder > (width + height) * 1.5) {
    return { data, background: bg, preservedAlpha: transparentBorder > 0 };
  }
  const distance = p => Math.max(...bg.map((v, c) => Math.abs(data[p * 4 + c] - v)));
  const threshold = options.tolerance + options.feather;
  const selected = new Uint8Array(n);
  if (options.removalMode === "color") {
    for (let p = 0; p < n; p++) if (distance(p) <= threshold) selected[p] = 1;
  } else {
    const queue = new Uint32Array(n); let head = 0, tail = 0;
    const visit = p => {
      if (!selected[p] && (data[p * 4 + 3] === 0 || distance(p) <= threshold)) {
        selected[p] = 1; queue[tail++] = p;
      }
    };
    for (let x = 0; x < width; x++) { visit(x); visit((height - 1) * width + x); }
    for (let y = 0; y < height; y++) { visit(y * width); visit(y * width + width - 1); }
    while (head < tail) {
      const p = queue[head++], x = p % width;
      if (x) visit(p - 1); if (x < width - 1) visit(p + 1);
      if (p >= width) visit(p - width); if (p < n - width) visit(p + width);
    }
  }
  for (let p = 0; p < n; p++) {
    if (!selected[p]) continue;
    const alpha = options.feather ? Math.max(0, Math.min(1, (distance(p) - options.tolerance) / options.feather)) : 0;
    const i = p * 4;
    for (let c = 0; c < 3; c++) data[i + c] = alpha > 0 ? Math.round((data[i + c] - bg[c] * (1 - alpha)) / alpha) : 0;
    data[i + 3] = Math.round(data[i + 3] * alpha);
  }
  // Follow key-contaminated gradients inward from removed background. A fixed
  // two-pixel band cannot cover wide glows, and globally despilling would recolor
  // isolated foreground details that happen to use the key hue.
  const low = Math.min(...bg), high = Math.max(...bg);
  if (high - low > 150) {
    const highChannels = [0, 1, 2].filter(c => bg[c] > low + (high - low) * .75);
    const lowChannels = [0, 1, 2].filter(c => bg[c] < low + (high - low) * .25);
    const visited = new Uint8Array(n), queue = new Uint32Array(n);
    let head = 0, tail = 0;
    const spillAt = p => {
      const i = p * 4;
      const keyDominance = Math.min(...highChannels.map(c => input[i + c])) - Math.max(...lowChannels.map(c => input[i + c]));
      // Cyan/white light on magenta (white light on green) can retain a full
      // key channel even after the opposite channel exceeds it. Do not stop
      // halfway through that gradient just because its hue is no longer purple.
      if (keyDominance <= 0 && !highChannels.some(c => input[i+c] >= 247)) return 0;
      // Smallest physically possible alpha in C = alpha*F + (1-alpha)*key.
      // Unlike channel subtraction, this also recovers cyan's red/green ramp.
      let alpha = 0;
      for (let c=0;c<3;c++) {
        const delta=input[i+c]-bg[c];
        alpha=Math.max(alpha,delta<0 ? -delta/Math.max(1,bg[c]) : delta/Math.max(1,255-bg[c]));
      }
      return Math.max(0,1-alpha);
    };
    for (let p = 0; p < n; p++) if (data[p * 4 + 3] === 0) { visited[p] = 1; queue[tail++] = p; }
    const visit = p => {
      if (visited[p] || spillAt(p) <= 0) return;
      visited[p] = 1; queue[tail++] = p;
    };
    while (head < tail) {
      const p = queue[head++], x = p % width, y = Math.floor(p / width);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height) visit(p + dy * width + dx);
      }
      const i = p * 4;
      if (!input[i + 3]) continue;
      const spill = spillAt(p);
      if (spill <= 0) continue;
      const alpha = 1 - spill;
      for (let c = 0; c < 3; c++) data[i + c] = alpha ? Math.round((input[i + c] - bg[c] * spill) / alpha) : 0;
      // Fade very weak key deviations smoothly instead of cutting off the glow
      // at the tolerance boundary; exact background still has zero alpha.
      const deviation=Math.max(...bg.map((v,c)=>Math.abs(input[i+c]-v)));
      const t=options.tolerance ? Math.min(1,deviation/options.tolerance) : 1;
      data[i + 3] = Math.round(input[i + 3] * alpha * t*t*(3-2*t));
    }
  }
  return { data, background: bg, preservedAlpha: false };
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
