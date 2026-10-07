import { useEffect, useState } from "react";
import { CURSOR_PROMPT_DEFAULT, LOCAL_PROMPT_DEFAULT, VIDEO_PROMPT_PROVIDERS, chooseVideoPromptModel } from "../shared/video-prompt-options.js";

const prefix = "drawpaint.video-studio.prompt-";
function read(key, fallback) { try { return localStorage.getItem(prefix + key) || fallback; } catch { return fallback; } }

export default function useVideoPromptModels() {
  const [provider, setProvider] = useState(() => {
    const saved = read("provider", "gpt");
    return VIDEO_PROMPT_PROVIDERS.some(item => item.id === saved) ? saved : "gpt";
  });
  const [selection, setSelection] = useState(() => ({ cursor: read("cursor-model", CURSOR_PROMPT_DEFAULT), local: read("local-model", LOCAL_PROMPT_DEFAULT) }));
  const [catalog, setCatalog] = useState({ provider: "", loading: true, ready: false, models: [], error: "" });
  useEffect(() => { try { localStorage.setItem(prefix + "provider", provider); } catch { /* The selection still works. */ } }, [provider]);
  useEffect(() => {
    try { for (const [id, model] of Object.entries(selection)) localStorage.setItem(prefix + id + "-model", model); } catch { /* Keep in-memory choices. */ }
  }, [selection]);
  useEffect(() => {
    const controller = new AbortController();
    setCatalog({ provider, loading: true, ready: false, models: [], error: "" });
    fetch(`/api/video/prompt-models?provider=${provider}`, { signal: controller.signal }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "模型列表读取失败");
      if (controller.signal.aborted) return;
      const models = data.models || [];
      setCatalog({ provider, loading: false, ready: data.ready === true, models, error: data.error || "" });
      if (provider !== "gpt" && models.length) setSelection(current => ({ ...current, [provider]: chooseVideoPromptModel(models, current[provider], data.defaultModel) }));
    }).catch(error => {
      if (!controller.signal.aborted) setCatalog({ provider, loading: false, ready: false, models: [], error: error.message });
    });
    return () => controller.abort();
  }, [provider]);
  const current = catalog.provider === provider;
  return { provider, setProvider, model: provider === "gpt" ? "default" : selection[provider],
    setModel: model => setSelection(values => ({ ...values, [provider]: model })),
    models: current ? catalog.models : [], loading: !current || catalog.loading, ready: current && catalog.ready, error: current ? catalog.error : "" };
}
