import type { ClaudeBridgeTool } from "@agentkib/runtime-protocol";
import { claudeToolDetail, claudeToolResult } from "../../conversation-tools";
import { sanitizeSessionText } from "../../session-handoff";

const BRIDGE_PREVIEW_SUFFIX =
  "\n[AgentKib preview truncated; read the original history for full content]";

function previewJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    // The bridge can clip a JSON string before transport. Never show an
    // undecoded fragment, which may have been cut inside a sensitive value.
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value))
    return value as Record<string, unknown>;
}

function claudeBridgeToolDetail(tool: ClaudeBridgeTool, workspace: string) {
  const {
    tool: _name,
    tool_use_id: _id,
    consent: _consent,
    requestMeta: _meta,
    agentId: _agent,
    ...input
  } = record(previewJson(tool.input)) ?? {};
  const output = previewJson(tool.output);
  const envelope = record(output);
  const reply = envelope?.result ?? envelope?.deny ?? output;
  const structured = record(reply);
  const result = claudeToolResult(structured, structured?.content ?? structured?.text ?? reply);
  const detail = claudeToolDetail(tool.name, input, result, { workspace, cwd: workspace });
  if (
    detail &&
    (tool.input.endsWith(BRIDGE_PREVIEW_SUFFIX) || tool.output?.endsWith(BRIDGE_PREVIEW_SUFFIX))
  )
    detail.truncated = true;
  return detail;
}

export function claudeBridgeToolEvent(
  id: string,
  tool: ClaudeBridgeTool,
  turnId: string | null,
  workspace: string,
) {
  const detail = claudeBridgeToolDetail(tool, workspace);
  return {
    id,
    kind: "tool-summary",
    content: "",
    tool_name: sanitizeSessionText(tool.name, { value: 0 }),
    tool_status: tool.status,
    attachment_count: 0,
    truncated: false,
    turn_id: turnId,
    ...(detail ? { tool: detail } : {}),
  };
}
