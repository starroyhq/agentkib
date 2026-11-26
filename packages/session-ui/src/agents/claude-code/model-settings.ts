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

const modelFamilies = new Map([
  ["opus", "Opus"],
  ["sonnet", "Sonnet"],
  ["haiku", "Haiku"],
]);

export const terminalModelSettings = {
  displayName(modelId: string) {
    const alias = modelFamilies.get(modelId);
    if (alias) return alias;
    // Older Claude IDs place the family after the version.
    const normalized = modelId.replace(
      /^claude-(\d{1,2}(?:-\d{1,2})?)-([a-z]+)(?=-|$)/,
      "claude-$2-$1",
    );
    const version = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:-(?:\d{8}|latest))?$/.exec(
      normalized,
    );
    if (!version) return undefined;
    const [, family, major, minor] = version;
    const name = modelFamilies.get(family);
    return name ? `${name} ${minor ? `${major}.${minor}` : major}` : undefined;
  },
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
