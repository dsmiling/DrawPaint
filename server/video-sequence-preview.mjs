export function sequencePreviewHtml(manifest) {
  const encoded = JSON.stringify(manifest).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DrawPaint 序列帧预览</title>
<style>
body{margin:0;padding:14px;background:#202124;color:#eee;font:13px/1.5 sans-serif;text-align:center}
h1{font-size:16px;margin:0 0 6px}canvas{display:block;max-width:100%;max-height:200px;margin:8px auto;image-rendering:pixelated;cursor:pointer;border-radius:6px}
canvas.checker{background-color:#ddd;background-image:conic-gradient(#aaa 25%,transparent 0 50%,#aaa 0 75%,transparent 0);background-size:20px 20px}
canvas.light{background:#fff}canvas.dark{background:#111827}
button,select{padding:5px 10px;border:1px solid #666;border-radius:5px;background:#30343a;color:#fff;font:inherit}
input{width:min(250px,60%);vertical-align:middle}p{margin:7px 0}#error{color:#f99}#error:empty{display:none}
</style>
<h1>序列帧动画</h1><canvas class="checker" tabindex="0" role="button" aria-label="暂停动画"></canvas>
<button id="play">暂停</button> <label>背景 <select id="background"><option value="checker">透明棋盘</option><option value="light">白色</option><option value="dark">深色</option></select></label>
<p><label>当前帧 <input id="frame" aria-label="当前帧" type="range" min="0" value="0"></label></p><p id="info"></p><p id="error" role="alert"></p>
<script>
const animation=${encoded};
const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d'),slider=document.querySelector('#frame'),button=document.querySelector('#play');
canvas.width=animation.width;canvas.height=animation.height;slider.max=animation.frameCount-1;
let index=0,playing=true,loaded=false,previous=performance.now();
const images=animation.sheets.map(sheet=>{const image=new Image();image.src=sheet.file;return image});
function draw(){const frame=animation.frames[index],image=images[frame.sheet];if(image.complete&&image.naturalWidth){ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,frame.x,frame.y,frame.w,frame.h,0,0,canvas.width,canvas.height)}slider.value=index;document.querySelector('#info').textContent=(index+1)+' / '+animation.frameCount+' 帧 · '+animation.fps+' fps · '+(animation.backgroundRemoval?.removeBackground?'已剔除背景':'原始背景')}
function toggle(){if(!playing&&index===animation.frameCount-1)index=0;playing=!playing;previous=performance.now();button.textContent=playing?'暂停':'播放';canvas.setAttribute('aria-label',playing?'暂停动画':'播放动画');draw()}
button.onclick=toggle;canvas.onclick=toggle;canvas.onkeydown=event=>{if(event.key===' '||event.key==='Enter'){event.preventDefault();toggle()}};
slider.oninput=()=>{const chosen=Number(slider.value);if(playing)toggle();index=chosen;draw()};
document.querySelector('#background').onchange=event=>{canvas.className=event.target.value};
let remaining=images.length;
images.forEach(image=>{const ready=()=>{remaining--;loaded=remaining===0;previous=performance.now();draw()};if(image.complete&&image.naturalWidth)ready();else image.onload=ready;image.onerror=()=>{document.querySelector('#error').textContent='图集加载失败，请完整解压 ZIP 后再打开预览。'}});
function tick(now){const step=1000/animation.fps;if(loaded&&playing&&now-previous>=step){const advance=Math.floor((now-previous)/step);previous+=advance*step;if(animation.loop)index=(index+advance)%animation.frameCount;else{index=Math.min(animation.frameCount-1,index+advance);if(index===animation.frameCount-1){playing=false;button.textContent='播放';canvas.setAttribute('aria-label','播放动画')}}draw()}requestAnimationFrame(tick)}
draw();requestAnimationFrame(tick);
</script></html>`;
}
