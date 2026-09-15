import path from "node:path";
import fs from "node:fs";
import { completeUiJob, completeUiLayers, completeUiRepairs, uiRequest } from "../server/ui-studio/client.mjs";
import { compactAgentOutput, cliHelp } from "../server/ui-studio/agent-output.mjs";

const [command, id, imagePath] = process.argv.slice(2);
try {
  let result;
  if (command === '--help' || command === 'help') { console.log(cliHelp); process.exit(0); }
  if (command === "list") result = await uiRequest("jobs");
  else if (command === "diagnose" && /^[a-f0-9-]{36}$/.test(id)) result = await uiRequest(`jobs/${id}/diagnostics`);
  else if (command === "vision") result = await uiRequest("vision");
  else if (command === "complete-repairs" && id && imagePath) result = await completeUiRepairs(id, path.resolve(imagePath));
  else if (command === "request" && /^[a-f0-9-]{36}$/.test(id)) result = await uiRequest(`jobs/${id}/agent-request`);
  else if (command === "claim" && /^[a-f0-9-]{36}$/.test(id)) result = await uiRequest(`jobs/${id}/claim`, {});
  else if (command === "fail" && /^[a-f0-9-]{36}$/.test(id)) result = await uiRequest(`jobs/${id}/agent-failed`, { error: imagePath || "Agent 生图未完成" });
  else if (command === "complete" && id && imagePath) result = await completeUiJob(id, path.resolve(imagePath));
  else if (command === "complete-layers" && id && imagePath) result = await completeUiLayers(id, path.resolve(imagePath));
  else if (command === "complete-plan" && id && imagePath) result = await uiRequest(`jobs/${id}/complete-plan`, JSON.parse(fs.readFileSync(path.resolve(imagePath), "utf8")));
  else if (command === "complete-classification" && id && imagePath) result = await uiRequest(`jobs/${id}/complete-classification`, JSON.parse(fs.readFileSync(path.resolve(imagePath), "utf8")));
  else if (command === "metadata" && id && imagePath) result = await uiRequest(`jobs/${id}/metadata`, JSON.parse(fs.readFileSync(path.resolve(imagePath), "utf8")));
  else throw new Error(cliHelp);
  console.log(JSON.stringify(process.argv.includes('--full') ? result : compactAgentOutput(command,result), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
