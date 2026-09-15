import { createContext, useCallback, useContext } from "react";
import { ContextMenu } from "radix-ui";
import { DefaultContextMenuContent, TldrawUiMenuContextProvider, TldrawUiMenuGroup, TldrawUiMenuItem, useContainer, useEditor, useEditorComponents, useMenuIsOpen, useTranslation, useValue } from "tldraw";
import { sliceForShape } from "./layer-tree.js";
import UiZoomMenu from "./UiZoomMenu.jsx";
import UiStylePanel from "./UiStylePanel.jsx";

export const UiRefineContext = createContext(null);

export function UiContextMenu({ disabled = false }) {
  const editor = useEditor();
  const container = useContainer();
  const { Canvas } = useEditorComponents();
  const msg = useTranslation();
  // Keep Radix and the editor's menu registry in sync. Canvas pointer-down
  // can clear the registry before Radix receives its outside-click dismissal.
  const handleOpen = useCallback(open => {
    const selected = editor.getSelectedShapes();
    if (!open && selected.length === 1 && editor.isShapeOrAncestorLocked(selected[0])) editor.selectNone();
    if (open && editor.getInstanceState().isCoarsePointer) {
      const underPointer = editor.getShapesAtPoint(editor.inputs.currentPagePoint);
      if (!underPointer.some(s => selected.some(item => item.id === s.id))) {
        const locked = underPointer.filter(s => editor.isShapeOrAncestorLocked(s));
        if (locked.length) editor.select(...locked.map(s => s.id));
      }
    }
  }, [editor]);
  const [isOpen, onOpenChange] = useMenuIsOpen("context menu", handleOpen);
  const { jobs, busy, ready, onRefine } = useContext(UiRefineContext);
  const shape = useValue("UI context selection", () => editor.getOnlySelectedShape(), [editor]);
  const job = jobs.find(j => j.id === shape?.meta?.uiJobId && j.revision === shape.meta.uiRevision);
  const slice = sliceForShape(job, shape?.meta);
  const valid = job?.status === "ready" && !shape?.meta.uiNodeKey && (slice || shape.meta.uiRole === "layer-group");
  return <ContextMenu.Root open={isOpen} onOpenChange={onOpenChange} modal={false} dir="ltr">
    <ContextMenu.Trigger disabled={disabled} onPointerDownCapture={event => {
      if (event.button === 2) editor.focus();
    }}>
      {Canvas && <Canvas />}
    </ContextMenu.Trigger>
    <ContextMenu.Portal container={container}>
      <ContextMenu.Content className="tlui-menu tlui-scrollable" data-testid="context-menu" aria-label={msg("context-menu.title")}
        alignOffset={-4} collisionPadding={4} onContextMenu={event => event.preventDefault()}
        onEscapeKeyDown={event => { event.stopPropagation(); container.focus({ preventScroll: true }); }}>
        <TldrawUiMenuContextProvider type="context-menu" sourceId="context-menu">
          {valid && <TldrawUiMenuGroup id="ui-refine"><TldrawUiMenuItem id="ui-refine" label="拆分" disabled={busy || !ready}
            onSelect={() => onRefine({ job, slice })} /></TldrawUiMenuGroup>}
          <DefaultContextMenuContent />
        </TldrawUiMenuContextProvider>
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>;
}

export const uiComponents = { ContextMenu: UiContextMenu, ZoomMenu: UiZoomMenu, StylePanel: UiStylePanel, ImageToolbar: null };
