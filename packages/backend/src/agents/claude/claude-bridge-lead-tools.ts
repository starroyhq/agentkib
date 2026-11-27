import { randomUUID } from "node:crypto";
import type { BridgeLead } from "./claude-bridge";

export function offeredLeadTools(
  lead: BridgeLead | undefined,
  sessionId: string,
  workerSettings: boolean | undefined,
) {
  try {
    return (
      lead
        ?.tools(sessionId)
        ?.filter(({ name }) => workerSettings || name !== "worker_settings")
        .sort(
          (a, b) => Number(a.name === "worker_restart") - Number(b.name === "worker_restart"),
        ) ?? null
    );
  } catch {
    // Losing a tool source must not prevent the terminal from getting its commands.
    return null;
  }
}

/** A lease can acknowledge only the complete tool list this host offered to it. */
export class ClaudeLeadToolsRegistration {
  #offer?: { key: string; id: string };
  #acknowledged?: string;

  acknowledge(id: string | null): void {
    this.#acknowledged = id && id === this.#offer?.id ? id : undefined;
  }

  offer(tools: ReturnType<BridgeLead["tools"]>): string | undefined {
    if (!tools?.length) {
      this.#offer = undefined;
      return;
    }
    const key = JSON.stringify(tools);
    if (key !== this.#offer?.key) this.#offer = { key, id: randomUUID() };
    return this.#offer.id;
  }

  ready(tools: ReturnType<BridgeLead["tools"]>): boolean {
    const id = this.offer(tools);
    return id !== undefined && this.#acknowledged === id;
  }
}
