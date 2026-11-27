import { workStoppedByQuit, type HomeSession } from "@agentkib/session-catalog";
import {
  REMOTE_ERROR_CODES as codes,
  RUNTIME_METHODS,
  type QuitWorkPreview,
} from "@agentkib/runtime-protocol";
import type { LocalRuntimeTraceEvent } from "@agentkib/backend/local-runtime-trace";
import type { QuitRequest } from "../api";
import { RuntimeRequestError } from "./runtime-host";

type QuitWorkReads = {
  peers?: () => Promise<number>;
  prepare: () => Promise<QuitWorkPreview>;
  catalog: () => Promise<readonly HomeSession[] | undefined> | undefined;
  record?: (event: LocalRuntimeTraceEvent) => void;
};

/** The catalog fallback can warn about work. Only a verified runtime preview carries a ticket. */
export async function readDesktopQuitWork(
  read: QuitWorkReads,
  deadline = 2_000,
): Promise<QuitRequest> {
  async function prepare(): Promise<QuitRequest> {
    if (((await read.peers?.().catch(() => 0)) ?? 0) > 0) return { work: [] };
    let failed = false;
    try {
      const preview = await read.prepare();
      if (!preview.reason) {
        const work = preview.work.map(({ title, agent, resumable, reason }) => ({
          title,
          agent,
          resumable,
          ...(reason && { reason }),
        }));
        return work.length
          ? { work, ticket: preview.ticket, resumeByDefault: preview.resumeByDefault }
          : { work };
      }
      failed = true;
    } catch (error) {
      // An older runtime can relay the catalog without implementing preparation.
      failed = !(error instanceof RuntimeRequestError && error.code === -32601);
    }
    const sessions = await read.catalog();
    const work = sessions
      ? workStoppedByQuit(sessions)
          .filter((session) => session.continuation?.executionLocation === "agentkib")
          .slice(0, 50)
          .map((session) => ({ title: session.title ?? "", agent: session.agent }))
      : [];
    return { work, ...((failed || !sessions) && { reason: codes.quitWorkPlanUnavailable }) };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = performance.now();
  try {
    const request = await Promise.race([
      prepare().catch(() => ({ work: [], reason: codes.quitWorkPlanUnavailable })),
      new Promise<QuitRequest>((resolve) => {
        timer = setTimeout(() => resolve({ work: [], reason: codes.deadlineExceeded }), deadline);
      }),
    ]);
    if (request.reason)
      read.record?.({
        kind: "request",
        method: RUNTIME_METHODS.quitWorkPrepare,
        stage: "host-admission",
        durationMs: performance.now() - started,
        outcome: request.work.length ? "partial" : "failed",
        reason: request.reason,
      });
    return request;
  } finally {
    clearTimeout(timer);
  }
}
