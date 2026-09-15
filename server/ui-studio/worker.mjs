import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { zipSync, strToU8 } from "fflate";
import { normalizeOptions, removeBackground, findComponents, makeSlices, validateSlices, cropSlice } from "./segmentation.mjs";
import { writeComponentImage } from "./component-images.mjs";

export async function processAtlas({ directory, source, options: input, revision, slices: custom, componentCache = path.join(directory, "component-images") }) {
  const options = normalizeOptions(input);
  const decoded = await sharp(path.join(directory, source), { limitInputPixels: 16777216 }).rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = decoded.info;
  const result = removeBackground(decoded.data, width, height, options);
  // Detection may temporarily key the background without changing exported pixels.
  // Keeping an opaque background must not turn every atlas into one giant component.
  const detectionOnly = !options.removeBackground && !result.preservedAlpha;
  const detection = detectionOnly && options.autoSplit
    ? removeBackground(decoded.data, width, height, { ...options, removeBackground: true }).data : result.data;
  const { labels, components } = findComponents(detection, width, height);
  if (!custom && options.autoSplit && components.filter(c => c.area >= options.minArea).length > 500) {
    throw new Error("检测到超过 500 个碎片，请提高最小面积或调整背景容差后重新切图。");
  }
  const detected = options.autoSplit ? makeSlices(components, width, height, options) : [
    { name: "ui_atlas", x: 0, y: 0, w: width, h: height },
  ];
  const slices = validateSlices(custom || detected, width, height);
  const output = path.join(directory, revision);
  await fs.mkdir(output, { recursive: true });
  const atlas = await sharp(Buffer.from(result.data), { raw: { width, height, channels: 4 } }).png().toBuffer();
  await fs.writeFile(path.join(output, "atlas.png"), atlas);
  const files = {};
  let reusedImages = 0;
  for (const slice of slices) {
    const pixels = cropSlice(result.data, width, detectionOnly ? { ...slice, componentIds: undefined } : slice, labels);
    const png = await sharp(Buffer.from(pixels), { raw: { width: slice.w, height: slice.h, channels: 4 } }).png().toBuffer();
    const { file, contentHash, reused, png: stored } = await writeComponentImage(output, componentCache, png);
    if (reused) reusedImages++;
    files[`sprites/${file}`] = new Uint8Array(stored);
    slice.file = `${revision}/${file}`;
    slice.contentHash = contentHash;
  }
  const manifest = {
    schema: "drawpaint.ui-assets.v1", width, height, origin: "top-left", units: "pixels",
    background: result.background, preservedAlpha: result.preservedAlpha, options,
    slices: slices.map(({ file, componentIds, ...s }) => ({ ...s, file: `sprites/${path.basename(file)}` })),
  };
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(output, "manifest.json"), files["manifest.json"]);
  await fs.writeFile(path.join(output, "ui-assets.zip"), zipSync(files, { level: 0 }));
  return { width, height, slices, revision, reusedImages, atlasFile: `${revision}/atlas.png`, exportFile: `${revision}/ui-assets.zip`,
    manifestFile: `${revision}/manifest.json`, background: result.background, preservedAlpha: result.preservedAlpha,
    ignoredFragments: components.filter(c => c.area < options.minArea).length };
}

if (parentPort) processAtlas(workerData).then(result => parentPort.postMessage({ result }))
  .catch(error => parentPort.postMessage({ error: error.message }));
