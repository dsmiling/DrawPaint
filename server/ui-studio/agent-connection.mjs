import fs from "node:fs";
import path from "node:path";

// The desktop connector owns its credentials and session binding. Neither is sent to the browser.
export function createAgentConnection(root) {
  const file = path.join(root, "agent-connection.local.json");
  function read() {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !/^[a-f0-9]{64}$/.test(value.token)) return null;
      return value;
    } catch { return null; }
  }
  async function request(route, data, timeout) {
    const connection = read();
    if (!connection) throw new Error("Agent 尚未连接画布，请让当前 Agent 启动本机连接。");
    const response = await fetch(`http://127.0.0.1:${connection.port}/${route}`, {
      method: data === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(timeout),
      headers: { Authorization: `Bearer ${connection.token}`, ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Agent 连接失败");
    return result;
  }
  return {
    async status() {
      try { const result = await request("health", undefined, 1500); return { connected: result.connected === true }; }
      catch { return { connected: false }; }
    },
    async dispatch(jobId) { return request("dispatch", { jobId }, 45000); },
    async openThread(jobId) { return request("open-thread", { jobId }, 15000); },
  };
}
