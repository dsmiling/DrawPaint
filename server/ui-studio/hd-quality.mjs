import sharp from "sharp";
import { minimumHdSide } from "../../shared/split-options.mjs";

// A resolution floor catches tiny reused sprites and undersized sheet cells.
// It is not a perceptual sharpness score: the Agent must inspect native pixels.
export async function validateHdImage(job, layer, image) {
  if (job.splitOptions?.resolutionMode !== "hd") return;
  const {data,info} = await sharp(image).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let x0=info.width,y0=info.height,x1=-1,y1=-1;
  for(let p=0;p<info.width*info.height;p++) {
    if(data[p*4+3]<8) continue;
    const x=p%info.width,y=Math.floor(p/info.width);
    x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);
  }
  if(Math.max(x1-x0+1,y1-y0+1)<minimumHdSide) {
    if(job.reviewBeforePublish) { (layer.warnings ||= []).push(`有效内容长边不足 ${minimumHdSide} 像素，建议重做高清；候选保留供检查。`); return; }
    throw new Error(`图层“${layer.name}”有效内容分辨率不足：高清输出要求长边至少 ${minimumHdSide} 像素。请重新高清生成或减小合图批量，不能复用低清素材或插值放大。`);
  }
}
