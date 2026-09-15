import { DefaultZoomMenu, TldrawUiMenuItem, ZoomTo100MenuItem, ZoomToFitMenuItem, ZoomToSelectionMenuItem, useActions } from "tldraw";

export default function UiZoomMenu() {
  const actions = useActions();
  return <DefaultZoomMenu>
    <TldrawUiMenuItem {...actions['zoom-in']} kbd="ctrl+[[滚轮↑]]" noClose />
    <TldrawUiMenuItem {...actions['zoom-out']} kbd="ctrl+[[滚轮↓]]" noClose />
    <ZoomTo100MenuItem />
    <ZoomToFitMenuItem />
    <ZoomToSelectionMenuItem />
  </DefaultZoomMenu>;
}
