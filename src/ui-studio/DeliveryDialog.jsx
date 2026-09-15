import { useEffect, useState } from "react";
import { uiApi, assetUrl, jobStateLabel } from "./api.js";
import { canvasDelivery } from "../../shared/ui-delivery.mjs";
import { useDialogFocus } from "./MockupWorkflow.jsx";

export default function DeliveryDialog({jobId,editor,saveStatus,onClose,onSelect}) {
  const [report,setReport]=useState(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const ref=useDialogFocus(onClose,busy);
  async function refresh() {
    setBusy(true);setError("");
    try { setReport(await uiApi(`jobs/${jobId}/diagnostics`)); } catch(e) { setError(e.message); }
    finally {setBusy(false);}
  }
  useEffect(()=>{refresh();},[jobId]);
  async function openThread(id) {
    setBusy(true);setError("");
    try {await uiApi(`jobs/${id}/open-thread`,{});} catch(e) {setError(e.message);} finally {setBusy(false);}
  }
  return <div className="uis-modal-backdrop"><section ref={ref} className="uis-dialog" role="dialog" aria-modal="true" aria-label="检查回填链路">
    <h2>检查回填链路</h2>
    <p>执行对话结束、素材处理完成和画布回填是三个不同阶段。对话会保留，方便检查失败原因与生成图片。</p>
    <p role="status">当前页面保存状态：{saveStatus}</p>
    {report && <>
      <p className="uis-hint">检查时间：{new Date(report.checkedAt).toLocaleString()} · 已保存画布版本：{report.snapshotRevision}</p>
      {report.snapshotError && <p className="uis-error">画布存档无法读取：{report.snapshotError}</p>}
      {report.registryError && <p className="uis-error">{report.registryError}</p>}
      {report.stages.map(s=>{
        const current=editor ? canvasDelivery({id:s.jobId,revision:s.candidates?.revision || s.revision,slices:s.candidates?.files || s.files},editor.store.allRecords()) : null;
        const plan=s.operation === "plan";
        return <article key={s.jobId} className="uis-job">
          <strong>{plan ? "方案分析" : "素材处理"}：{jobStateLabel({...s,id:s.jobId})}</strong>
          <p className="uis-hint">任务 ID：{s.jobId}</p>
          {s.error && <p className="uis-error" role="alert">{s.error}</p>}
          {s.thread?.attention && <p className="uis-error">{s.thread.attention}</p>}
          {plan ? <p>{s.continuationId ? "后续图片任务见下方。" : "尚无后续图片任务，方案完成不代表已拆出图片。"}</p> : <>
            {s.candidates && <p>已切图并去背景：{s.candidates.files.filter(f=>f.exists).length} / {s.candidates.files.length} 个候选图层。画布显示供检查，尚未确认为正式素材。</p>}
            <p>正式素材文件：{s.files.filter(f=>f.exists).length} / {s.files.length} 个存在</p>
            <p>已保存画布：{report.snapshotError ? "未知" : !s.canvas.expected ? "尚未产生可回填图层" : `${s.canvas.present} / ${s.canvas.expected} 层`}{s.canvas.expected>0 && (s.canvas.complete ? "（已写入存档，待视觉检查）" : "（尚未完整回填，或图层已被移除）")}</p>
            <p>当前编辑器：{current ? `${current.present} / ${current.expected} 层` : "未加载"}</p>
            {s.files.some(f=>!f.exists) && <p className="uis-error">缺少文件：{s.files.filter(f=>!f.exists).map(f=>f.name).join("、")}</p>}
            {s.canvas.missing.length>0 && <details><summary>未在存档中找到的图层</summary><p>{s.canvas.missing.map(f=>f.name).join("、")}</p></details>}
          </>}
          <div className="uis-job-actions">
            {s.thread?.threadId && <button disabled={busy} onClick={()=>openThread(s.jobId)}>打开执行对话{s.thread.state === "archived" ? "（恢复归档）" : ""}</button>}
            <button onClick={()=>{onSelect(s.jobId);onClose();}}>查看此素材任务</button>
            {s.sourceFile && <a href={assetUrl({id:s.jobId},s.sourceFile)} target="_blank" rel="noreferrer">原图</a>}
            {s.atlasFile && <a href={assetUrl({id:s.jobId},s.atlasFile)} target="_blank" rel="noreferrer">拼回结果</a>}
            {s.exportFile && <a href={assetUrl({id:s.jobId},s.exportFile)} download>图层包</a>}
          </div>
          {s.thread?.threadId && <p className="uis-hint">执行对话 ID：{s.thread.threadId}</p>}
        </article>;
      })}
    </>}
    {error && <p className="uis-error" role="alert">{error}</p>}
    <div className="uis-dialog-actions"><button disabled={busy} onClick={refresh}>刷新检查</button><button disabled={busy} onClick={onClose}>关闭</button></div>
  </section></div>;
}
