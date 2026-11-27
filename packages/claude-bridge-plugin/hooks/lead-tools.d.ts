export const CLAUDE_BRIDGE_HOST_RESOURCES_FEATURE: "lead-host-resources";
export const CLAUDE_BRIDGE_LEAD_TOOLS_REGISTRATION_FEATURE: "lead-tools-registration";
export const CLAUDE_BRIDGE_WORKER_SETTINGS_FEATURE: "lead-worker-settings";
export const WORKER_SETTINGS_TOOL: "worker_settings";
export const LEAD_TOOLS: readonly string[];
export function workerSettingsOffered(features?: readonly string[]): boolean;
export function acceptsLeadTool(name: string, features?: readonly string[]): boolean;
export function validLeadTool(tool: unknown, features?: readonly string[]): boolean;
export function refusedLeadTool(
  reason: string,
  controlOutcome?: "not-dispatched" | "unknown",
): { deny: string };
export function leadToolResult(
  name: string,
  input: Record<string, unknown>,
  call: () => Promise<unknown>,
): Promise<{ deny: string } | { result: string }>;
