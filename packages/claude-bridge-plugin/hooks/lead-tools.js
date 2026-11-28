export const CLAUDE_BRIDGE_HOST_RESOURCES_FEATURE = "lead-host-resources";
export const CLAUDE_BRIDGE_LEAD_TOOLS_REGISTRATION_FEATURE = "lead-tools-registration";
export const CLAUDE_BRIDGE_WORKER_SETTINGS_FEATURE = "lead-worker-settings";
export const WORKER_SETTINGS_TOOL = "worker_settings";

export const LEAD_TOOLS = [
  "worker_list",
  "worker_open",
  "worker_send",
  "worker_read",
  "worker_stop",
  "worker_approve",
  "worker_answer",
  // Keep accepting both tools even when a host offers one at a time.
  "worker_close",
  "worker_restart",
  WORKER_SETTINGS_TOOL,
];

export function workerSettingsOffered(features) {
  return Array.isArray(features) && features.includes(CLAUDE_BRIDGE_WORKER_SETTINGS_FEATURE);
}

export function acceptsLeadTool(name, features) {
  return (
    LEAD_TOOLS.includes(name) && (name !== WORKER_SETTINGS_TOOL || workerSettingsOffered(features))
  );
}

export function validLeadTool(tool, features) {
  return (
    tool &&
    typeof tool === "object" &&
    acceptsLeadTool(tool.name, features) &&
    typeof tool.description === "string" &&
    tool.description.length > 0 &&
    tool.description.length <= 8192 &&
    tool.inputSchema &&
    typeof tool.inputSchema === "object" &&
    !Array.isArray(tool.inputSchema)
  );
}

export const refusedLeadTool = (reason, controlOutcome = "not-dispatched", message) => ({
  deny: JSON.stringify({
    accepted: false,
    reason,
    controlOutcome,
    ...(message && { message }),
    ...(controlOutcome === "unknown" && { outcome: "unknown" }),
  }),
});

function leadToolReadOnly(name, input) {
  return name === WORKER_SETTINGS_TOOL
    ? !["modelId", "reasoningEffort", "serviceTierId", "role"].some((key) =>
        Object.hasOwn(input, key),
      )
    : name === "worker_list" || name === "worker_read";
}

export async function leadToolResult(name, input, call) {
  try {
    const answer = await call();
    if (typeof answer?.text === "string")
      return answer.isError ? { deny: answer.text } : { result: answer.text };
  } catch {
    // A lost response does not prove that the host did not receive the call.
  }
  return leadToolReadOnly(name, input)
    ? refusedLeadTool("worker-probe-failed")
    : refusedLeadTool("control-outcome-unconfirmed", "unknown");
}
