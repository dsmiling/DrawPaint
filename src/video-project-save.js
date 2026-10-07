import { mergeVideoProjectSnapshots } from "../shared/video-project-sync.js";

// Each workspace owns its queue, revision and canvas-specific transport.
export function createProjectSaver({ getSnapshot, send, onStatus, onSaved }) {
  let saved = null, revision = null, queue = Promise.resolve(), conflict = null;
  return {
    seed(snapshot, baseRevision) { saved = snapshot; revision = baseRevision; conflict = null; },
    dirty() { return saved !== null && getSnapshot() !== saved; },
    revision() { return revision; },
    receive(snapshot, baseRevision, expectedRevision, apply) {
      const task = queue.catch(() => {}).then(() => {
        // A GET that started before our own save must not roll it back.
        if (saved === null || revision !== expectedRevision || revision === baseRevision) return false;
        const local = JSON.parse(getSnapshot()), remote = JSON.parse(snapshot);
        const merged = mergeVideoProjectSnapshots(JSON.parse(saved), local, remote);
        if (!merged) return false;
        if (apply(merged) === false) return false;
        revision = baseRevision; conflict = null;
        // Remote camera changes should not make two open tabs save each other's
        // view forever. Keep this tab's view while adopting the remote content.
        saved = JSON.stringify({ ...remote, view: merged.view });
        onStatus(getSnapshot() === saved ? "saved" : "dirty");
        return true;
      });
      queue = task; return task;
    },
    flush() {
      const task = queue.catch(() => {}).then(async () => {
        if (conflict) throw conflict;
        if (saved === null) throw new Error("画布尚未加载，暂时无法保存");
        while (getSnapshot() !== saved) {
          const snapshot = getSnapshot();
          onStatus("saving");
          try {
            const project = await send(JSON.parse(snapshot), revision);
            revision = project.revision ?? project.updatedAt ?? null;
            saved = snapshot;
            onSaved(project);
          } catch (error) {
            if (error.status === 409) conflict = error;
            onStatus("error");
            throw error;
          }
        }
        onStatus("saved");
      });
      queue = task;
      return task;
    },
  };
}
