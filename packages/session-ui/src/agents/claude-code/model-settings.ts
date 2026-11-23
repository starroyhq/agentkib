import type { Live } from "@agentkib/web-client";

type ModelExecution = {
  execution?: Live["execution"];
  executionMode?: string | null;
};

export function hasManagedPreparedSettings(state?: ModelExecution | null) {
  return state?.execution
    ? state.execution.owner === "agentkib"
    : state?.executionMode === "claude-managed";
}

export const terminalModelSettings = {
  inTerminal(state?: ModelExecution | null) {
    return state?.execution
      ? state.execution.owner === "terminal"
      : state?.executionMode === "claude-follower";
  },
  pickerOpen(live: Live) {
    return live.reason === "claude-model-picker-open";
  },
  managed: hasManagedPreparedSettings,
  rejectsModel(reason?: string) {
    return reason === "claude-model-unsupported" || reason === "claude-effort-unsupported";
  },
};
