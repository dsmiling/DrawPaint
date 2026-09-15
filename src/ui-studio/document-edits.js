// tldraw's updateDocumentSettings explicitly ignores history. Layer edits are
// user actions, so write the document record in the surrounding history batch.
export function updateLayerDocument(editor, meta) {
  editor.store.put([{ ...editor.getDocumentSettings(), meta }]);
}
