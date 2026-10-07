import { useReducer, useRef } from "react";
import { editHistory } from "../shared/video-editing.js";

export default function useVideoDocument() {
  const [history, dispatch] = useReducer(editHistory, { present: { clips: [], outputSize: "640x640" }, past: [], future: [], group: null });
  const group = useRef(null);
  const setClips = (value, record = true) => dispatch({ type: record ? "edit" : "system", group: group.current, update: document => ({ ...document, clips: typeof value === "function" ? value(document.clips) : value }) });
  return { ...history.present, setClips, setOutputSize: outputSize => dispatch({ type: "edit", update: document => ({ ...document, outputSize }) }),
    reset: document => dispatch({ type: "reset", document }), undo: () => dispatch({ type: "undo" }), redo: () => dispatch({ type: "redo" }),
    begin: () => { group.current = crypto.randomUUID(); }, end: () => { group.current = null; dispatch({ type: "stop" }); },
    canUndo: history.past.length > 0, canRedo: history.future.length > 0 };
}
