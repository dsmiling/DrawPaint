export default function VideoModelSetup({ setup, selectedModel, onSelect, onRefresh, onStart, starting }) {
  const models = setup?.models || [];
  return <section className="vs-model-setup">
    <h2>视频模型</h2>
    <p className="vs-help">视频生成连接本机 ComfyUI。先启动服务并检查模型文件，再选择可用模型；第一次生成时模型会加载到内存。</p>
    <div className="vs-model-service"><div><strong>ComfyUI 服务</strong><small>{setup?.endpoint || "http://127.0.0.1:8188"}</small></div><span className={setup?.connected ? "vs-online" : "vs-offline"}>{setup?.connected ? "● 已连接" : setup?.starting ? "◌ 启动中" : "● 未连接"}</span></div>
    <div className="vs-model-actions"><button type="button" onClick={onRefresh}>重新检查</button><button type="button" className="vs-primary" onClick={onStart} disabled={starting || setup?.connected || setup?.starting || !setup?.startAvailable || !models.some(item => item.installed)}>{starting || setup?.starting ? "正在启动…" : "启动本机 ComfyUI"}</button></div>
    {!setup?.connected && <p className="vs-help">{setup?.error || "正在检查服务…"} 请启动本机 ComfyUI；如果 DrawPaint 上一级目录已有启动脚本，也可运行 <code>powershell -ExecutionPolicy Bypass -File .\start_comfy.ps1</code>。</p>}
    <div className="vs-model-list" role="radiogroup" aria-label="选择视频模型">{models.map(model => <label key={model.id} className={`vs-model-option ${selectedModel === model.id ? "is-selected" : ""}`}><input type="radio" name="video-model" value={model.id} checked={selectedModel === model.id} onChange={() => onSelect(model.id)} /><span><strong>{model.name}</strong><small>{model.description}</small><small className={model.ready ? "vs-online" : "vs-offline"}>{model.ready ? "可生成" : !model.installed ? "缺少权重" : !setup?.connected ? "等待连接" : model.missingNodes.length ? "缺少节点" : "检查中"}</small></span></label>)}</div>
    {models.filter(model => !model.installed || model.missingNodes.length).map(model => <div className="vs-model-missing" key={model.id}><strong>{model.name} 待配置</strong>{model.missingFiles.length > 0 && <p>缺少文件：{model.missingFiles.join("、")}</p>}{model.missingNodes.length > 0 && <p>缺少节点：{model.missingNodes.join("、")}</p>}</div>)}
    <p className="vs-help">模型文件放在项目或数据目录同级的 <code>ComfyUI/models/</code> 对应目录。选择模型只影响之后新生成的片段，已有片段继续保留。</p>
  </section>;
}
