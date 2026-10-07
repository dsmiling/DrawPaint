// Check a frame against both neighbours, only where the decoded source and key
// are nearly unchanged. This rejects isolated matte failures without averaging
// moving silhouettes, trails or a newly appearing attack flash.
export function stabilizeVideoMatte(previous, current, next) {
  const data = new Uint8ClampedArray(current.data);
  let stabilizedPixels = 0;
  if (!previous || !next) return { data, stabilizedPixels };
  for (let c = 0; c < 3; c++) if (Math.max(Math.abs(current.background[c] - previous.background[c]), Math.abs(current.background[c] - next.background[c])) > 12) return { data, stabilizedPixels };
  for (let i = 0; i < data.length; i += 4) {
    const alpha = current.data[i + 3], before = previous.data[i + 3], after = next.data[i + 3];
    const alphaSpike = Math.abs(before - after) <= 24
      && Math.min(Math.abs(alpha - before), Math.abs(alpha - after)) >= 16
      && (alpha - before) * (alpha - after) > 0;
    // Alpha can stay constant while the recovered edge colour jumps between
    // foreground anchors. Check visible (premultiplied) colour, so RGB noise in
    // almost transparent pixels cannot trigger corrections.
    let colourSpike = false;
    if (Math.max(Math.abs(alpha-before),Math.abs(alpha-after),Math.abs(before-after)) <= 12) {
      for (let c=0;c<3;c++) {
        const a=previous.data[i+c]*before/255,b=current.data[i+c]*alpha/255,d=next.data[i+c]*after/255;
        if (Math.abs(a-d)<=8 && Math.min(Math.abs(b-a),Math.abs(b-d))>=16 && (b-a)*(b-d)>0) colourSpike=true;
      }
    }
    if (colourSpike && Math.max(...[0,1,2].map(c=>Math.abs(current.data[i+c]-current.input[i+c])))<=12) colourSpike=false;
    if (!alphaSpike && !colourSpike) continue;
    let stableSource = true;
    for (let c = 0; c < 3; c++) if (Math.max(Math.abs(current.input[i + c] - previous.input[i + c]), Math.abs(current.input[i + c] - next.input[i + c])) > 16) { stableSource = false; break; }
    if (!stableSource) continue;
    const target = Math.round((before + after) / 2);
    if (before >= 250 && after >= 250 && !colourSpike) {
      // An opaque hole gets this frame's own decoded artwork back, including
      // its highlights. Never paste the previous pose into the current frame.
      let opaqueSupport = true;
      for (let c = 0; c < 3; c++) if (Math.abs(previous.data[i + c] - previous.input[i + c]) > 12 || Math.abs(next.data[i + c] - next.input[i + c]) > 12) { opaqueSupport = false; break; }
      if (!opaqueSupport) continue;
      data.set(current.input.subarray(i, i + 3), i);
    } else if (target) {
      for (let c = 0; c < 3; c++) data[i + c] = Math.round((previous.data[i + c] * before + next.data[i + c] * after) / (before + after));
    } else data.fill(0, i, i + 3);
    data[i + 3] = target;
    stabilizedPixels++;
  }
  return { data, stabilizedPixels };
}
