async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  const type = res.headers.get("content-type") || "";
  if (type.includes("application/json")) return res.json();
  return res.text();
}

export function getSnapshot() {
  return api("/api/snapshot");
}

export function saveSnapshot(document, session) {
  return api("/api/snapshot", {
    method: "POST",
    body: JSON.stringify({ document, session }),
  });
}

export function saveSelection(payload) {
  return api("/api/selection", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function submitAgentRequest(payload) {
  return api("/api/agent-request", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getPendingInserts() {
  return api("/api/pending-inserts");
}

export function ackPendingInserts(ids) {
  return api("/api/pending-inserts/ack", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

export function uploadAsset(dataUrl, filename) {
  return api("/api/upload-asset", {
    method: "POST",
    body: JSON.stringify({ dataUrl, filename }),
  });
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function fileToDataUrl(file) {
  return blobToDataUrl(file);
}
