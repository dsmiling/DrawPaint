"""Local OCR / prompted segmentation / surface repair. No image generation or downloads.

All geometry is expressed in immutable source pixels. SAM encodes once per job.
White masks include pixels; black masks exclude them. PNG masks never use alpha.
"""
import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import sys

os.environ.setdefault("OMP_NUM_THREADS", "4")


def emit(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)


def load_image(filename):
    import numpy as np
    from PIL import Image
    with Image.open(filename) as im:
        if im.width * im.height > 16777216:
            raise ValueError("Image exceeds 16 million pixels")
        return np.array(im.convert("RGBA"))


def save_mask(filename, mask):
    from PIL import Image
    Image.fromarray(mask.astype("uint8")).save(filename)


def glyph_mask(rgb, polygon):
    import cv2
    import numpy as np
    allowed = np.zeros(rgb.shape[:2], np.uint8)
    cv2.fillPoly(allowed, [np.array(polygon, np.int32)], 255)
    band = allowed - cv2.erode(allowed, np.ones((3, 3), np.uint8))
    samples = rgb[band > 0]
    bg = np.median(samples if len(samples) else rgb.reshape(-1, 3), axis=0)
    distance = np.linalg.norm(rgb.astype(float) - bg, axis=2)
    values = np.clip(distance * 3, 0, 255).astype(np.uint8)
    threshold, _ = cv2.threshold(values[allowed > 0], 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    mask = ((values >= max(12, threshold * .65)) & (allowed > 0)).astype(np.uint8) * 255
    coverage = np.count_nonzero(mask) / max(1, np.count_nonzero(allowed))
    reliable = .015 <= coverage <= .68
    return (mask if reliable else allowed), reliable, bg


def ocr(args):
    import cv2
    import numpy as np
    from PIL import Image
    from rapidocr_onnxruntime import RapidOCR
    rgba = load_image(args.source)
    rgb = rgba[:, :, :3]
    # OCR takes BGR arrays. Do not interpret OCR boxes as exact glyph masks.
    engine = RapidOCR(det_use_cuda=False, cls_use_cuda=False, rec_use_cuda=False, text_score=.35,
                      intra_op_num_threads=4, inter_op_num_threads=2)
    results, _ = engine(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
    rows, union = [], np.zeros(rgb.shape[:2], np.uint8)
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    for polygon, text, confidence in results or []:
        confidence = float(confidence)
        if confidence < .35 or len(text) == 1 and text.isascii() and text.isalpha() and confidence < .85:
            continue
        points = np.array(polygon)
        x, y = np.maximum(0, np.floor(points.min(axis=0))).astype(int)
        right, bottom = np.minimum([rgb.shape[1], rgb.shape[0]], np.ceil(points.max(axis=0))).astype(int)
        w, h = int(right - x), int(bottom - y)
        if w < 1 or h < 1 or confidence < .85 and h / w >= 2.4:
            continue
        mask, reliable, bg = glyph_mask(rgb[y:bottom, x:right], points - [x, y])
        radius = max(1, min(4, round(h * .06)))
        repair = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1,) * 2))
        union[y:bottom, x:right] |= repair
        region_id = f"ocr-{len(rows) + 1}"
        save_mask(out / f"{region_id}.png", mask)
        foreground = rgb[y:bottom, x:right][mask > 0]
        color = np.median(foreground, axis=0).astype(int) if len(foreground) else [255] * 3
        rows.append(dict(id=region_id, text=text, confidence=confidence, x=int(x), y=int(y), w=w, h=h,
                         polygon=np.rint(points).astype(int).tolist(), maskFile=f"{region_id}.png",
                         maskReliable=reliable, fontSize=max(8, round(h * .82)),
                         textColor="#" + "".join(f"{c:02x}" for c in color), fontFamily=""))
    clean = cv2.inpaint(rgb, union, 5, cv2.INPAINT_TELEA) if union.any() else rgb.copy()
    Image.fromarray(np.dstack([clean, rgba[:, :, 3]])).save(out / "cleaned.png")
    result = dict(regions=rows, cleanedFile="cleaned.png")
    (out / "ocr.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    emit(result)


def select_mask(masks, scores, region):
    import numpy as np
    x, y, w, h = (region[k] for k in ("x", "y", "w", "h"))
    positives, negatives = region.get("positivePoints", []), region.get("negativePoints", [])
    ranking = []
    for mask, score in zip(masks, scores):
        yy, xx = np.where(mask)
        if not len(xx):
            ranking.append(-100)
            continue
        inside = np.count_nonzero(mask[y:y+h, x:x+w]) / len(xx)
        mx, my, mr, mb = xx.min(), yy.min(), xx.max() + 1, yy.max() + 1
        intersection = max(0, min(x+w, mr) - max(x, mx)) * max(0, min(y+h, mb) - max(y, my))
        iou = intersection / max(1, w*h + (mr-mx)*(mb-my) - intersection)
        pos = sum(bool(mask[py, px]) for px, py in positives) / max(1, len(positives))
        neg = sum(bool(mask[py, px]) for px, py in negatives) / max(1, len(negatives))
        ranking.append(float(score) + .22*pos - .38*neg + .10*inside + .06*iou)
    chosen = int(np.argmax(ranking))
    return masks[chosen], float(scores[chosen]), [round(v, 4) for v in ranking]


def segment(args):
    import cv2
    import numpy as np
    import torch
    from segment_anything import SamPredictor, sam_model_registry
    rgba = load_image(args.source)
    regions = json.loads(Path(args.plan).read_text(encoding="utf-8"))["regions"]
    rgb = rgba[:, :, :3].copy()
    # Invisible RGB can contain key colours. Keep it out of the encoder input.
    rgb[rgba[:, :, 3] == 0] = 0
    device = "cuda" if args.device == "auto" and torch.cuda.is_available() else args.device
    if device == "auto":
        device = "cpu"
    torch.set_num_threads(4)
    model = sam_model_registry["vit_b"](checkpoint=args.checkpoint).to(device=device)
    predictor = SamPredictor(model)
    predictor.set_image(rgb)
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    results = []
    for region in regions:
        x, y, w, h = (region[k] for k in ("x", "y", "w", "h"))
        warnings, score, ranking = [], None, []
        if region.get("maskMode") == "rectangle":
            # Only explicitly declared full background surfaces can take this branch.
            mask = np.full((h, w), 255, np.uint8)
        elif region["layerType"] == "text":
            mask, reliable, _ = glyph_mask(rgb[y:y+h, x:x+w], [[0, 0], [w-1, 0], [w-1, h-1], [0, h-1]])
            if not reliable:
                warnings.append("文字与底色难以分离，请校正字形掩膜；未自动改换字体")
        else:
            positives, negatives = region.get("positivePoints", []), region.get("negativePoints", [])
            points = positives + negatives
            masks, scores, _ = predictor.predict(
                point_coords=np.array(points, np.float32) if points else None,
                point_labels=np.array([1]*len(positives) + [0]*len(negatives)) if points else None,
                box=np.array([x, y, x+w, y+h]), multimask_output=True)
            selected, score, ranking = select_mask(masks, scores, region)
            mask = selected[y:y+h, x:x+w].astype(np.uint8) * 255
            if score < .8:
                warnings.append("分割置信度偏低，请检查轮廓")
        cleanup = region.get("cleanupArea", 0)
        if cleanup:
            count, labels, stats, _ = cv2.connectedComponentsWithStats((mask > 0).astype(np.uint8), 8)
            protected = {int(labels[py-y, px-x]) for px, py in region.get("positivePoints", []) if x <= px < x+w and y <= py < y+h}
            for label in range(1, count):
                if stats[label, cv2.CC_STAT_AREA] < cleanup and label not in protected:
                    mask[labels == label] = 0
        # No default closing/dilation: needles, holes and fine ornaments survive.
        feather = region.get("edgeFeather", 0)
        if feather:
            distance = cv2.distanceTransform((mask > 0).astype(np.uint8), cv2.DIST_L2, 3)
            mask = np.rint(mask * np.minimum(1, distance / (feather + 1))).astype(np.uint8)
        if not np.any(mask):
            warnings.append("未找到前景；请调整提示点或用画笔保留目标")
        filename = f"{region['id']}.png"
        save_mask(out / filename, mask)
        results.append(dict(regionId=region["id"], maskFile=filename, score=score,
                            candidateScores=ranking, warnings=warnings))
    result = dict(device=device, model="sam-vit-b", masks=results)
    (out / "segments.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    emit(result)


def repair(args):
    import cv2
    import numpy as np
    from PIL import Image
    rgba = load_image(args.source)
    with Image.open(args.mask) as im:
        mask = np.array(im.convert("L"))
    if mask.shape != rgba.shape[:2] or not np.any(mask == 0):
        raise ValueError("Surface repair requires same-size mask and visible neighbouring pixels")
    repaired = cv2.inpaint(rgba[:, :, :3], mask, 5, cv2.INPAINT_TELEA)
    rgba[:, :, :3][mask > 0] = repaired[mask > 0]
    Image.fromarray(rgba).save(args.output)
    emit(dict(file=args.output))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["health", "ocr", "segment", "repair"])
    for key in ["source", "output", "checkpoint", "plan", "mask"]:
        parser.add_argument("--" + key)
    parser.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    args = parser.parse_args()
    if args.command == "health":
        import cv2
        import torch
        import segment_anything
        import rapidocr_onnxruntime
        emit(dict(ready=bool(args.checkpoint and Path(args.checkpoint).is_file()),
                  cuda=torch.cuda.is_available(), torch=torch.__version__,
                  ocr=importlib.metadata.version("rapidocr-onnxruntime")))
    else:
        globals()[args.command](args)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
