import { LOCAL_PROMPT_DEFAULT } from "../shared/video-prompt-options.js";

export async function releaseVideoPromptModel(modelId = LOCAL_PROMPT_DEFAULT) {
  if (!modelId) return;
  try {
    await fetch("/ollama/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId, keep_alive: 0 }),
    });
  } catch { /* Video generation can still start if Ollama is already idle. */ }
}
