import { removeBackground, recoverBackgroundEdge } from "./background-removal.mjs";

function hardenAlpha(result, enabled) {
  if (enabled) for (let i = 0; i < result.data.length; i += 4) {
    result.data[i + 3] = result.data[i + 3] >= 128 ? 255 : 0;
    if (!result.data[i + 3]) result.data.fill(0, i, i + 3);
  }
  return result;
}

// A drifted key can match an opaque beak or armour highlight. Dark character
// outlines enclose solid artwork; a white effect loop does not. Flood through
// every non-outline colour so a glow cannot enclose and preserve key backdrop.
function outlineInterior(input, width, height, background, tolerance, foregroundSupport = null) {
  const count = width * height, outside = new Uint8Array(count), barriers = new Uint8Array(count), queue = new Uint32Array(count);
  for (let p = 0; p < count; p++) {
    const i = p * 4;
    barriers[p] = input[i + 3] >= 250 && Math.max(input[i], input[i + 1], input[i + 2]) <= 112
      && Math.max(...background.map((v, c) => Math.abs(input[i + c] - v))) > tolerance;
  }
  // Close sub-sprite-pixel breaks in the outline. Without this, one compressed
  // grey pixel can open the entire helmet and delete its interior for one frame.
  // Closing adds no uniform border thickness, unlike dilating the silhouette.
  const radius = Math.max(1, Math.round(Math.max(width, height) / 256));
  const dilated = new Uint8Array(count), closed = new Uint8Array(count);
  for (let p = 0; p < count; p++) if (barriers[p]) {
    const x = p % width, y = Math.floor(p / width);
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      if (x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height) dilated[p + dy * width + dx] = 1;
    }
  }
  for (let p = 0; p < count; p++) if (dilated[p]) {
    const x = p % width, y = Math.floor(p / width);
    let solid = true;
    for (let dy = -radius; dy <= radius && solid; dy++) for (let dx = -radius; dx <= radius; dx++) {
      if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height || !dilated[p + dy * width + dx]) { solid = false; break; }
    }
    closed[p] = solid;
  }
  const flood = (mask, output) => {
    let head = 0, tail = 0;
    const visit = p => { if (!output[p] && !mask[p]) { output[p] = 1; queue[tail++] = p; } };
    for (let x = 0; x < width; x++) { visit(x); visit((height - 1) * width + x); }
    for (let y = 1; y < height - 1; y++) { visit(y * width); visit(y * width + width - 1); }
    while (head < tail) {
      const p = queue[head++], x = p % width;
      if (x) visit(p - 1); if (x < width - 1) visit(p + 1);
      if (p >= width) visit(p - width); if (p < count - width) visit(p + width);
    }
  };
  flood(closed, outside);
  return Uint8Array.from(outside, (value, p) => {
    if (value || barriers[p]) return 0;
    if (!foregroundSupport) return 1;
    const i = p * 4;
    // Even an intact outline can enclose backdrop between a hand and head.
    // Every key-coloured interior requires evidence in the first-frame palette;
    // an orange beak can qualify even when a drifted yellow key resembles it.
    if (Math.max(...background.map((v, c) => Math.abs(input[i + c] - v))) > tolerance) return 1;
    return foregroundSupport[(input[i] >> 3) * 1024 + (input[i + 1] >> 3) * 32 + (input[i + 2] >> 3)];
  });
}

export function foregroundColorSupport(input, matte, width, height, absentKey = null) {
  const bins = new Map(), table = new Uint8Array(32768), minimum = Math.max(1, Math.floor(width * height / 65536));
  for (let i = 0; i < input.length; i += 4) if (matte[i + 3] >= 250) {
    // A compressed key fringe is not part of the character palette. Learn from
    // opaque cores so that a few purple contour pixels cannot protect purple
    // residue in every later frame. Small enclosed highlights still qualify.
    const p = i / 4, x = p % width, y = Math.floor(p / width);
    const radius = Math.max(1, Math.round(Math.max(width, height) / 256));
    let edge = false;
    for (let dy = -radius; dy <= radius && !edge; dy++) for (let dx = -radius; dx <= radius; dx++) {
      if (x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height
        && matte[(p + dy * width + dx) * 4 + 3] < 250) { edge = true; break; }
    }
    if (edge) continue;
    const key = (input[i] >> 4) * 256 + (input[i + 1] >> 4) * 16 + (input[i + 2] >> 4);
    const bin = bins.get(key) || [0, 0, 0, 0];
    bin[0]++;for (let c = 0; c < 3; c++) bin[c + 1] += input[i + c];bins.set(key, bin);
  }
  for (const bin of bins.values()) if (bin[0] >= minimum) {
    const rgb = bin.slice(1).map(v => Math.round(v / bin[0]));
    const lo = rgb.map(v => Math.max(0, v - 24) >> 3), hi = rgb.map(v => Math.min(255, v + 24) >> 3);
    for (let r = lo[0]; r <= hi[0]; r++) for (let g = lo[1]; g <= hi[1]; g++) for (let b = lo[2]; b <= hi[2]; b++) table[r * 1024 + g * 32 + b] = 1;
  }
  if (absentKey) {
    // Animation input preparation guarantees this key is absent from the
    // reference character. Do not let a broad +/-24 RGB support cube reach
    // back into that absent hue through a neutral palette colour.
    const key=[1,3,5].map(i=>parseInt(absentKey.slice(i,i+2),16)),low=Math.min(...key),high=Math.max(...key);
    if(high-low>150) {
      const highs=[0,1,2].filter(c=>key[c]>low+(high-low)*.75),lows=[0,1,2].filter(c=>key[c]<low+(high-low)*.25);
      for(let r=0;r<32;r++)for(let g=0;g<32;g++)for(let b=0;b<32;b++) {
        const rgb=[r*8+4,g*8+4,b*8+4];
        if(Math.min(...highs.map(c=>rgb[c]))-Math.max(...lows.map(c=>rgb[c]))>32)table[r*1024+g*32+b]=0;
      }
    }
  }
  return table;
}

// Codec ringing leaves both detached islands and tiny pale patches connected
// to a dark outline. Size is measured in source pixels, relative to a 128 px
// sprite. Keep enclosed artwork and substantial/long light effects intact.
export function cleanVideoSpeckles(data, width, height, interior = null) {
  const count = width * height, scale = Math.max(width, height) / 128;
  const islandLimit = Math.max(2, Math.round(scale * scale));
  const paleLimit = Math.max(2, Math.round(scale * scale * 2));
  const spanLimit = Math.max(2, Math.round(scale * 3));
  const seen = new Uint8Array(count), queue = new Uint32Array(count);
  let removedPixels = 0, removedComponents = 0;
  const pale = p => data[p * 4 + 3] > 0 && Math.min(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]) >= 128
    && Math.max(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]) - Math.min(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]) <= 100;
  for (const kind of ['island', 'pale']) {
    seen.fill(0);
    const includes = p => kind === 'pale' ? pale(p) : data[p * 4 + 3] > 0;
    for (let start = 0; start < count; start++) {
      if (seen[start] || !includes(start)) continue;
      let head = 0, tail = 1, protectedPixels = 0, darkPixels = 0, weight = 0, exposed = 0;
      let minX = width, minY = height, maxX = 0, maxY = 0, nearDark = false;
      queue[0] = start; seen[start] = 1;
      while (head < tail) {
        const p = queue[head++], i = p * 4, x = p % width, y = Math.floor(p / width);
        if (interior?.[p]) protectedPixels++;
        if (data[i + 3] >= 128 && Math.max(data[i], data[i + 1], data[i + 2]) <= 112) darkPixels++;
        weight += data[i + 3] / 255;
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        let boundary = false;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy, q = p + dy * width + dx;
          if (xx < 0 || xx >= width || yy < 0 || yy >= height) { boundary = true; continue; }
          if (data[q * 4 + 3] <= 8) boundary = true;
          if (!seen[q] && includes(q)) { seen[q] = 1; queue[tail++] = q; }
        }
        if (boundary) exposed++;
      }
      const limit = kind === 'island' ? islandLimit : paleLimit;
      if (tail > limit || protectedPixels || maxX - minX + 1 > spanLimit || maxY - minY + 1 > spanLimit) continue;
      if (kind === 'island') {
        // Detached dark line art is meaningful; faint disconnected residue is not.
        if (darkPixels && weight > tail * .5) continue;
      } else {
        if (exposed < tail * .25) continue;
        // A pale patch in the open can be a spark. Only reject ringing that
        // sits against a dark contour, without touching enclosed pale artwork.
        for (let j = 0; j < tail && !nearDark; j++) {
          const p = queue[j], x = p % width, y = Math.floor(p / width);
          for (let dy = -3; dy <= 3 && !nearDark; dy++) for (let dx = -3; dx <= 3; dx++) {
            if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
            const i = (p + dy * width + dx) * 4;
            if (data[i + 3] >= 128 && Math.max(data[i], data[i + 1], data[i + 2]) <= 112) { nearDark = true; break; }
          }
        }
        if (!nearDark) continue;
      }
      for (let j = 0; j < tail; j++) data.fill(0, queue[j] * 4, queue[j] * 4 + 4);
      removedPixels += tail; removedComponents++;
    }
  }
  return { removedPixels, removedComponents };
}

// Only soft, chromatic effects receive this local check. A sub-sprite-pixel
// codec dropout surrounded by the same effect is filled from its neighbours;
// the character's palette, opaque artwork and real gaps remain untouched.
export function smoothVideoEffects(input, data, width, height, background, support, interior = null) {
  const n=width*height, radius=Math.max(1,Math.round(Math.max(width,height)/320));
  const effect=new Uint8Array(n), candidates=new Uint8Array(n), original=data.slice();
  const supported = (buffer,i) => support?.[(buffer[i]>>3)*1024+(buffer[i+1]>>3)*32+(buffer[i+2]>>3)];
  for(let p=0;p<n;p++) {
    const i=p*4;
    if(data[i+3]>8 && !interior?.[p] && !supported(data,i)
      && Math.max(data[i],data[i+1],data[i+2])-Math.min(data[i],data[i+1],data[i+2])>60) {
      effect[p]=1;
      const x=p%width,y=Math.floor(p/width);
      for(let dy=-radius;dy<=radius;dy++)for(let dx=-radius;dx<=radius;dx++)
        if(x+dx>=0&&x+dx<width&&y+dy>=0&&y+dy<height)candidates[p+dy*width+dx]=1;
    }
  }
  let smoothedPixels=0;
  const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
  for(let p=0;p<n;p++)if(candidates[p]) {
    const i=p*4;
    if(interior?.[p] || original[i+3]>=250 || supported(input,i) || original[i+3] && !effect[p])continue;
    if(!original[i+3] && Math.max(...background.map((v,c)=>Math.abs(input[i+c]-v)))<=8)continue;
    const x=p%width,y=Math.floor(p/width), pixels=[];
    let neighbours=0;
    for(let dy=-radius;dy<=radius;dy++)for(let dx=-radius;dx<=radius;dx++) {
      if(x+dx<0||x+dx>=width||y+dy<0||y+dy>=height)continue;
      neighbours++;
      const q=p+dy*width+dx,j=q*4;
      if(effect[q] && Math.max(...[0,1,2].map(c=>Math.abs(input[i+c]-input[j+c])))<=16)pixels.push(j);
    }
    // A majority is needed even for an already visible centre: do not erode a
    // thin intentional spark or bridge a gap between separate trail strokes.
    if(pixels.length<Math.max(5,Math.ceil(neighbours*.65)))continue;
    const alpha=median(pixels.map(j=>original[j+3]));
    if(Math.abs(alpha-original[i+3])<4)continue;
    data[i+3]=alpha;
    for(let c=0;c<3;c++)data[i+c]=median(pixels.map(j=>original[j+c]));
    smoothedPixels++;
  }
  return smoothedPixels;
}

// Closing outline gaps can protect a compressed pale fringe as if it were a
// solid armour highlight. Only revisit exposed pixels next to a dark contour,
// using local decoded backdrop and actual outline colours from this frame.
// Interior highlights and recovered chromatic trails never enter this pass.
export function recoverPaleVideoContour(input, data, width, height, background) {
  if (Math.min(...background) < 128) return 0;
  const radius = Math.max(1, Math.round(Math.max(width, height) / 128));
  const outlineRadius = Math.max(1, Math.round(Math.max(width, height) / 256));
  const changed = new Uint8Array(width * height);
  let recoveredPixels = 0;
  // Revisit at most one extra fringe pixel behind the recovered outer edge.
  // Keep each pass immutable so scan order cannot propagate into the artwork.
  for (let pass = 0; pass < 2; pass++) {
  const original = Uint8Array.from(data);
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    if (original[i + 3] < 128 || Math.min(...original.subarray(i, i + 3)) < 128
      || Math.max(...original.subarray(i, i + 3)) - Math.min(...original.subarray(i, i + 3)) > 100) continue;
    const x = p % width, y = Math.floor(p / width), backdrop = [], outlines = [];
    let exposed = false, paleNeighbours = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
      const j = (p + dy * width + dx) * 4;
      if (original[j + 3] < 128) exposed = true;
      else if (Math.min(...original.subarray(j, j + 3)) >= 128) paleNeighbours++;
    }
    if (!exposed || paleNeighbours >= 5) continue;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      if (!dx && !dy || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
      const j = (p + dy * width + dx) * 4;
      if (original[j + 3] <= 8 && input[j + 3] >= 250
        && Math.max(...background.map((v, c) => Math.abs(input[j + c] - v))) <= 40) backdrop.push(j);
      if (Math.abs(dx) <= outlineRadius && Math.abs(dy) <= outlineRadius
        && original[j + 3] >= 200 && Math.max(...input.subarray(j, j + 3)) <= 112
        && Math.max(...original.subarray(j, j + 3)) <= 112) outlines.push({ j, distance: Math.hypot(dx, dy) });
    }
    if (!backdrop.length || outlines.length < 2) continue;
    const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const bg = [0, 1, 2].map(c => median(backdrop.map(j => input[j + c])));
    const colour = [0, 1, 2].map(c => input[i + c] - bg[c]);
    if (Math.max(...colour.map(Math.abs)) < 16) continue;
    let best;
    for (const { j, distance } of outlines) {
      const foreground = Array.from(input.subarray(j, j + 3)), delta = foreground.map((v, c) => v - bg[c]);
      const alpha = colour.reduce((sum, v, c) => sum + v * delta[c], 0) / delta.reduce((sum, v) => sum + v * v, 0);
      if (alpha <= 0 || alpha > .55) continue;
      const residual = Math.max(...colour.map((v, c) => Math.abs(v - alpha * delta[c])));
      if (residual > 12 + alpha * 16) continue;
      const score = residual + distance * .5;
      if (!best || score < best.score) best = { foreground, alpha, score };
    }
    if (!best) continue;
    data.set(best.foreground, i);
    data[i + 3] = Math.min(original[i + 3], Math.round(input[i + 3] * best.alpha));
    if (!changed[p]) { changed[p] = 1; recoveredPixels++; }
  }
  }
  return recoveredPixels;
}

// Work on the decoded video frame before scaling. Recover edge colours only
// where a nearby opaque pixel supports C = alpha*F + (1-alpha)*background.
export function matteVideoFrame(input, width, height, options) {
  // Colour-only despilling cannot tell grey armour from a translucent glow.
  // Fit mixed edges against nearby foreground colours instead; hardAlpha is
  // applied last so pixel exports receive the same colour recovery as soft ones.
  const result = removeBackground(input, width, height, { ...options, hardAlpha: true });
  if (!options.removeBackground || result.preservedAlpha) return hardenAlpha(result, options.removeBackground && options.hardAlpha);
  const { data, background: bg } = result, n = width * height;
  const interior = options.protectInterior ? outlineInterior(input, width, height, bg, options.tolerance + options.feather, options.foregroundSupport) : null;
  result.restoredInteriorPixels = 0;
  if (interior) for (let p = 0; p < n; p++) if (interior[p]) {
    const i = p * 4;
    if (data[i + 3] < input[i + 3]) result.restoredInteriorPixels++;
    data.set(input.subarray(i, i + 4), i);
  }
  if (options.edgeDecontaminate !== false) {
    const chromaticKey = Math.max(...bg) - Math.min(...bg) > 60;
    const broadRecovery = chromaticKey || options.protectInterior;
    const low = Math.min(...bg), high = Math.max(...bg);
    const highChannels = [0, 1, 2].filter(c => bg[c] > low + (high - low) * .75);
    const lowChannels = [0, 1, 2].filter(c => bg[c] < low + (high - low) * .25);
    const dominance = p => Math.min(...highChannels.map(c => input[p * 4 + c])) - Math.max(...lowChannels.map(c => input[p * 4 + c]));
    const trusted = p => {
      const rgb = [input[p * 4], input[p * 4 + 1], input[p * 4 + 2]];
      // Ignore channels whose tiny remaining range is just codec noise. A
      // saturated cyan effect on a muted green key is still opaque foreground.
      const possibleAlpha = Math.max(...rgb.map((v, c) => {
        const capacity = v < bg[c] ? bg[c] : 255 - bg[c];
        return capacity >= 32 ? Math.abs(v - bg[c]) / capacity : 0;
      }));
      if (possibleAlpha >= .97) return true;
      if (chromaticKey && dominance(p) > 16) return false;
      const maximum = Math.max(...rgb);
      return maximum <= 96 || maximum <= 245 && maximum - Math.min(...rgb) <= 24
        && Math.max(...rgb.map((v,c) => Math.abs(v-bg[c]))) > options.tolerance + options.feather;
    };
    const outlineBarrier = p => trusted(p) || (!chromaticKey || dominance(p) <= 40) && Math.max(input[p * 4], input[p * 4 + 1], input[p * 4 + 2]) <= 160;
    const radius = broadRecovery ? Math.min(128, Math.max(4, Math.round(Math.max(width, height) / 5))) : 3;
    const band = new Uint8Array(n), queue = new Uint32Array(n);
    band.fill(255);
    let head = 0, tail = 0;
    for (let p = 0; p < n; p++) if (!data[p * 4 + 3]) { band[p] = 0; queue[tail++] = p; }
    while (head < tail) {
      const p = queue[head++];
      if (band[p] >= radius) continue;
      // Opaque outlines stop the effect search from entering the character.
      // A long glow can extend far into the key, but a cloak's shading must not
      // be treated as a translucent mixture merely because it fits that model.
      if (broadRecovery && band[p] > 0 && outlineBarrier(p)) continue;
      const x = p % width, y = Math.floor(p / width);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
        const q = p + dy * width + dx;
        if (band[q] !== 255) continue;
        band[q] = band[p] + 1; queue[tail++] = q;
      }
    }
    const originalAlpha = Uint8Array.from({ length: n }, (_, p) => data[p * 4 + 3]);
    const anchorOffsets = [[0,0],[-3,0],[3,0],[0,-3],[0,3],[-8,0],[8,0],[0,-8],[0,8],[-8,-8],[8,-8],[-8,8],[8,8]];
    // Opaque white/cyan effect cores and dark outlines are reliable colour
    // samples. Strong key-hued pixels are mixtures, not foreground anchors.
    let nearest;
    const anchorBins = new Map();
    if (broadRecovery) {
      nearest = new Int32Array(n); nearest.fill(-1); head = 0; tail = 0;
      const distances = new Uint8Array(n); distances.fill(255);
      for (let p = 0; p < n; p++) if (originalAlpha[p] >= 250 && band[p] > 1 && trusted(p)) {
        nearest[p] = p; distances[p] = 0; queue[tail++] = p;
        if (!interior?.[p]) {
          const rgb = Array.from(input.subarray(p*4,p*4+3));
          if (Math.max(...rgb)-Math.min(...rgb)>60) {
            const key = rgb.map(v=>v>>4).join(',');
            const bin=anchorBins.get(key)||[0,0,0,0];bin[0]++;
            for(let c=0;c<3;c++)bin[c+1]+=rgb[c];anchorBins.set(key,bin);
          }
        }
      }
      while (head < tail) {
        const p = queue[head++];
        if (distances[p] >= radius) continue;
        const x = p % width, y = Math.floor(p / width);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
          const q = p + dy * width + dx;
          if (distances[q] !== 255) continue;
          distances[q] = distances[p] + 1; nearest[q] = nearest[p]; queue[tail++] = q;
        }
      }
    }
    // A fading trail may have no opaque core in its final frames. Reuse actual
    // effect colours observed earlier, rather than making its opacity jump to 1.
    result.foregroundAnchors = [...anchorBins.values()].filter(bin=>bin[0]>=Math.max(3,Math.round(n/65536)))
      .sort((a,b)=>b[0]-a[0]).slice(0,64).map(bin=>bin.slice(1).map(v=>Math.round(v/bin[0])));
    const historical = (options.foregroundAnchors || []).filter(rgb => !options.foregroundSupport
      || !options.foregroundSupport[(rgb[0]>>3)*1024+(rgb[1]>>3)*32+(rgb[2]>>3)]);
    for (let p = 0; p < n; p++) {
      // Do not revive pixels already classified as background: generated video
      // can contain a fake checkerboard whose brighter tiles resemble a glow.
      const revival = !originalAlpha[p] && historical.length > 0;
      if ((!originalAlpha[p] && !revival) || band[p] > radius || interior?.[p]) continue;
      // Broad recovery is reserved for key-contaminated effects. Neutral
      // surfaces inside the character only receive the narrow edge treatment.
      if (band[p] > 3 && (!broadRecovery || trusted(p))) continue;
      const i = p * 4, x = p % width, y = Math.floor(p / width);
      const c = [input[i] - bg[0], input[i + 1] - bg[1], input[i + 2] - bg[2]];
      if (revival && Math.max(...c.map(Math.abs)) <= 8) continue;
      const contrast = c.reduce((sum, v) => sum + v * v, 0);
      let bestScore = Infinity, bestAlpha = 1, bestForeground;
      const considerColour = (rgb, penalty, historicalAnchor=false) => {
        const f = Array.from(rgb,(v,channel)=>v-bg[channel]);
        const length = f.reduce((sum,v)=>sum+v*v,0);
        if(length < contrast*(broadRecovery?1.25:1.5) || length<400) return;
        const alpha = c.reduce((sum,v,channel)=>sum+v*f[channel],0)/length;
        if(alpha < (revival ? .02 : .005) || alpha > .95) return;
        const residual = Math.max(...c.map((v,channel)=>Math.abs(v-alpha*f[channel])));
        // The same codec error must have the same allowance on both sides of
        // the initial key threshold. A stricter revival fit punched noisy holes
        // in the middle of a smoothly fading trail.
        if(residual > (revival ? Math.max(12,alpha*32) : broadRecovery ? Math.max(12,alpha*52):6))return;
        if(revival && (!historicalAnchor || Math.max(...c.map(Math.abs))<=8))return;
        const score=residual+penalty;
        if(score<bestScore){bestScore=score;bestAlpha=alpha;bestForeground=rgb;}
      };
      const consider = q => {
        if (q < 0 || originalAlpha[q] < 250 || (!broadRecovery && band[q] <= band[p]) || broadRecovery && !trusted(q)) return;
        const j = q * 4;
        considerColour(input.slice(j,j+3),Math.hypot(q%width-x,Math.floor(q/width)-y)*.2);
      };
      if (band[p] <= 3) for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        if (x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height) consider(p + dy * width + dx);
      }
      if (nearest) for (const [dx, dy] of anchorOffsets) {
        if (x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height) consider(nearest[p + dy * width + dx]);
      }
      if(broadRecovery || revival) for(const rgb of historical)considerColour(rgb,4,true);
      if (bestAlpha === 1) {
        // A colour-only minimum-alpha estimate would turn nonlinear magenta
        // mixtures green. Without a supported foreground, clear strong exterior
        // key specks rather than inventing a new tint; outlines shield artwork.
        if (chromaticKey && !trusted(p) && dominance(p) > Math.max(24, (high - low) * .4)) {
          data[i + 3] = 0; data.fill(0, i, i + 3);
        }
        continue;
      }
      data.set(recoverBackgroundEdge(input, i, bg, options.tolerance, bestAlpha), i);
      // Codec residuals divided by a faint alpha become bright coloured fringes.
      // Use the supported foreground colour instead of amplifying that noise.
      data.set(bestForeground, i);
      if (bestAlpha < .1) {
        const t = Math.min(1, Math.max(0, (Math.max(...c.map(Math.abs)) - 8) / 8));
        data[i + 3] = Math.round(input[i + 3] * bestAlpha * t * t * (3 - 2 * t));
      } else {
        // A verified colour mixture already determines coverage. Multiplying
        // it by the initial tolerance feather creates a second, discontinuous
        // fade as the key drifts, even though the source trail stays smooth.
        data[i + 3] = Math.round(input[i + 3] * bestAlpha);
      }
    }
  }
  result.removedReferenceKeyPixels = 0;
  if (options.foregroundSupport && options.referenceBackground) {
    const reference = [1,3,5].map(i => parseInt(options.referenceBackground.slice(i,i+2),16));
    const low = Math.min(...reference), high = Math.max(...reference);
    const highs = [0,1,2].filter(c => reference[c] > low + (high-low)*.75);
    const lows = [0,1,2].filter(c => reference[c] < low + (high-low)*.25);
    if (high-low > 150) for(let p=0;p<n;p++) {
      const i=p*4;
      if (!data[i+3] || options.foregroundSupport[(input[i]>>3)*1024+(input[i+1]>>3)*32+(input[i+2]>>3)]) continue;
      // A generated contour can retain the original chroma key after the open
      // background has faded to pink/white. The current border key misses it.
      // Require the hue in both decoded and recovered RGB; cyan recovery is safe.
      const keyHue = buffer => Math.min(...highs.map(c=>buffer[i+c])) - Math.max(...lows.map(c=>buffer[i+c])) > 40;
      if (keyHue(input) && keyHue(data)) { data.fill(0,i,i+4); result.removedReferenceKeyPixels++; }
    }
  }
  // Background trapped by two moving outlined parts is still backdrop. Apply
  // this after colour recovery so a verified faint cyan trail (whose recovered
  // RGB is cyan) survives even when its flattened source was nearly white.
  if (options.foregroundSupport) for(let p=0;p<n;p++) {
    const i=p*4;
    if(!data[i+3] || options.foregroundSupport[(input[i]>>3)*1024+(input[i+1]>>3)*32+(input[i+2]>>3)])continue;
    const threshold=options.tolerance+options.feather;
    if(Math.max(...bg.map((v,c)=>Math.abs(input[i+c]-v)))<=threshold
      && Math.max(...bg.map((v,c)=>Math.abs(data[i+c]-v)))<=threshold)data.fill(0,i,i+4);
  }
  result.smoothedEffectPixels = options.foregroundSupport && options.foregroundAnchors?.length
    && options.edgeDecontaminate !== false ? smoothVideoEffects(input,data,width,height,bg,options.foregroundSupport,interior) : 0;
  if (options.edgeDecontaminate !== false && options.despeckle !== false) {
    const protectedArtwork = interior || outlineInterior(input, width, height, bg, options.tolerance + options.feather, options.foregroundSupport);
    const cleaned = cleanVideoSpeckles(data, width, height, protectedArtwork);
    result.removedSpecklePixels = cleaned.removedPixels;
    result.removedSpeckleComponents = cleaned.removedComponents;
  }
  // Clear detached residue before recolouring connected fringes. Recolouring
  // half of a pale island first can hide its remaining white pixels from the
  // pale-component classifier and leave new visible residue after export.
  result.recoveredPaleContourPixels = options.edgeDecontaminate !== false
    ? recoverPaleVideoContour(input, data, width, height, bg) : 0;
  // Optional erosion never crops or recentres individual frames.
  for (let pass = 0; pass < (options.edgeTrim || 0); pass++) {
    const alpha = Uint8Array.from({ length: n }, (_, p) => data[p * 4 + 3]);
    for (let p = 0; p < n; p++) {
      const x = p % width, y = Math.floor(p / width);
      let minimum = alpha[p];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        minimum = Math.min(minimum, x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height ? 0 : alpha[p + dy * width + dx]);
      }
      data[p * 4 + 3] = minimum;
      if (!minimum) data.fill(0, p * 4, p * 4 + 3);
    }
  }
  return hardenAlpha(result, options.hardAlpha);
}
