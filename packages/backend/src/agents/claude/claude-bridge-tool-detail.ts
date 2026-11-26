import type {
  ClaudeBridgeEvent,
  ClaudeBridgeSnapshot,
  ClaudeBridgeTool,
} from "@agentkib/runtime-protocol";
import { claudeToolDetail, claudeToolResult } from "../../conversation-tools";
import { sanitizeSessionText } from "../../session-handoff";
import { claudeQuestionnaire } from "./claude-question-history";

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

export function claudeBridgeToolItem(
  tool: ClaudeBridgeTool,
  id: string,
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

const QUESTION_TOOL = "AskUserQuestion";

export function terminalQuestionSettled(
  event: ClaudeBridgeEvent,
  turnTools: Map<string, ClaudeBridgeTool>,
  wasWaiting: ClaudeBridgeSnapshot["waiting"] | undefined,
) {
  return event.type === "snapshot"
    ? wasWaiting === "question" && event.snapshot.waiting !== "question"
    : event.type === "tool-complete" &&
        event.tool.name === QUESTION_TOOL &&
        turnTools.get(event.tool.id) === event.tool;
}

export function terminalToolItems(turnId: string | null, tools: Map<string, ClaudeBridgeTool>) {
  const items = new Map<string, ClaudeBridgeTool>();
  if (turnId)
    for (const tool of tools.values())
      if (tool.name !== QUESTION_TOOL) items.set(`claude-follower-tool:${tool.id}`, tool);
  return items;
}

function questionsFromInput(tool: ClaudeBridgeTool) {
  if (tool.name !== QUESTION_TOOL) return;
  const input = previewJson(tool.input);
  return (
    claudeQuestionnaire(input, "pending") ?? claudeQuestionnaire(record(input)?.input, "pending")
  )?.questions;
}

/** Read-only display data for a verified wait from the current terminal lease. */
export function terminalQuestions(
  snapshot: ClaudeBridgeSnapshot | null | undefined,
  turnTools: Map<string, ClaudeBridgeTool> | undefined,
) {
  if (snapshot?.waiting !== "question" || !snapshot.currentTurnId) return [];
  const turnId = snapshot.currentTurnId;
  const summary =
    snapshot.pendingQuestionSummary &&
    sanitizeSessionText(snapshot.pendingQuestionSummary, { value: 0 });
  const tracked = [...(turnTools?.values() ?? [])].filter((tool) => tool.name === QUESTION_TOOL);
  const running = tracked.filter((tool) => tool.status === "running");
  const tool = running.length === 1 ? running[0] : undefined;
  let questions = tool && questionsFromInput(tool);
  // Snapshot tool previews may include previous turns with the same wording.
  // Use the observed prompt alone when there is no tool known to be current.
  if (
    running.length === 0 &&
    summary &&
    tracked.some((item) => questionsFromInput(item)?.[0]?.question === summary)
  )
    return [];
  if (!questions && summary?.trim())
    questions = [{ id: "1", question: summary, multiSelect: false, options: [] }];
  if (!questions) return [];
  return [
    {
      requestId: tool?.id ?? turnId,
      turnId,
      supported: false as const,
      questions: questions.map((question) => ({ ...question, allowCustom: false })),
    },
  ];
}
