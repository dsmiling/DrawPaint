export const VIDEO_PROMPT_PROVIDERS = [
  { id: "gpt", name: "GPT" }, { id: "cursor", name: "Cursor" }, { id: "local", name: "本地模型" },
];
export const CURSOR_PROMPT_DEFAULT = "grok-4.7";
export const LOCAL_PROMPT_DEFAULT = "qwen3.8:27b";

export function chooseVideoPromptModel(models, saved, preferred) {
  return models.find(item => item.id === saved)?.id || models.find(item => item.id === preferred)?.id || models[0]?.id || "";
}
