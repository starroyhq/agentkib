import { createHmac } from "node:crypto";
import type { SessionActivity, SubagentCatalog } from "@agentkib/runtime-protocol";

export function backgroundTaskActivities(
  tasks: unknown,
  sessionId: string,
  bootId: string,
  identitySalt: () => string,
): SessionActivity[] {
  if (!Array.isArray(tasks) || !tasks.length) return [];
  const salt = identitySalt();
  return tasks.flatMap((task: unknown): SessionActivity[] => {
    if (!task || typeof task !== "object" || !("id" in task) || typeof task.id !== "string")
      return [];
    const startedAt =
      "startedAt" in task && typeof task.startedAt === "string" ? task.startedAt : null;
    const title =
      "description" in task && typeof task.description === "string" ? task.description : "";
    return [
      {
        id: createHmac("sha256", salt)
          .update(JSON.stringify(["background-task", sessionId, bootId, task.id, startedAt]))
          .digest("hex"),
        kind: "background-task",
        title,
        status: "running",
        startedAt,
      },
    ];
  });
}

/** Catalog children are already scoped to the parent and sanitized by the subagent reader. */
export function subagentActivities(catalog: SubagentCatalog): SessionActivity[] {
  return catalog.agents.map((child) => ({
    id: child.id,
    kind: "subagent",
    title: child.name,
    status: child.status,
    ...(child.readable ? { childId: child.id } : {}),
  }));
}
