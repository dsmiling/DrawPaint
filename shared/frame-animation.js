export const FRAME_ANIMATION_GUIDE = "背景为均匀纯品红色 #FF00FF；如果主体含品红，改用纯绿色 #00FF00。主体内不使用所选底色。不要渐变、纹理、棋盘格、地面、投影或背景色反光。主体完整置于画面内，四周至少留 4% 纯底色空隙。生成视频时全程保持相同底色、均匀亮度和固定画幅，不让角色出框。";

export function normalizeFrameAnimation(value) {
  if (value == null) return { enabled: false, background: "auto" };
  if (typeof value !== "object" || Array.isArray(value) || typeof value.enabled !== "boolean") throw new Error("帧动画用途设置无效");
  const background = value.background ?? "auto";
  if (!["auto", "#ff00ff", "#00ff00"].includes(background)) throw new Error("帧动画底色须为自动、品红或绿色");
  return { enabled: value.enabled, background };
}

export function frameAnimationPrompt(prompt, background) {
  if (!["#ff00ff", "#00ff00"].includes(background)) throw new Error("帧动画底色尚未确定");
  const color = background === "#ff00ff" ? "纯品红 #FF00FF" : "纯绿色 #00FF00";
  return `${prompt.trim()}\n\n【帧动画生成约束，背景要求以此为准】\n首尾参考图已统一为${color}背景。全程保持这一均匀纯色底及亮度；不要恢复动作描述中的其他背景，不要渐变、纹理、棋盘格、地面、投影或底色反光。保留角色原有颜色、描边、细节与身份；角色内不使用该底色。固定镜头、固定画幅、无缩放或转场，主体完整保持在画面内，四周至少留 4% 纯底色空隙，运动不出框。仅执行上述动作，便于逐帧剔除背景。`;
}
