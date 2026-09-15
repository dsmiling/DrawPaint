import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";

// Compare decoded pixels, not PNG encoding or names. Dimensions and alpha matter.
export async function writeComponentImage(output, cache, image) {
  const { data, info } = await sharp(image).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] === 0) data.fill(0, i, i + 3);
  const contentHash = createHash("sha256").update(`${info.width}x${info.height}:rgba:`).update(data).digest("hex");
  const file = `${contentHash}.png`, target = path.join(cache, file);
  const png = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  await fs.mkdir(cache, { recursive: true });
  const temporary = path.join(cache, `${randomUUID()}.tmp`);
  let reused = false;
  try {
    await fs.writeFile(temporary, png);
    // Publish a complete file atomically; two workers can discover the same image.
    try { await fs.link(temporary, target); }
    catch (error) { if (error.code !== "EEXIST") throw error; reused = true; }
  } finally { await fs.rm(temporary, { force: true }); }
  try { await fs.link(target, path.join(output, file)); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  return { file, contentHash, reused, png };
}
