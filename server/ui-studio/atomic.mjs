import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function replaceFile(source, target, rename = fs.renameSync, pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)) {
  for (let attempt = 0; ; attempt++) {
    try { rename(source, target); return; }
    catch (error) {
      // Windows scanners may briefly hold the destination. Never unlink the old file.
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 5) throw error;
      pause(20 * (attempt + 1));
    }
  }
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2));
    replaceFile(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* Keep the original failure. */ }
    throw error;
  }
}
