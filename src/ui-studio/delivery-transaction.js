import { canvasDelivery } from "../../shared/ui-delivery.mjs";

export function verifiedDelivery(editor, job, mutate, capture, restore) {
  const backup=capture();
  const verify=()=>{
    const result=canvasDelivery(job,editor.store.allRecords());
    if (!result.complete) throw new Error(`回填不完整：${result.present}/${result.expected} 个图层，已恢复原画布`);
  };
  try {
    editor.run(()=>{ mutate(); verify(); });
    // Editor transaction completion can run side effects after our callback.
    verify();
  } catch(error) { restore(backup); throw error; }
}
