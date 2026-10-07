import { useEffect, useState } from "react";
import { getQwenHealth } from "./api.js";

export default function ImageProvider({ value, onChange, disabled = false, compact = false }) {
  const [health, setHealth] = useState(null);
  const [checking, setChecking] = useState(false);
  async function check() {
    setChecking(true);
    try { setHealth(await getQwenHealth()); }
    catch (error) { setHealth({ ready: false, error: error.message }); }
    finally { setChecking(false); }
  }
  useEffect(() => { if (value === "qwen") check(); }, [value]);
  return <div className={`dp-image-provider${compact ? " is-compact" : ""}`}>
    <label>生图模型 <select aria-label="生图模型" value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
      <option value="agent">GPT</option>
      <option value="qwen">Qwen（本地）</option>
    </select></label>
    {value === "qwen" && <span role="status" title={health?.error || "通过本机 ComfyUI 生成图片"}>
      {checking ? "检查模型…" : health?.ready ? "本地模型已就绪" : health?.error || "等待检查"}
      <button type="button" onClick={check} disabled={checking}>检查连接</button>
    </span>}
  </div>;
}
