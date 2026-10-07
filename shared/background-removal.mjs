// Shared by asset slicing, video frame preview and sequence export.
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

// Recover straight RGB and retain a smooth fractional alpha at the key boundary.
// Both asset slicing and guided video matting use this transition.
export function recoverBackgroundEdge(input, offset, bg, tolerance, alpha) {
  const deviation = Math.max(...bg.map((v, c) => Math.abs(input[offset + c] - v)));
  const t = tolerance ? Math.min(1, deviation / tolerance) : 1;
  return [
    ...bg.map((v, c) => alpha > 0 ? Math.round((input[offset + c] - v * (1 - alpha)) / alpha) : 0),
    Math.round(input[offset + 3] * alpha * t * t * (3 - 2 * t)),
  ];
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
  if (high - low > 150 && !options.hardAlpha) {
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
      // Fade very weak key deviations smoothly instead of cutting off the glow
      // at the tolerance boundary; exact background still has zero alpha.
      data.set(recoverBackgroundEdge(input, i, bg, options.tolerance, 1 - spill), i);
    }
  }
  return { data, background: bg, preservedAlpha: false };
}
