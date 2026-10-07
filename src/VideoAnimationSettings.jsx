export default function VideoAnimationSettings({ value, onChange, disabled }) {
  return <div className="vs-animation-settings">
    <div className="vs-animation-mode" role="group" aria-label="视频用途"><button type="button" className={!value.enabled ? "is-current" : ""} aria-pressed={!value.enabled} disabled={disabled} onClick={() => onChange({ ...value, enabled: false })}>正常视频</button><button type="button" className={value.enabled ? "is-current" : ""} aria-pressed={value.enabled} disabled={disabled} onClick={() => onChange({ ...value, enabled: true })}>帧动画视频</button></div>
    {!value.enabled && <p className="vs-help">保留参考图背景，按动作描述生成正常视频。</p>}
    {value.enabled && <><label>帧动画底色<select value={value.background} disabled={disabled} onChange={event => onChange({ ...value, background: event.target.value })}><option value="auto">自动（优先品红）</option><option value="#ff00ff">品红 #FF00FF</option><option value="#00ff00">绿色 #00FF00</option></select></label><p className="vs-help">首尾图统一纯色底，生成后逐帧统一为所选底色；主体含品红时自动改用绿色。原参考图和模型原始视频会保留。</p><small>参考图需为透明图或均匀纯色底。复杂背景请先在素材工坊处理。</small></>}
  </div>;
}
