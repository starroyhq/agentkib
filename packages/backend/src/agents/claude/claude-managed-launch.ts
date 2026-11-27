import type { ClaudeRunnerEffectiveSettings, ClaudeRunnerOptions } from "./claude-managed-runner";

/** Tool calls that start their own turns, including scheduled wake-ups. */
export const SCHEDULING_TOOLS = ["CronCreate", "CronDelete", "ScheduleWakeup"];

export function claudeManagedArgs(
  sessionId: string,
  fresh: boolean,
  settings: ClaudeRunnerEffectiveSettings,
  options: ClaudeRunnerOptions,
  backgroundTasksEnabled: boolean,
  mcpConfigFile?: string,
): string[] {
  const mcpConfig = options.catalogOnly === "auto-permission" ? '{"mcpServers":{}}' : mcpConfigFile;
  return [
    ...(fresh && options.forkSourceNativeId
      ? [
          `--resume=${options.forkSourceNativeId}`,
          "--fork-session",
          `--session-id=${sessionId}`,
          ...(options.forkCutoff ? [`--resume-session-at=${options.forkCutoff}`] : []),
        ]
      : [`${fresh ? "--session-id" : "--resume"}=${sessionId}`]),
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-prompts",
    "host",
    "--permission-prompt-tool",
    "stdio",
    // Scheduled prompts go with background work (SCHEDULING_TOOLS).
    ...(backgroundTasksEnabled || options.catalogOnly
      ? []
      : [`--disallowedTools=${SCHEDULING_TOOLS.join(",")}`]),
    ...(options.catalogOnly
      ? [
          "--no-session-persistence",
          "--safe-mode",
          "--strict-mcp-config",
          "--tools",
          "",
          "--no-chrome",
        ]
      : []),
    ...(settings.model ? ["--model", settings.model] : []),
    ...(settings.effort ? ["--effort", settings.effort] : []),
    ...(settings.permissionMode !== null ? ["--permission-mode", settings.permissionMode] : []),
    ...(mcpConfig ? ["--mcp-config", mcpConfig] : []),
    // Last: the option takes every argument after it.
    ...(options.allowedTools?.length ? ["--allowedTools", ...options.allowedTools] : []),
  ];
}
