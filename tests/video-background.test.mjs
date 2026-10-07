import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { normalizeVideoBackground, VIDEO_BACKGROUND_VERSION } from "../server/video-background.mjs";
import { createGeneratedVideoStore } from "../server/video-generated.mjs";
import { stabilizeVideoMatte } from "../shared/video-matte-stability.mjs";

test('temporal checking fixes isolated matte jumps using current artwork and preserves moving edges and flashes',()=>{
  const frame=(input,data,background=[255,0,255])=>({input:Uint8Array.from(input),data:Uint8ClampedArray.from(data),background});
  const source=[240,240,230,255,240,120,240,255,255,0,255,255];
  const previous=frame(source,[240,240,230,255,250,250,250,128,0,0,0,0]);
  const next=frame(source,[240,240,230,255,250,250,250,128,0,0,0,0]);
  const current=frame([244,237,229,255,240,120,240,255,255,255,255,255],[0,0,0,0,250,250,250,24,255,255,255,255]);
  const saved=current.data.slice(),result=stabilizeVideoMatte(previous,current,next);
  assert.deepEqual(Array.from(result.data.subarray(0,4)),[244,237,229,255],'fill a hole with this frame, never the previous highlight');
  assert.deepEqual(Array.from(result.data.subarray(4,8)),[250,250,250,128],'a stable glow retains fractional alpha');
  assert.deepEqual(Array.from(result.data.subarray(8,12)),[255,255,255,255],'a real new attack flash is preserved');
  assert.equal(result.stabilizedPixels,2);
  assert.deepEqual(current.data,saved,'neighbour buffers must remain unfiltered and immutable');
  assert.deepEqual(stabilizeVideoMatte(null,current,next).data,current.data,'the first frame is preserved');
  assert.deepEqual(stabilizeVideoMatte(previous,current,null).data,current.data,'the last frame is preserved');
  const changingKey={...next,background:[220,230,100]};
  assert.deepEqual(stabilizeVideoMatte(previous,current,changingKey).data,current.data,'do not blur across a key-colour scene change');
  const moving={...current,input:Uint8Array.from([20,20,20,255,20,20,20,255,255,255,255,255])};
  assert.deepEqual(stabilizeVideoMatte(previous,moving,next).data,moving.data,'moving silhouettes receive no temporal averaging');
});

test('temporal checking catches small alpha and recovered-colour spikes while preserving a monotonic fade',()=>{
  const input=Uint8Array.from([160,170,165,255,160,170,165,255,160,170,165,255]);
  const frame=data=>({input,data:Uint8ClampedArray.from(data),background:[250,247,250]});
  const previous=frame([0,210,190,128,0,210,190,128,0,210,190,100]);
  const current=frame([0,210,190,104,65,145,125,128,0,210,190,80]);
  const next=frame([0,210,190,128,0,210,190,128,0,210,190,60]);
  const result=stabilizeVideoMatte(previous,current,next);
  assert.deepEqual([...result.data.subarray(0,8)],[0,210,190,128,0,210,190,128]);
  assert.deepEqual([...result.data.subarray(8,12)],[0,210,190,80],'a fading trail is not temporally flattened');
  assert.equal(result.stabilizedPixels,2);
});

test('a corrected past stops repeated static matte flicker without feeding the opaque composite back into alpha',()=>{
  const frames=[128,104,128,104,128,128].map(alpha=>({input:Uint8Array.from([160,170,165,255]),data:Uint8ClampedArray.from([0,210,190,alpha]),background:[250,247,250]}));
  let previous=null;
  const alphas=[];
  for(let f=0;f<frames.length;f++) {
    const stable=stabilizeVideoMatte(previous,frames[f],frames[f+1]);
    previous={...frames[f],data:stable.data};alphas.push(stable.data[3]);
  }
  assert.deepEqual(alphas,[128,128,128,128,128,128]);
  assert.equal(frames[1].data[3],104,'the model/matte source buffers remain unchanged');
});

test("background normalization is serial, shared by readers and durable without changing originals", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drawpaint-background-cache-"));
  try {
    const canvasDir = path.join(root, "DrawPaint", "canvas"), directory = path.join(canvasDir, "video-generated");
    fs.mkdirSync(directory, { recursive: true });
    for (const id of ["one", "two", "ordinary"]) fs.writeFileSync(path.join(directory, `${id}.mp4`), `original ${id}`);
    const jobOptions = Object.fromEntries(["one", "two", "ordinary"].map(id => [id, { lockBackground: true, frameAnimation: { enabled: id !== "ordinary", background: "#ff00ff" } }]));
    let active = 0, peak = 0, calls = 0;
    const normalizeBackground = async ({ input, output, background }) => {
      active++; calls++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 15));
      fs.writeFileSync(output, `fixed ${path.basename(input)}`); active--;
      const alphaFile = path.basename(output).replace(/\.mp4$/, '.alpha.mkv');
      fs.writeFileSync(path.join(path.dirname(output), alphaFile), 'lossless fractional RGBA');
      return { version: VIDEO_BACKGROUND_VERSION, background, alphaFile };
    };
    const options = { canvasDir, jobOptions, comfyJson: async () => { throw new Error("offline"); }, videoOutput: () => null, normalizeBackground };
    const store = createGeneratedVideoStore(options);
    const pending = await store.resolve("one", { wait: false }); assert.equal(pending.processing, true);
    const files = await Promise.all([store.resolve("one"), store.resolve("two"), store.resolve("one")]);
    assert.equal(peak, 1); assert.equal(calls, 2); assert.equal(files[0].file, files[2].file);
    assert.equal(fs.readFileSync(path.join(directory, "one.mp4"), "utf8"), "original one");
    assert.equal((await store.resolveRaw('one')).file, path.join(directory, 'one.mp4'), 'raw access always reads the unchanged model video');
    assert.equal(fs.readFileSync((await store.resolveForFrames('one')).file, 'utf8'), 'lossless fractional RGBA');
    assert.equal((await store.resolve("ordinary")).file, path.join(directory, "ordinary.mp4"));
    const restarted = createGeneratedVideoStore({ ...options, normalizeBackground: async () => { throw new Error("must not repeat work"); } });
    assert.equal((await restarted.resolve("one")).file, files[0].file);
    assert.equal((await restarted.resolveForFrames('one')).preservedAlpha, true, 'restart reuses the lossless alpha master');
    const failed = createGeneratedVideoStore({ ...options, jobOptions: { ordinary: { lockBackground: true, frameAnimation: { enabled: true, background: "#ff00ff" } } }, normalizeBackground: async () => { throw new Error("unreliable matte"); } });
    await assert.rejects(failed.resolve("ordinary"), /unreliable matte/);
    assert.equal((await failed.resolve("ordinary", { wait: false })).processingError, "unreliable matte");
    assert.equal(fs.readFileSync(path.join(directory, "ordinary.mp4"), "utf8"), "original ordinary");
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

let ffmpeg = true;
try { execFileSync("ffmpeg", ["-version"], { windowsHide: true, stdio: "ignore" }); } catch { ffmpeg = false; }
test("actual changing video backgrounds become one key while white and silver foreground, timing and audio survive", { skip: !ffmpeg }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drawpaint-background-video-"));
  try {
    const width = 64, height = 64, colors = [[255,0,255], [230,220,100], [255,255,255], [70,210,160]], frames = [];
    for (const color of colors) {
      const rgba = Buffer.alloc(width * height * 4);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const inside = x >= 18 && x < 46 && y >= 14 && y < 50 || x < 4 && y >= 22 && y < 42;
        const interior = x >= 22 && x < 42 && y >= 18 && y < 46;
        const silver = x >= 22 && x < 30 && y >= 24 && y < 40;
        const bg = color.map(c => Math.max(0, Math.min(255, c + (x % 3 - 1) * 3)));
        rgba.set([...(inside ? interior ? silver ? [176,170,184] : [240,240,240] : [21,20,21] : bg),255], (y*width+x)*4);
        if(x>=32 && x<40 && y>=34 && y<40) rgba.set([245,210,100,255],(y*width+x)*4);
        if (x >= 49 && x < 54 && y >= 26 && y < 38) rgba.set([...color.map(c=>Math.round(c*.5+255*.5)),255],(y*width+x)*4);
        if (x >= 54 && x < 58 && y >= 26 && y < 38) rgba.set([255,255,255,255],(y*width+x)*4);
      }
      frames.push(rgba);
    }
    const input = path.join(root, "source.mp4"), output = path.join(root, "fixed.mp4");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "64x64", "-framerate", "4", "-i", "pipe:0", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264rgb", "-crf", "0", "-c:a", "aac", "-shortest", input], { input: Buffer.concat(frames), windowsHide: true });
    const original = fs.readFileSync(input);
    const report = await normalizeVideoBackground({ input, output, background: "#ff00ff" });
    assert.equal(report.frames, 4); assert.equal(report.fps, 4); assert.equal(report.changedFrames, 3);
    assert.deepEqual(fs.readFileSync(input), original);
    const alpha = execFileSync('ffmpeg', ['-v','error','-i',path.join(root,report.alphaFile),'-f','rawvideo','-pix_fmt','rgba','pipe:1'], {windowsHide:true});
    assert.equal(alpha.length, 4*width*height*4);
    assert.ok(report.partialAlphaPixels > 0, 'normalization must retain fractional alpha before compositing MP4');
    assert.ok(report.restoredInteriorPixels>0,'a drifted yellow key must trigger solid interior protection');
    for(let frame=0;frame<4;frame++) {
      const beak=(frame*width*height+36*width+36)*4;
      assert.deepEqual(Array.from(alpha.subarray(beak,beak+4)),[245,210,100,255],'normalization preserves the beak through changing key colours');
    }
    for (const frame of [0,1,3]) {
      const i=(frame*width*height+32*width+51)*4;
      assert.ok(Math.abs(alpha[i+3]-128)<=3,`lossless master retains the half-transparent glow: frame ${frame}, RGBA ${Array.from(alpha.subarray(i,i+4))}`);
      for(let c=0;c<3;c++) assert.ok(alpha[i+c]>=250,'glow RGB is restored before alpha encoding');
      assert.equal(alpha[frame*width*height*4+3],0,'master corners stay transparent');
    }
    const decoded = execFileSync("ffmpeg", ["-v", "error", "-i", output, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { windowsHide: true });
    assert.equal(decoded.length, 4 * width * height * 4);
    for (let frame = 0; frame < 4; frame++) {
      const offset = frame * width * height * 4;
      for (const p of [0, width-1, (height-1)*width, width*height-1]) for (let c = 0; c < 3; c++) assert.ok(Math.abs(decoded[offset+p*4+c]-[255,0,255][c]) <= 5);
      const white = offset + (32*width+32)*4;
      for (let c = 0; c < 3; c++) assert.ok(decoded[white+c] >= 225, "white helmet interior remains opaque");
      const silver = offset + (32*width+26)*4;
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(decoded[silver+c]-[176,170,184][c]) <= 15, "silver armour retains its colour without turning green");
    }
    const metadata = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", output], { windowsHide: true }));
    assert.equal(metadata.streams.find(s=>s.codec_type==="video").avg_frame_rate, "4/1");
    assert.ok(metadata.streams.some(s=>s.codec_type==="audio"));
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
