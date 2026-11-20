import { createHmac } from "node:crypto";
import type {
  ClaudeBridgeTerminalSubagent,
  SessionActivity,
  SubagentCatalog,
} from "@agentkib/runtime-protocol";
import { subagentObservationId } from "./session-subagents";

type ClaudeActivitySource = {
  tasks: unknown;
  observations: readonly { id: string; taskId?: string }[];
  sessionId: string;
  nativeId: string;
  bootId: string;
  identitySalt: () => string;
};
type ClaudeTask = { activity: SessionActivity; childId?: string };

// The snapshot loader and the native publisher may have different catalog coverage.
// Keep the pairing private so either can project from its actual catalog.
const tasksByState = new WeakMap<Record<string, unknown>, ClaudeTask[]>();

function claudeTasks({
  tasks,
  observations,
  sessionId,
  nativeId,
  bootId,
  identitySalt,
}: ClaudeActivitySource): ClaudeTask[] {
  if (!Array.isArray(tasks) || !tasks.length) return [];
  const salt = identitySalt();
  const taskIdsByTool = new Map(observations.map(({ id, taskId }) => [id, taskId]));
  return tasks.flatMap((task: unknown): ClaudeTask[] => {
    if (!task || typeof task !== "object" || !("id" in task) || typeof task.id !== "string")
      return [];
    const startedAt =
      "startedAt" in task && typeof task.startedAt === "string" ? task.startedAt : null;
    const title =
      "description" in task && typeof task.description === "string" ? task.description : "";
    const childId =
      "kind" in task &&
      task.kind === "agent" &&
      "toolUseId" in task &&
      typeof task.toolUseId === "string" &&
      taskIdsByTool.get(task.toolUseId) === task.id
        ? subagentObservationId({ sessionId, nativeId, agent: "claude-code" }, salt, task.toolUseId)
        : undefined;
    return [
      {
        activity: {
          id: createHmac("sha256", salt)
            .update(JSON.stringify(["background-task", sessionId, bootId, task.id, startedAt]))
            .digest("hex"),
          kind: "background-task",
          title,
          status: "running",
          startedAt,
        },
        childId,
      },
    ];
  });
}

/** Catalog children are already scoped to the parent and sanitized by the subagent reader. */
function subagentActivities(catalog: SubagentCatalog): SessionActivity[] {
  return catalog.agents.map((child) => ({
    id: child.id,
    kind: "subagent",
    title: child.name,
    status: child.status,
    ...(child.readable ? { childId: child.id } : {}),
  }));
}

function claudeActivities(tasks: ClaudeTask[], subagents?: SubagentCatalog): SessionActivity[] {
  const activities = subagents ? subagentActivities(subagents) : [];
  const children = new Map(activities.map((item) => [item.id, item]));
  const background = tasks.flatMap(({ activity, childId }) => {
    const child = childId ? children.get(childId) : undefined;
    if (!child) return [activity];
    child.startedAt = activity.startedAt;
    return [];
  });
  return [...background, ...activities];
}

export function prepareClaudeActivities(
  state: Record<string, unknown>,
  source: ClaudeActivitySource,
  subagents?: SubagentCatalog,
): void {
  const tasks = claudeTasks(source);
  tasksByState.set(state, tasks);
  state.activities = claudeActivities(tasks, subagents);
}

/** Terminal observations are scoped to the live binding and have no history or control ID. */
export function terminalSubagentActivities(
  subagents: readonly ClaudeBridgeTerminalSubagent[] | undefined,
  sessionId: string,
  leaseId: string,
): SessionActivity[] {
  return (subagents ?? []).map(({ id, title, status }) => ({
    id: createHmac("sha256", leaseId)
      .update(JSON.stringify(["terminal-subagent", sessionId, id]))
      .digest("hex"),
    kind: "subagent",
    title,
    status,
  }));
}

export function withSessionActivities(
  state: Record<string, unknown>,
  subagents?: SubagentCatalog & { available?: false },
  clearMissing = false,
): Record<string, unknown> {
  const catalog = subagents?.available !== false ? subagents : undefined;
  const tasks = tasksByState.get(state);
  const activities = tasks
    ? claudeActivities(tasks, catalog)
    : catalog && subagentActivities(catalog);
  // State patches merge into the previous live state, so omission cannot clear a lost source.
  return activities || clearMissing ? { ...state, activities: activities ?? [] } : state;
}
