import { useEffect, useState } from "react";
import { DefaultStylePanel, useEditor } from "tldraw";

export default function UiStylePanel(props) {
  const editor = useEditor();
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem("drawpaint.ui-studio.style-collapsed") === "true"; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("drawpaint.ui-studio.style-collapsed", String(collapsed)); } catch { /* Optional preference. */ }
  }, [collapsed]);
  // Small screens already put this panel in a dismissible popover.
  if (props.isMobile) return <DefaultStylePanel {...props} />;
  return <div className="uis-collapsible-style">
    <button type="button" className="uis-style-toggle" aria-label={collapsed ? "展开样式面板" : "收起样式面板"}
      title={collapsed ? "展开颜色与样式" : "收起颜色与样式"} aria-expanded={!collapsed}
      onClick={() => { editor.updateInstanceState({ isChangingStyle: false }); setCollapsed(value => !value); }}>
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {collapsed ? <><rect x="3" y="3" width="14" height="14" rx="3" /><path d="M10 7v6M7 10h6" /></> : <path d="m5 12 5-5 5 5" />}
      </svg>
    </button>
    {!collapsed && <DefaultStylePanel {...props} />}
  </div>;
}
