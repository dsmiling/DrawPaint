export const componentLabels = { component: "组件", button: "按钮", text: "文字", icon: "图标", texture: "贴图", background: "背景", border: "边框", decoration: "装饰" };
export const componentTypes = Object.keys(componentLabels);
export function componentMetadata(value = {}) {
  const layerType = value.layerType || "component";
  if (!componentTypes.includes(layerType)) throw new Error("不支持的组件类型");
  const result = { layerType, semanticSource: value.semanticSource === "ai" ? "ai" : value.semanticSource === "manual" ? "manual" : "unclassified" };
  if (value.name !== undefined) result.name = String(value.name).trim().slice(0, 120) || "未命名组件";
  if (layerType === "text") {
    result.text = String(value.text || "").slice(0, 4000);
    result.fontFamily = String(value.fontFamily || "").slice(0, 120);
    result.fontSize = Number.isFinite(Number(value.fontSize)) && Number(value.fontSize) > 0 ? Math.min(512, Number(value.fontSize)) : 24;
    result.textColor = /^#[a-f0-9]{6}$/i.test(value.textColor || "") ? value.textColor : "#ffffff";
    result.textAlign = ["left", "center", "right"].includes(value.textAlign) ? value.textAlign : "center";
    result.textRender = value.textRender === "editable" ? "editable" : "image";
  }
  return result;
}
