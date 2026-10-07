import sharp from "sharp";
import { detectBackground } from "../shared/background-removal.mjs";
import { matteVideoFrame } from "../shared/video-matting.mjs";
import { normalizeFrameAnimation } from "../shared/frame-animation.js";

async function decodeReference(buffer, label) {
  const { data, info } = await sharp(buffer, { limitInputPixels: 16777216 }).rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info, rgb = detectBackground(data, width, height);
  let border = 0, transparentBorder = 0, matchingBorder = 0;
  const sample = (x, y) => {
    const p = (y * width + x) * 4; border++;
    if (data[p + 3] === 0) transparentBorder++;
    if (Math.max(...rgb.map((v, c) => Math.abs(v - data[p + c]))) <= 16) matchingBorder++;
  };
  for (let x = 0; x < width; x++) { sample(x, 0); sample(x, height - 1); }
  for (let y = 1; y < height - 1; y++) { sample(0, y); sample(width - 1, y); }
  const nativeAlpha = transparentBorder / border > .75;
  if (!nativeAlpha && matchingBorder / border < .96) throw new Error(`${label}背景不够均匀或主体贴边。请先在素材工坊准备透明图或纯色底图，再生成帧动画视频。`);
  const knownKey = [[255, 0, 255], [0, 255, 0]].some(key => Math.max(...rgb.map((v, c) => Math.abs(v - key[c]))) <= 25);
  const pixels = nativeAlpha ? new Uint8ClampedArray(data) : matteVideoFrame(data, width, height, { removeBackground: true, background: "auto", removalMode: knownKey ? "color" : "edge", tolerance: 12, feather: 4, edgeDecontaminate: true, edgeTrim: 0 }).data;
  let visible = 0, magenta = 0, green = 0;
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 4;
    if (pixels[p + 3] <= 8) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    if (pixels[p + 3] < 200) continue;
    visible++;
    if (pixels[p] > 150 && pixels[p + 2] > 150 && pixels[p + 1] < 120 && Math.abs(pixels[p] - pixels[p + 2]) < 110) magenta++;
    if (pixels[p + 1] > 140 && pixels[p] < 120 && pixels[p + 2] < 120) green++;
  }
  if (right < 0) throw new Error(`${label}剔除背景后为空，请使用主体与底色明显不同的图片。`);
  return { pixels, width, height, nativeAlpha, sourceBackground: `#${rgb.map(c => c.toString(16).padStart(2, "0")).join("")}`, magenta: magenta > Math.max(2, visible * .001), green: green > Math.max(2, visible * .001), needsPadding: left < width * .04 || top < height * .04 || right >= width * .96 || bottom >= height * .96 };
}

// Both reference frames use the same key and padding decision, keeping motion
// alignment stable. Originals remain untouched; only model input copies change.
export async function prepareAnimationReferences(image, lastImage, value) {
  const settings = normalizeFrameAnimation(value);
  if (!settings.enabled) return { image, lastImage, settings };
  const refs = await Promise.all([decodeReference(image, "起始帧"), ...(lastImage ? [decodeReference(lastImage, "尾帧")] : [])]);
  const magenta = refs.some(ref => ref.magenta), green = refs.some(ref => ref.green);
  const background = settings.background === "auto" ? magenta ? "#00ff00" : "#ff00ff" : settings.background;
  if (background === "#ff00ff" ? magenta : green) throw new Error(`主体含有与${background === "#ff00ff" ? "品红" : "绿色"}底色相近的颜色，请更换底色或先调整素材。`);
  const padded = refs.some(ref => ref.needsPadding);
  const buffers = await Promise.all(refs.map(async ref => {
    const contentWidth = padded ? Math.max(1, ref.width - 2 * Math.ceil(ref.width * .04)) : ref.width;
    const contentHeight = padded ? Math.max(1, ref.height - 2 * Math.ceil(ref.height * .04)) : ref.height;
    const content = await sharp(Buffer.from(ref.pixels), { raw: { width: ref.width, height: ref.height, channels: 4 } }).resize(contentWidth, contentHeight, { kernel: "linear" }).png().toBuffer();
    return sharp({ create: { width: ref.width, height: ref.height, channels: 4, background } }).composite([{ input: content, left: Math.floor((ref.width - contentWidth) / 2), top: Math.floor((ref.height - contentHeight) / 2) }]).removeAlpha().png().toBuffer();
  }));
  return { image: buffers[0], lastImage: buffers[1] || null, settings: { enabled: true, background }, preparation: { background, padded, references: refs.map(ref => ({ sourceBackground: ref.sourceBackground, nativeAlpha: ref.nativeAlpha })) } };
}
