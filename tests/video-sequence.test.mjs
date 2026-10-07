import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import sharp from "sharp";
import { unzipSync, strFromU8 } from "fflate";
import { createVideoEditor } from "../server/video-editor.mjs";
import { buildClipSequenceArgs, normalizeSequenceOptions, packageSequence } from "../server/video-sequence.mjs";
import { matteVideoFrame, foregroundColorSupport, smoothVideoEffects, recoverPaleVideoContour } from "../shared/video-matting.mjs";
import { createGeneratedVideoStore } from "../server/video-generated.mjs";
import { videoFrameRange } from "../shared/video-frame-range.js";

test("sequence export bounds frame count and memory while retaining aspect ratio", () => {
  const options = normalizeSequenceOptions({}, 5.166667, { width: 960, height: 540 });
  assert.equal(options.frameCount, 62);
  assert.deepEqual([options.width, options.height], [512, 288]);
  assert.equal(normalizeSequenceOptions({}, 0.01, { width: 64, height: 48 }).frameCount, 1);
  assert.throws(() => normalizeSequenceOptions({ fps: 61 }, 2, { width: 640, height: 640 }), /帧率/);
  assert.throws(() => normalizeSequenceOptions({ fps: 1.5 }, 2, { width: 640, height: 640 }), /帧率/);
  assert.throws(() => normalizeSequenceOptions({ imageFormat: "jpeg" }, 2, { width: 640, height: 640 }), /PNG/);
  assert.throws(() => normalizeSequenceOptions({}, 101, { width: 640, height: 640 }), /1200/);
  assert.throws(() => normalizeSequenceOptions({ maxSize: 2048 }, 90, { width: 2048, height: 2048 }), /总尺寸/);
  assert.throws(() => normalizeSequenceOptions({}, 2, { width: NaN, height: 640 }), /视频尺寸/);
  assert.throws(() => normalizeSequenceOptions({ backgroundRemoval: { background: "red" } }, 2, { width: 64, height: 48 }), /背景色/);
  assert.throws(() => normalizeSequenceOptions({ backgroundRemoval: { tolerance: 151 } }, 2, { width: 64, height: 48 }), /容差/);
  assert.throws(() => normalizeSequenceOptions({ backgroundRemoval: { feather: -1 } }, 2, { width: 64, height: 48 }), /过渡/);
  assert.throws(() => normalizeSequenceOptions({ backgroundRemoval: { removalMode: "unknown" } }, 2, { width: 64, height: 48 }), /方式/);
  assert.throws(() => normalizeSequenceOptions({ backgroundRemoval: { edgeTrim: 4 } }, 2, { width: 64, height: 48 }), /收缩/);
  assert.throws(() => normalizeSequenceOptions({ backgroundRemoval: { edgeDecontaminate: "true" } }, 2, { width: 64, height: 48 }), /净化/);
  assert.throws(() => normalizeSequenceOptions({ fps: 6, maxSize: 256, backgroundRemoval: { removeBackground: true } }, 30, { width: 2048, height: 2048 }), /抠图处理/);
});

test("small pixel exports preserve hard alpha and sampled colours in frames and atlas", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drawpaint-pixel-frames-"));
  try {
    const width = 128, height = 128, pixels = Buffer.alloc(width * height * 4);
    const colours = [[240, 30, 20, 255], [20, 220, 40, 255], [250, 245, 250, 255]];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      pixels.set(x >= 31 && x < 96 && y >= 31 && y < 96 ? colours[Math.floor(x / 3) % colours.length] : [253, 3, 253, 255], (y * width + x) * 4);
    }
    fs.mkdirSync(path.join(root, "frames"));
    await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toFile(path.join(root, "frames", "frame-000000.png"));
    const options = normalizeSequenceOptions({ fps: 8, maxSize: 64, resampling: "nearest", backgroundRemoval: { removeBackground: true, background: "#ff00ff", feather: 0, edgeDecontaminate: false, hardAlpha: true } }, .125, { width, height });
    assert.deepEqual([options.width, options.height], [64, 64]);
    assert.match(buildClipSequenceArgs({ in: 0, out: .125 }, "video.mp4", "frame.png", options).join(" "), /flags=neighbor/);
    assert.equal(normalizeSequenceOptions({ maxSize: 128 }, 1, { width: 256, height: 256 }).width, 128);
    assert.throws(() => normalizeSequenceOptions({ resampling: "invalid" }, 1, { width, height }), /缩放/);
    const manifest = await packageSequence(root, options, { name: "像素导出", source: {}, sourceDuration: .125 }, path.join(root, "animation.zip"));
    assert.equal(manifest.resampling, "nearest");
    const decoded = await sharp(path.join(root, manifest.frames[0].file)).ensureAlpha().raw().toBuffer();
    let visible = 0, transparent = 0;
    for (let p = 0; p < decoded.length; p += 4) {
      const rgba = Array.from(decoded.subarray(p, p + 4));
      assert.ok(rgba[3] === 0 || rgba[3] === 255, "pixel export must not introduce soft alpha");
      if (rgba[3]) { visible++; assert.ok(colours.some(colour => colour.every((value, c) => value === rgba[c])), "nearest resize must not invent blended colours"); }
      else transparent++;
    }
    assert.ok(visible > 0 && transparent > 0);
    const atlas = await sharp(path.join(root, manifest.sheets[0].file)).ensureAlpha().raw().toBuffer();
    assert.deepEqual(atlas, decoded);
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("video edge cleanup recovers pale and black antialias colours without changing the interior or source", () => {
  for (const foreground of [[230, 240, 250], [0, 0, 0]]) {
    const width = 20, height = 20, background = [80, 90, 100], input = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < width * height; p++) input.set([...background, 255], p * 4);
    for (let y = 5; y <= 14; y++) for (let x = 5; x <= 14; x++) {
      const alpha = x === 5 || x === 14 || y === 5 || y === 14 ? .5 : 1;
      input.set([...foreground.map((v, c) => Math.round(v * alpha + background[c] * (1 - alpha))), 255], (y * width + x) * 4);
    }
    const saved = input.slice(), options = { removeBackground: true, background: "#505a64", removalMode: "edge", tolerance: 8, feather: 0 };
    const output = matteVideoFrame(input, width, height, options).data;
    const edge = (10 * width + 5) * 4, interior = (10 * width + 10) * 4;
    assert.ok(Math.abs(output[edge + 3] - 128) <= 2);
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(output[edge + c] - foreground[c]) <= 2);
    assert.deepEqual(output.slice(interior, interior + 4), input.slice(interior, interior + 4));
    assert.deepEqual(input, saved);
    assert.equal(matteVideoFrame(input, width, height, { ...options, edgeDecontaminate: false }).data[edge + 3], 255);
    const trimmed = matteVideoFrame(input, width, height, { ...options, edgeTrim: 1 }).data;
    assert.equal(trimmed[edge + 3], 0);
    assert.equal(trimmed[interior + 3], 255);
    const rgba = new Uint8ClampedArray(width * height * 4);
    rgba.set([40, 60, 80, 128], interior);
    assert.deepEqual(matteVideoFrame(rgba, width, height, { ...options, edgeTrim: 3 }).data, rgba);
  }
});

test("effect edges recover foreground colours before soft or hard alpha without tinting silver details", () => {
  for (const background of [[255,0,255], [0,255,0], [249,6,244], [93,208,158]]) for (const foreground of [[255,255,255], [0,255,255]]) {
    const width = 256, height = 64, input = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < width * height; p++) input.set([...background,255], p * 4);
    for (let y = 8; y < 48; y++) for (let x = 68; x < 101; x++) {
      const alpha = x < 80 ? (x-67)/13 : x > 88 ? (101-x)/13 : 1;
      input.set([...foreground.map((c,k)=>Math.round(c*alpha+background[k]*(1-alpha))),255],(y*width+x)*4);
    }
    for (let y=12;y<40;y++) for(let x=130;x<150;x++) input.set([176,170,184,255],(y*width+x)*4);
    const source = input.slice();
    const options = {removeBackground:true,background:`#${background.map(c=>c.toString(16).padStart(2,'0')).join('')}`,removalMode:'color',tolerance:12,feather:0,edgeDecontaminate:true,edgeTrim:0};
    const soft = matteVideoFrame(input,width,height,options).data;
    const edge = (24*width+74)*4, silver=(24*width+135)*4;
    for(let c=0;c<3;c++) assert.ok(Math.abs(soft[edge+c]-foreground[c])<=4, `effect colour must be recovered: ${Array.from(soft.slice(edge,edge+4))}`);
    assert.ok(Math.abs(soft[edge+3]-Math.round(7/13*255))<=4, 'glow opacity survives without opaque key-coloured blocks');
    assert.deepEqual(soft.slice(silver,silver+4),input.slice(silver,silver+4));
    const hard=matteVideoFrame(input,width,height,{...options,hardAlpha:true}).data;
    assert.equal(hard[edge+3],255);
    for(let c=0;c<3;c++) assert.ok(Math.abs(hard[edge+c]-foreground[c])<=4);
    assert.equal(hard[(24*width+69)*4+3],0, 'weak contaminated glow is removed in pixel mode');
    assert.deepEqual(input,source);
    const disabled=matteVideoFrame(input,width,height,{...options,edgeDecontaminate:false}).data;
    assert.deepEqual(disabled.slice(edge,edge+4),input.slice(edge,edge+4));
  }
});

test("opaque outlines shield cloak shading while exterior key-coloured specks are removed", () => {
  const width=256,height=64,input=new Uint8ClampedArray(width*height*4), bg=[93,208,158];
  for(let p=0;p<width*height;p++) input.set([...bg,255],p*4);
  for(let y=10;y<46;y++) for(let x=70;x<130;x++) {
    const outline=x===70||x===129||y===10||y===45;
    input.set([...(outline?[16,16,16]:(x%2?[25,38,70]:[39,72,88])),255],(y*width+x)*4);
  }
  for(let y=20;y<26;y++) input.set([39,72,88,255],(y*width+70)*4);
  input.set([105,222,166,255],(35*width+150)*4);
  const options={removeBackground:true,background:'#5dd09e',removalMode:'color',tolerance:12,feather:0,edgeDecontaminate:true,hardAlpha:true};
  const result=matteVideoFrame(input,width,height,options).data;
  for(let y=12;y<44;y++) for(let x=72;x<128;x++) {
    const i=(y*width+x)*4;
    assert.deepEqual(result.slice(i,i+4),input.slice(i,i+4),'interior cloak shading must remain byte-identical');
  }
  assert.equal(result[(35*width+150)*4+3],0,'unexplained isolated key speck is cleared');
});

test('soft video recovery does not revive painted checkerboard tiles as translucent glow',()=>{
  const width=64,height=64,input=new Uint8ClampedArray(width*height*4),key=[93,208,158];
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) input.set([...(Math.floor(x/8)%2===Math.floor(y/8)%2?[126,224,179]:key),255],(y*width+x)*4);
  for(let y=20;y<44;y++) for(let x=20;x<44;x++) input.set([255,255,255,255],(y*width+x)*4);
  for(let y=24;y<40;y++) for(let x=44;x<48;x++) input.set([...key.map(c=>Math.round(c*.5+255*.5)),255],(y*width+x)*4);
  const result=matteVideoFrame(input,width,height,{removeBackground:true,background:'#5dd09e',removalMode:'color',tolerance:55,feather:8,hardAlpha:false}).data;
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) if(x<20||x>=48||y<20||y>=44) assert.equal(result[(y*width+x)*4+3],0,'painted background tiles must remain removed');
  const edge=(32*width+46)*4;
  assert.ok(Math.abs(result[edge+3]-128)<=2);
  assert.deepEqual(Array.from(result.slice(edge,edge+3)),[255,255,255]);
});

test('a drifted key cannot punch holes in outlined artwork or preserve backdrop enclosed by a white effect',()=>{
  const width=96,height=72,key=[226,241,104],input=new Uint8ClampedArray(width*height*4);
  for(let p=0;p<width*height;p++) input.set([...key,255],p*4);
  for(let y=10;y<44;y++) for(let x=10;x<42;x++) input.set([...(x<13||x>=39||y<13||y>=41?[16,16,16]:[230,230,230]),255],(y*width+x)*4);
  for(let y=24;y<30;y++) for(let x=24;x<37;x++) input.set([245,210,100,255],(y*width+x)*4);
  for(let y=14;y<44;y++) for(let x=52;x<85;x++) if(x<55||x>=82||y<17||y>=41) input.set([255,255,255,255],(y*width+x)*4);
  const options={removeBackground:true,background:'#e2f168',removalMode:'color',tolerance:55,feather:8,hardAlpha:false};
  const beak=(27*width+30)*4,source=input.slice();
  assert.equal(matteVideoFrame(input,width,height,options).data[beak+3],0,'old colour-wide removal reproduces the missing beak');
  const result=matteVideoFrame(input,width,height,{...options,protectInterior:true});
  assert.deepEqual(Array.from(result.data.slice(beak,beak+4)),[245,210,100,255],'opaque beak is preserved even though its colour matches the drifted key');
  assert.ok(result.restoredInteriorPixels>0);
  assert.equal(result.data[(28*width+65)*4+3],0,'a white glow loop must not protect background inside it');
  assert.equal(result.data[3],0);
  assert.deepEqual(input,source,'source pixels remain untouched');
});

test('local contour recovery removes pale backdrop from protected edge pixels without eroding enclosed highlights or light effects',()=>{
  const width=64,height=64,bg=[250,240,248],local=[246,228,243],outline=[24,32,28];
  const input=Buffer.alloc(width*height*4),matte=Buffer.alloc(input.length);
  for(let p=0;p<width*height;p++)input.set([...local,255],p*4);
  for(let y=16;y<48;y++)for(let x=20;x<40;x++) {
    const colour=x===20||x===39||y===16||y===47?outline:[225,220,230];
    const i=(y*width+x)*4;input.set([...colour,255],i);matte.set([...colour,255],i);
  }
  const edge=(32*width+39)*4,highlight=(30*width+34)*4,cyan=(32*width+50)*4,white=(16*width+40)*4;
  const mixed=local.map((v,c)=>Math.round(v*.8+outline[c]*.2));
  input.set([...mixed,255],edge);matte.set([...mixed,255],edge);
  input.set([200,240,239,255],cyan);matte.set([0,210,190,112],cyan);
  input.set([255,255,255,255],white);matte.set([255,255,255,255],white);
  const savedInput=Buffer.from(input),savedMatte=Buffer.from(matte);
  assert.ok(recoverPaleVideoContour(input,matte,width,height,bg)>0);
  assert.deepEqual([...matte.subarray(edge,edge+3)],outline);
  assert.ok(Math.abs(matte[edge+3]-51)<=2,'coverage comes from the local backdrop mixture, not a hard deletion');
  for(const i of [highlight,cyan,white])assert.deepEqual(matte.subarray(i,i+4),savedMatte.subarray(i,i+4),'enclosed white stone, recovered cyan and a real white flash retain their RGBA');
  assert.deepEqual(input,savedInput,'decoded model pixels remain immutable');
  assert.equal(matte[3],0,'background is not revived');
});

test('closed-outline palette protection cannot keep a pale mixed contour fully opaque',()=>{
  const width=64,height=64,bg=[250,240,248],input=new Uint8ClampedArray(width*height*4),outline=[24,32,28];
  for(let p=0;p<width*height;p++)input.set([...bg,255],p*4);
  for(let y=16;y<48;y++)for(let x=20;x<40;x++)input.set([...(x===20||x===39||y===16||y===47?outline:[220,215,225]),255],(y*width+x)*4);
  const edge=(32*width+39)*4,mixed=bg.map((v,c)=>Math.round(v*.8+outline[c]*.2));
  input.set([...mixed,255],edge);
  const reference=Uint8ClampedArray.from([...mixed,255]),support=foregroundColorSupport(reference,reference,1,1);
  const options={removeBackground:true,background:'#faf0f8',removalMode:'edge',tolerance:55,feather:8,protectInterior:true,foregroundSupport:support,despeckle:false};
  const before=matteVideoFrame(input,width,height,{...options,edgeDecontaminate:false});
  assert.equal(before.data[edge+3],255,'the closed outline and pale palette reproduce the opaque residual');
  const after=matteVideoFrame(input,width,height,options);
  assert.ok(after.recoveredPaleContourPixels>0);
  assert.deepEqual([...after.data.subarray(edge,edge+3)],outline);
  assert.ok(Math.abs(after.data[edge+3]-51)<=2);
  assert.deepEqual([...after.data.subarray((30*width+30)*4,(30*width+30)*4+4)],[220,215,225,255]);
});

test('small pale residue is removed before local colour recovery can hide it from despeckling',()=>{
  const width=128,height=96,input=new Uint8ClampedArray(width*height*4),background=[250,240,248],local=[250,220,255];
  for(let p=0;p<width*height;p++)input.set([...local,255],p*4);
  for(let y=30;y<70;y++)for(let x=40;x<80;x++)input.set([...(x===40||x===79||y===30||y===69?[16,16,16]:[85,85,85]),255],(y*width+x)*4);
  const pale=local.map(v=>Math.round(v*.85+16*.15));
  for(let y=48;y<50;y++)input.set([...pale,255],(y*width+39)*4);
  const options={removeBackground:true,background:'#faf0f8',removalMode:'color',tolerance:45,feather:0,hardAlpha:false};
  const p=(48*width+39)*4,without=matteVideoFrame(input,width,height,{...options,despeckle:false});
  assert.ok(without.data[p+3]>0 && without.data[p+3]<128,'local recovery alone turns the pale patch into a dark fringe');
  const cleaned=matteVideoFrame(input,width,height,options);
  assert.equal(cleaned.data[p+3],0,'component cleanup still clears the entire small residue');
  assert.ok(cleaned.removedSpecklePixels>=2);
  assert.equal(cleaned.recoveredPaleContourPixels,0,'cleared pixels cannot be restored by the contour pass');
});

test('video despeckling clears detached and contour-connected pale ringing while preserving highlights and soft effects',()=>{
  for(const scale of [1,5]) {
    const width=128*scale,height=128*scale,key=[226,241,104],input=new Uint8ClampedArray(width*height*4);
    const paint=(x,y,w,h,rgb)=>{for(let yy=y*scale;yy<(y+h)*scale;yy++)for(let xx=x*scale;xx<(x+w)*scale;xx++)input.set([...rgb,255],(yy*width+xx)*4);};
    for(let p=0;p<width*height;p++)input.set([...key,255],p*4);
    paint(40,30,40,60,[16,16,16]);paint(43,33,34,54,[85,85,85]);
    paint(50,40,1,1,[235,235,235]); // A tiny enclosed armour highlight.
    paint(39,48,1,2,[240,247,214]); // Codec ringing attached to the outside of a dark contour.
    paint(20,50,1,1,[240,240,240]); // Detached bright residue.
    paint(88,32,8,8,[255,255,255]); // An intact effect core.
    paint(88,40,8,5,[241,248,180]); // Half-transparent glow against this key.
    paint(90,70,15,1,[255,255,255]); // A narrow sword trail, not a speck.
    const saved=input.slice(),options={removeBackground:true,background:'#e2f168',removalMode:'color',tolerance:55,feather:8,hardAlpha:false,protectInterior:true};
    const before=matteVideoFrame(input,width,height,{...options,despeckle:false}).data;
    const after=matteVideoFrame(input,width,height,options);
    const at=(x,y)=>(Math.floor((y+.5)*scale)*width+Math.floor((x+.5)*scale))*4;
    for(const [x,y]of [[39,48],[20,50]]) {
      assert.ok(before[at(x,y)+3]>0,'fixture reproduces the visible residue');
      assert.equal(after.data[at(x,y)+3],0,`external ringing at ${x},${y} is removed at scale ${scale}`);
    }
    for(const [x,y]of [[50,40],[91,35],[95,70]]) assert.deepEqual(after.data.slice(at(x,y),at(x,y)+4),before.slice(at(x,y),at(x,y)+4),'enclosed details and supported effects keep their RGBA');
    const glow=at(91,42);
    assert.ok(before[glow+3]>0&&before[glow+3]<255,'the effect contains a soft alpha transition');
    assert.deepEqual(after.data.slice(glow,glow+4),before.slice(glow,glow+4),'despeckling does not flatten the glow');
    assert.ok(after.removedSpecklePixels>0);
    assert.deepEqual(input,saved,'the video source remains unchanged');
  }
});

test('a tiny light break in a dark outline cannot open the entire opaque helmet',()=>{
  const width=128,height=96,key=[226,241,104],input=new Uint8ClampedArray(width*height*4);
  for(let p=0;p<width*height;p++)input.set([...key,255],p*4);
  for(let y=20;y<65;y++)for(let x=30;x<80;x++)input.set([...(x<33||x>=77||y<23||y>=62?[20,20,20]:[240,240,180]),255],(y*width+x)*4);
  for(let y=20;y<23;y++)input.set([140,140,140,255],(y*width+45)*4);
  for(let y=40;y<49;y++)for(let x=46;x<70;x++)input.set([245,210,100,255],(y*width+x)*4);
  const options={removeBackground:true,background:'#e2f168',removalMode:'color',tolerance:55,feather:8,hardAlpha:false,protectInterior:true};
  const saved=input.slice(),result=matteVideoFrame(input,width,height,options);
  for(let y=25;y<60;y++)for(let x=35;x<75;x++)assert.deepEqual(result.data.slice((y*width+x)*4,(y*width+x+1)*4),input.slice((y*width+x)*4,(y*width+x+1)*4),'the entire helmet interior stays opaque through a broken outline');
  assert.equal(result.data[3],0);
  assert.deepEqual(input,saved);
});

test('reference colours keep a newly enclosed key patch transparent without losing a key-similar beak',()=>{
  const reference=new Uint8ClampedArray(48*4);
  for(let p=0;p<48;p++)reference.set([[245,210,100],[240,240,240],[25,35,70]][Math.floor(p/16)],p*4);
  for(let p=0;p<48;p++)reference[p*4+3]=255;
  const support=foregroundColorSupport(reference,reference,8,6);
  for(const key of [[93,208,158],[226,241,104]]) for(const brokenOutline of [true,false]) {
    const width=128,height=96,input=new Uint8ClampedArray(width*height*4);
    for(let p=0;p<width*height;p++)input.set([...key,255],p*4);
    for(let y=20;y<65;y++)for(let x=30;x<80;x++)input.set([...(x<33||x>=77||y<23||y>=62?[20,20,20]:[240,240,240]),255],(y*width+x)*4);
    if(brokenOutline)for(let y=20;y<23;y++)input.set([140,140,140,255],(y*width+45)*4);
    for(let y=35;y<48;y++)for(let x=35;x<48;x++)input.set([...key,255],(y*width+x)*4);
    for(let y=45;y<54;y++)for(let x=50;x<70;x++)input.set([245,210,100,255],(y*width+x)*4);
    const options={removeBackground:true,background:`#${key.map(c=>c.toString(16).padStart(2,'0')).join('')}`,removalMode:'color',tolerance:55,feather:8,hardAlpha:false,protectInterior:true};
    assert.equal(matteVideoFrame(input,width,height,options).data[(40*width+40)*4+3],255,'gap closing alone reproduces protected backdrop');
    const result=matteVideoFrame(input,width,height,{...options,foregroundSupport:support});
    assert.equal(result.data[(40*width+40)*4+3],0,'unseen key-coloured patches remain transparent');
    assert.deepEqual(Array.from(result.data.slice((49*width+60)*4,(49*width+60)*4+4)),[245,210,100,255],'reference-supported beak survives a yellow key');
  }
});

test('observed effect colours preserve a faint trail as the key fades to white without reviving background noise',()=>{
  const width=128,height=96,foreground=[0,210,190];
  const reference=new Uint8ClampedArray(16*4);
  for(let p=0;p<16;p++)reference.set([90,110,100,255],p*4);
  const foregroundSupport=foregroundColorSupport(reference,reference,4,4);
  const frame=(key,alpha)=>{
    const input=new Uint8ClampedArray(width*height*4);
    for(let p=0;p<width*height;p++)input.set([...key,255],p*4);
    for(let y=30;y<60;y++)for(let x=65;x<95;x++)input.set([...foreground.map((v,c)=>Math.round(v*alpha+key[c]*(1-alpha))),255],(y*width+x)*4);
    input.set([248,246,249,255],(5*width+5)*4);
    return input;
  };
  const options={removeBackground:true,removalMode:'color',tolerance:55,feather:8,hardAlpha:false,protectInterior:true,foregroundSupport};
  const peak=matteVideoFrame(frame([255,0,255],1),width,height,{...options,background:'#ff00ff'});
  assert.ok(peak.foregroundAnchors.some(rgb=>rgb.every((v,c)=>v===foreground[c])),'collect a real cyan core from the video');
  const input=frame([250,247,250],.12),saved=input.slice();
  const faded=matteVideoFrame(input,width,height,{...options,background:'#faf7fa',foregroundAnchors:peak.foregroundAnchors});
  const effect=(45*width+80)*4;
  assert.ok(Math.abs(faded.data[effect+3]-31)<=3,'fading effect retains its fractional opacity');
  assert.deepEqual(Array.from(faded.data.slice(effect,effect+3)),foreground,'a white key does not turn cyan into white');
  assert.equal(faded.data[(5*width+5)*4+3],0,'codec noise stays transparent');
  assert.equal(faded.data[3],0,'unchanged background stays transparent');
  assert.deepEqual(input,saved);
});

test('palette evidence excludes compressed key fringes and removes the original key hue after the border fades',()=>{
  const width=64,height=64,reference=new Uint8ClampedArray(width*height*4),matte=reference.slice();
  for(let y=12;y<52;y++)for(let x=12;x<52;x++) {
    const rgb=x===12?[185,70,185]:[70,90,80];
    reference.set([...rgb,255],(y*width+x)*4);matte.set([...rgb,255],(y*width+x)*4);
  }
  const support=foregroundColorSupport(reference,matte,width,height,'#ff00ff');
  assert.equal(support[(185>>3)*1024+(70>>3)*32+(185>>3)],0,'the original fringe cannot become protected artwork');
  const neutral=Uint8ClampedArray.from([155,132,156,255]);
  const absent=foregroundColorSupport(neutral,neutral,1,1,'#ff00ff');
  assert.equal(absent[(175>>3)*1024+(114>>3)*32+(176>>3)],0,'expanded neutral support must not admit the absent key hue');
  const input=new Uint8ClampedArray(width*height*4);
  for(let p=0;p<width*height;p++)input.set([250,210,247,255],p*4);
  for(let y=12;y<52;y++)for(let x=12;x<52;x++)input.set([...(x===12?[185,70,185]:[70,90,80]),255],(y*width+x)*4);
  const options={removeBackground:true,background:'#fad2f7',removalMode:'edge',tolerance:55,feather:8,hardAlpha:false,protectInterior:true,foregroundSupport:support};
  const old=matteVideoFrame(input,width,height,options);
  assert.ok(old.data[(30*width+12)*4+3]>0,'the faded border alone misses the old key');
  const corrected=matteVideoFrame(input,width,height,{...options,referenceBackground:'#ff00ff'});
  assert.equal(corrected.data[(30*width+12)*4+3],0);
  assert.deepEqual([...corrected.data.slice((30*width+25)*4,(30*width+25)*4+4)],[70,90,80,255]);
});

test('a supported effect has continuous opacity through the initial key threshold',()=>{
  const width=128,height=96,foreground=[0,210,190],background=[250,247,250],input=new Uint8ClampedArray(width*height*4);
  const reference=Uint8ClampedArray.from([70,90,80,255]);
  const support=foregroundColorSupport(reference,reference,1,1);
  for(let p=0;p<width*height;p++)input.set([...background,255],p*4);
  for(let y=30;y<60;y++)for(let x=50;x<90;x++) {
    const alpha=.16+(x-50)*.005;
    input.set([...foreground.map((v,c)=>Math.round(v*alpha+background[c]*(1-alpha))),255],(y*width+x)*4);
  }
  const result=matteVideoFrame(input,width,height,{removeBackground:true,background:'#faf7fa',removalMode:'color',tolerance:55,feather:8,
    hardAlpha:false,protectInterior:true,foregroundSupport:support,foregroundAnchors:[foreground]});
  for(let x=52;x<88;x++)assert.ok(Math.abs(result.data[(45*width+x)*4+3]-Math.round((.16+(x-50)*.005)*255))<=3,
    'fitting a real effect must not multiply its coverage by a second tolerance feather');
});

test('local effect checking repairs a codec dropout without bridging real gaps or altering opaque artwork',()=>{
  const width=128,height=96,input=new Uint8ClampedArray(width*height*4),data=input.slice(),background=[250,247,250];
  for(let p=0;p<width*height;p++)input.set([...background,255],p*4);
  for(let y=30;y<50;y++)for(let x=60;x<90;x++) {
    input.set([190,238,236,255],(y*width+x)*4);data.set([0,210,190,61],(y*width+x)*4);
  }
  const hole=(40*width+75)*4;data.fill(0,hole,hole+4);
  for(let y=30;y<50;y++) { const i=(y*width+65)*4;input.set([...background,255],i);data.fill(0,i,i+4); }
  const opaque=(40*width+80)*4;data.set([70,90,80,255],opaque);input.set([70,90,80,255],opaque);
  const reference=Uint8ClampedArray.from([70,90,80,255]),support=foregroundColorSupport(reference,reference,1,1),saved=input.slice();
  assert.ok(smoothVideoEffects(input,data,width,height,background,support)>0);
  assert.deepEqual([...data.slice(hole,hole+4)],[0,210,190,61]);
  assert.equal(data[(40*width+65)*4+3],0,'a real background gap stays open');
  assert.deepEqual([...data.slice(opaque,opaque+4)],[70,90,80,255]);
  assert.deepEqual(input,saved);
});

test("matting uses source resolution and scales clean RGBA into the export package", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drawpaint-native-key-"));
  try {
    fs.mkdirSync(path.join(root, "frames"));
    const width = 512, height = 512, pixels = Buffer.alloc(width * height * 4);
    for (let p = 0; p < width * height; p++) pixels.set([80, 90, 100, 255], p * 4);
    for (let y = 63; y < 448; y++) for (let x = 63; x < 448; x++) pixels.set([230, 240, 250, 255], (y * width + x) * 4);
    await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toFile(path.join(root, "frames", "frame-000000.png"));
    const options = normalizeSequenceOptions({ fps: 6, maxSize: 256, backgroundRemoval: { removeBackground: true, background: "#505a64", tolerance: 8, feather: 0 } }, .1, { width, height });
    assert.equal(options.width, 256); assert.equal(options.extractWidth, 512);
    assert.match(buildClipSequenceArgs({ in: 0, out: .1 }, "video.mp4", "frames.png", options).join(" "), /scale=512:512/);
    const manifest = await packageSequence(root, options, { name: "干净边界", source: {}, sourceDuration: .1 }, path.join(root, "animation.zip"));
    const output = await sharp(path.join(root, manifest.frames[0].file)).ensureAlpha().raw().toBuffer();
    let fractional = 0;
    for (let p = 0; p < output.length; p += 4) if (output[p + 3] > 20 && output[p + 3] < 230) {
      fractional++;
      // Straight RGB is quantised more coarsely at low alpha. Its visible
      // contribution must still differ by less than one 8-bit channel step.
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(output[p + c] - [230, 240, 250][c]) * output[p + 3] / 255 <= 1, `RGBA resize must retain foreground colours at the edge: ${Array.from(output.subarray(p, p + 4))}`);
    }
    assert.ok(fractional > 0);
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("chosen frame range includes the complete tail frame and rejects reversed markers", () => {
  const clip = { in: 0, out: 2, fps: 24, startFrame: 0.5, endFrame: 0.75 };
  const range = videoFrameRange(clip);
  assert.equal(range.start, 0.5);
  assert.equal(range.end, 0.75 + 1 / 24);
  assert.equal(videoFrameRange({ ...clip, startFrame: 1 }).valid, false);
  assert.ok(Math.abs(videoFrameRange({ ...clip, endFrame: 0.5 }).end - range.start - 1 / 24) < 1e-9);
});

let ffmpegAvailable = true;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore", windowsHide: true }); } catch { ffmpegAvailable = false; }

test('generated clip preview, PNG and atlas preserve the lossless alpha master across restart', {skip:!ffmpegAvailable,timeout:30000}, async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'drawpaint-soft-generated-'));
  let server;
  try {
    const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',clipId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const canvasDir=path.join(root,'canvas'),directory=path.join(canvasDir,'video-generated');
    fs.mkdirSync(directory,{recursive:true});
    const width=64,height=64,frames=[];
    for(const key of [[255,0,255],[70,210,160]]) {
      const frame=Buffer.alloc(width*height*4);
      for(let p=0;p<width*height;p++) frame.set([...key,255],p*4);
      for(let y=20;y<44;y++) for(let x=20;x<44;x++) frame.set([255,255,255,255],(y*width+x)*4);
      for(let y=22;y<42;y++) for(let x=44;x<49;x++) frame.set([...key.map(c=>Math.round(c*.5+255*.5)),255],(y*width+x)*4);
      frames.push(frame);
    }
    const original=path.join(directory,`${id}.mp4`);
    execFileSync('ffmpeg',['-y','-v','error','-f','rawvideo','-pixel_format','rgba','-video_size','64x64','-framerate','2','-i','pipe:0','-c:v','libx264rgb','-crf','0',original],{input:Buffer.concat(frames),windowsHide:true});
    const jobOptions={[id]:{lockBackground:true,frameAnimation:{enabled:true,background:'#ff00ff'}}};
    const config={canvasDir,jobOptions,comfyJson:async()=>{throw new Error('offline');},videoOutput:()=>null};
    await createGeneratedVideoStore(config).resolve(id);
    const generatedStore=createGeneratedVideoStore({...config,normalizeBackground:async()=>{throw new Error('must reuse master');}});
    fs.writeFileSync(path.join(canvasDir,'video-project.json'),JSON.stringify({clips:[{id:clipId,source:{type:'job',id},name:'柔光',in:0,out:1,position:0,track:0,status:'completed'}]}));
    const handler=createVideoEditor({canvasDir,jobIds:new Set([id]),generatedStore,jobOptions});
    server=createServer(async(req,res)=>{if(!await handler(req,res,new URL(req.url,'http://localhost'))){res.writeHead(404);res.end();}});
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const base=`http://127.0.0.1:${server.address().port}`;
    const response=await fetch(`${base}/api/video/frame?type=job&id=${id}&time=0&maxSize=2048&transparent=1`);
    assert.equal(response.status,200);
    const preview=await sharp(Buffer.from(await response.arrayBuffer())).ensureAlpha().raw().toBuffer();
    const edge=(30*width+46)*4;
    assert.equal(preview[3],0);
    assert.ok(Math.abs(preview[edge+3]-128)<=2,'preview reads fractional alpha, not compressed MP4');
    for(const hardAlpha of [false,true]) {
      const created=await fetch(base+'/api/video/exports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({format:'sequence',clipId,fps:2,maxSize:64,resampling:'nearest',backgroundRemoval:{removeBackground:true,background:'#ff0000',hardAlpha}})});
      assert.equal(created.status,200,await created.clone().text());
      let record=await created.json();const deadline=Date.now()+15000;
      while(record.status==='running'&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,50));record=await(await fetch(`${base}/api/video/exports/${record.id}`)).json();}
      assert.equal(record.status,'completed',record.error);
      const files=unzipSync(new Uint8Array(await(await fetch(base+record.url)).arrayBuffer()));
      const manifest=JSON.parse(strFromU8(files['animation.json']));
      const atlas=await sharp(Buffer.from(files[manifest.sheets[0].file])).ensureAlpha().raw().toBuffer({resolveWithObject:true});
      for(const rect of manifest.frames) {
        const rgba=await sharp(Buffer.from(files[rect.file])).ensureAlpha().raw().toBuffer();
        assert.ok(hardAlpha ? rgba[edge+3]===0||rgba[edge+3]===255 : Math.abs(rgba[edge+3]-128)<=3,'only explicit hard alpha may flatten the glow');
        assert.equal(rgba[3],0);assert.equal(rgba[(30*width+30)*4+3],255);
        for(let y=0;y<height;y++) assert.deepEqual(atlas.data.subarray(((rect.y+y)*atlas.info.width+rect.x)*4,((rect.y+y)*atlas.info.width+rect.x+width)*4),rgba.subarray(y*width*4,(y+1)*width*4),'atlas retains exact RGBA frame pixels');
      }
    }
  } finally {
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));
    fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});

test("real sequence export respects trim, packs lossless frames and atlases, and survives restart", { skip: !ffmpegAvailable && "FFmpeg is not installed", timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drawpaint-sequence-"));
  let server;
  try {
    const source = path.join(root, "source.mp4"), canvasDir = path.join(root, "canvas");
    fs.mkdirSync(canvasDir);
    execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=64x48:r=24:d=1", "-f", "lavfi", "-i", "color=c=blue:s=64x48:r=24:d=1", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", source], { windowsHide: true });
    const clipId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const clip = { id: clipId, source: { type: "job", id: sourceId }, name: "动画", in: 0.75, out: 1.25, position: 0.5, track: 0, status: "completed" };
    fs.writeFileSync(path.join(canvasDir, "video-project.json"), JSON.stringify({ clips: [clip], width: 640, height: 640 }));
    const config = { canvasDir, jobIds: new Set([sourceId]), generatedStore: { resolve: async () => ({ file: source }) } };
    let handler = createVideoEditor(config);
    server = createServer(async (req, res) => { if (!await handler(req, res, new URL(req.url, "http://localhost"))) { res.writeHead(404); res.end(); } });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const frameResponse = await fetch(`${base}/api/video/frame?type=job&id=${sourceId}&time=0&maxSize=2048`);
    assert.equal(frameResponse.status, 200);
    const frameInfo = await sharp(Buffer.from(await frameResponse.arrayBuffer())).metadata();
    assert.deepEqual([frameInfo.width, frameInfo.height], [64, 48], "native frame preview must not upscale the source");
    assert.equal((await fetch(`${base}/api/video/frame?type=job&id=${sourceId}&time=0&maxSize=9999`)).status, 400);
    const exportSequence = async body => {
      const response = await fetch(`${base}/api/video/exports`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ format: "sequence", ...body }) });
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
      let job = await response.json();
      const deadline = Date.now() + 15000;
      while (job.status === "running" && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
        job = await (await fetch(`${base}/api/video/exports/${job.id}`)).json();
      }
      assert.equal(job.status, "completed", job.error);
      const download = await fetch(base + job.url);
      assert.equal(download.headers.get("content-type"), "application/zip");
      const files = unzipSync(new Uint8Array(await download.arrayBuffer()));
      return { job, files, manifest: JSON.parse(strFromU8(files["animation.json"])) };
    };
    const png = await exportSequence({ clipId, fps: 8 });
    assert.equal(png.manifest.frameCount, 4);
    assert.equal(png.manifest.duration, 0.5);
    assert.equal(png.manifest.source.clips[0].in, 0.75);
    assert.deepEqual([png.manifest.width, png.manifest.height], [64, 48]);
    assert.equal(png.manifest.loop, true);
    assert.equal(Object.keys(png.files).filter(file => file.startsWith("frames/")).length, 4);
    const pixel = async bytes => {
      const image = sharp(Buffer.from(bytes)), metadata = await image.metadata();
      return Array.from(await image.extract({ left: Math.floor(metadata.width / 2), top: Math.floor(metadata.height / 2), width: 1, height: 1 }).removeAlpha().raw().toBuffer());
    };
    const first = await pixel(png.files[png.manifest.frames[0].file]), last = await pixel(png.files[png.manifest.frames.at(-1).file]);
    assert.ok(first[0] > 200 && first[2] < 30, `first frame should precede source transition: ${first}`);
    assert.ok(last[2] > 200 && last[0] < 30, `last frame should follow source transition: ${last}`);
    const sheet = png.manifest.sheets[0];
    const atlasInfo = await sharp(Buffer.from(png.files[sheet.file])).metadata();
    assert.deepEqual([atlasInfo.width, atlasInfo.height], [sheet.width, sheet.height]);
    const rect = png.manifest.frames.at(-1);
    const atlasFrame = await sharp(Buffer.from(png.files[sheet.file])).extract({ left: rect.x, top: rect.y, width: rect.w, height: rect.h }).png().toBuffer();
    assert.deepEqual(await pixel(atlasFrame), last);
    const originalProject = fs.readFileSync(path.join(canvasDir, "video-project.json"), "utf8");
    const namedCanvas = await (await fetch(`${base}/api/video/canvases`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "蓝色画布" }) })).json();
    const namedSave = await fetch(`${base}/api/video/project?canvasId=${namedCanvas.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clips: [{ ...clip, in: 1.25, out: 1.75 }], baseRevision: namedCanvas.revision }) });
    assert.equal(namedSave.status, 200);
    const scoped = await exportSequence({ canvasId: namedCanvas.id, clipId, fps: 6 });
    assert.equal(scoped.job.canvasId, namedCanvas.id);
    assert.equal(scoped.manifest.source.canvasName, "蓝色画布");
    assert.equal(scoped.manifest.source.canvasId, namedCanvas.id);
    assert.ok((await pixel(scoped.files[scoped.manifest.frames[0].file]))[2] > 200, "export must use the blue range saved in the chosen canvas");
    assert.equal(fs.readFileSync(path.join(canvasDir, "video-project.json"), "utf8"), originalProject);
    assert.ok(png.files["preview.html"] && png.files["README.txt"]);
    const preview = await fetch(base + png.job.previewUrl);
    assert.match(await preview.text(), /animation\.sheets/);
    assert.equal((await fetch(`${base}/api/video/exports/${png.job.id}/${sheet.file}`)).status, 200);
    handler = createVideoEditor(config);
    assert.equal((await (await fetch(`${base}/api/video/exports/${png.job.id}`)).json()).status, "completed");
    assert.equal((await fetch(base + png.job.url, { method: "HEAD" })).headers.get("content-type"), "application/zip");
    const lower = { ...clip, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", in: 1, out: 1.5, track: 1 };
    fs.writeFileSync(path.join(canvasDir, "video-project.json"), JSON.stringify({ clips: [clip, lower], width: 640, height: 640 }));
    const timeline = await exportSequence({ fps: 6, maxSize: 256, imageFormat: "webp", loop: false });
    assert.equal(timeline.manifest.frameCount, 6);
    assert.equal(timeline.manifest.loop, false);
    assert.deepEqual([timeline.manifest.width, timeline.manifest.height], [256, 256]);
    assert.equal(timeline.manifest.source.scope, "timeline");
    assert.equal((await sharp(Buffer.from(timeline.files[timeline.manifest.frames[0].file])).metadata()).format, "webp");
    const gap = await pixel(timeline.files[timeline.manifest.frames[0].file]);
    assert.ok(Math.max(...gap) < 60, `timeline gap should retain the background: ${gap}`);
    const upper = await pixel(timeline.files[timeline.manifest.frames[3].file]);
    assert.ok(upper[0] > 200 && upper[2] < 30, `upper track should cover the lower blue clip: ${upper}`);
    fs.writeFileSync(path.join(canvasDir, "video-project.json"), JSON.stringify({ clips: [{ ...clip, out: 0.78 }], width: 640, height: 640 }));
    const short = await exportSequence({ clipId, fps: 6 });
    assert.equal(short.manifest.frameCount, 1);
    fs.writeFileSync(path.join(canvasDir, "video-project.json"), JSON.stringify({ clips: [{ ...clip, startFrame: 1, endFrame: 1.125 }], width: 640, height: 640 }));
    const selectedRange = await exportSequence({ clipId, fps: 24, useFrameRange: true });
    assert.equal(selectedRange.manifest.frameCount, 4);
    assert.equal(selectedRange.manifest.source.clips[0].in, 1);
    assert.equal(selectedRange.manifest.source.clips[0].out, 1.125 + 1 / 24);
    const keyed = await exportSequence({ clipId, fps: 8, backgroundRemoval: { removeBackground: true, background: "#fe0000", removalMode: "color" } });
    const transparent = await sharp(Buffer.from(keyed.files[keyed.manifest.frames[0].file])).ensureAlpha().raw().toBuffer();
    assert.equal(transparent[3], 0);
    assert.ok((await pixel(keyed.files[keyed.manifest.frames.at(-1).file]))[2] > 200);
    assert.ok(keyed.manifest.transparentFrames > 0);
    assert.equal(keyed.job.backgroundRemoval.resolvedBackground, "#fe0000");
    const invalid = await fetch(`${base}/api/video/exports`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ format: "sequence", fps: 0 }) });
    assert.equal(invalid.status, 400);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("transparent PNG and WebP frames retain alignment, alpha and matching atlas pixels", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drawpaint-key-frames-"));
  try {
    for (const format of ["png", "webp"]) {
      const directory = path.join(root, format);
      fs.mkdirSync(path.join(directory, "frames"), { recursive: true });
      for (let index = 0; index < 3; index++) {
        const raw = Buffer.alloc(32 * 24 * 4);
        for (let p = 0; p < raw.length; p += 4) raw.set([0, 0, 0, 0], p);
        for (let y = 6; y < 18; y++) for (let x = 8 + index; x < 20 + index; x++) raw.set([230, 30, 20, 255], (y * 32 + x) * 4);
        for (let y = 4; y < 6; y++) for (let x = 8; x < 20; x++) raw.set([69, 209, 180, 37], (y * 32 + x) * 4);
        await sharp(raw, { raw: { width: 32, height: 24, channels: 4 } }).png().toFile(path.join(directory, "frames", `frame-${String(index).padStart(6, "0")}.png`));
      }
      const options = normalizeSequenceOptions({ fps: 6, imageFormat: format, backgroundRemoval: { removeBackground: true, background: '#ff00ff', feather: 0 } }, 0.5, { width: 32, height: 24 });
      const output = path.join(directory, "animation.zip");
      const manifest = await packageSequence(directory, options, { name: "透明动画", source: {}, sourceDuration: 0.5 }, output);
      assert.equal(manifest.backgroundRemoval.resolvedBackground, "#ff00ff");
      assert.equal(manifest.transparentFrames, 3);
      assert.equal(manifest.alphaMode, "straight");
      const files = unzipSync(fs.readFileSync(output));
      for (let index = 0; index < 3; index++) {
        const frame = manifest.frames[index];
        const decoded = await sharp(Buffer.from(files[frame.file])).ensureAlpha().raw().toBuffer();
        assert.equal(decoded[3], 0, "background must have real zero alpha");
        assert.deepEqual(Array.from(decoded.subarray((8 * 32 + 10 + index) * 4, (8 * 32 + 10 + index) * 4 + 4)), [230, 30, 20, 255]);
        assert.deepEqual(Array.from(decoded.subarray((4 * 32 + 10) * 4, (4 * 32 + 10) * 4 + 4)), [69, 209, 180, 37], 'faint coloured RGB and alpha stay exact');
        const sheet = await sharp(Buffer.from(files[manifest.sheets[frame.sheet].file])).extract({ left: frame.x, top: frame.y, width: frame.w, height: frame.h }).ensureAlpha().raw().toBuffer();
        assert.deepEqual(sheet, decoded);
      }
      const preview = strFromU8(files["preview.html"]);
      assert.match(preview, /透明棋盘/);
      assert.match(preview, /ctx.clearRect/);
      assert.match(strFromU8(files["README.txt"]), /真实 RGBA/);
    }
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("large sequence atlases paginate without losing frame rectangles", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drawpaint-atlas-"));
  try {
    fs.mkdirSync(path.join(root, "frames"));
    const frame = await sharp({ create: { width: 256, height: 2048, channels: 4, background: "red" } }).png().toBuffer();
    for (let index = 0; index < 33; index++) fs.writeFileSync(path.join(root, "frames", `frame-${String(index).padStart(6, "0")}.png`), frame);
    const options = normalizeSequenceOptions({ fps: 6, maxSize: 2048 }, 5.5, { width: 256, height: 2048 });
    const manifest = await packageSequence(root, options, { name: "分页测试", source: {}, sourceDuration: 5.5 }, path.join(root, "animation.zip"));
    assert.equal(manifest.sheets.length, 2);
    assert.equal(manifest.sheets[0].frameCount, 32);
    assert.equal(manifest.frames[32].sheet, 1);
    assert.deepEqual([manifest.frames[32].x, manifest.frames[32].y], [0, 0]);
    for (const sheet of manifest.sheets) assert.ok(sheet.width <= 4096 && sheet.height <= 4096);
    const files = unzipSync(fs.readFileSync(path.join(root, "animation.zip")));
    assert.equal(Object.keys(files).filter(file => file.startsWith("frames/")).length, 33);
    const last = await sharp(Buffer.from(files[manifest.sheets[1].file])).metadata();
    assert.deepEqual([last.width, last.height], [256, 2048]);
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
