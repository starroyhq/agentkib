import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { WebContents } from "electron";
import { REMOTE_ROUTE, REMOTE_ROUTE_BASE } from "@agentkib/runtime-protocol";

const captureRoute = "/__acceptance/read-state";
type Response = { status: number; body: unknown };
type Counts = { reads: number; confirmations: number; rateLimited: number };

function createRound(sessionId: string) {
  const pending = new Set<Promise<void>>();
  const counts: Counts = { reads: 0, confirmations: 0, rateLimited: 0 };
  let confirmedResultId: string | null = null;
  let confirm!: () => void;
  const confirmed = new Promise<void>((resolve) => {
    confirm = resolve;
  });
  return {
    confirmed,
    observe(route: string, body: unknown, dispatch: () => Promise<Response>) {
      const [pathname, query] = route.replace(/^\/?/, "/").split("?", 2);
      if (
        pathname !== REMOTE_ROUTE.readState &&
        pathname !== REMOTE_ROUTE_BASE + REMOTE_ROUTE.readState
      )
        return dispatch();
      const update = body !== undefined;
      const receipt = body as { sessionId?: unknown; seenResultId?: unknown } | null;
      const target = update ? receipt?.sessionId : new URLSearchParams(query).get("sessionId");
      if (target !== sessionId) return dispatch();
      if (update) counts.confirmations++;
      else counts.reads++;
      const response = dispatch();
      const completion = response
        .then(
          ({ status }) => {
            if (status === 429) counts.rateLimited++;
            if (update && status === 200) {
              if (typeof receipt?.seenResultId === "string")
                confirmedResultId ??= receipt.seenResultId;
              confirm();
            }
          },
          () => {},
        )
        .finally(() => {
          pending.delete(completion);
        });
      pending.add(completion);
      return response;
    },
    async finish() {
      // Calls admitted while waiting also belong to this round.
      while (pending.size) await Promise.all(pending);
      return { ...counts, confirmedResultId };
    },
  };
}

/** The packaged acceptance launcher opts in with its own disposable profile. */
export function desktopReadStateAcceptance(env: NodeJS.ProcessEnv) {
  if (env.AGENTKIB_DESKTOP_ACCEPTANCE_READ_STATE !== "1") return undefined;
  const profile = realpathSync(env.AGENTKIB_BENCHMARK_USER_DATA ?? "");
  const data = realpathSync(env.AGENTKIB_BENCHMARK_DATA_DIR ?? "");
  const root = dirname(profile);
  if (
    dirname(root) !== realpathSync("/private/tmp") ||
    !basename(root).startsWith("agentkib-desktop-acceptance-") ||
    profile !== join(root, "profile") ||
    data !== join(root, "data") ||
    env.AGENTKIB_DATA_DIR !== data
  )
    throw new Error("desktop_acceptance_requires_isolated_temporary_data");

  return createReadStateAcceptance();
}

export function createReadStateAcceptance() {
  const rounds = new WeakMap<WebContents, ReturnType<typeof createRound>>();
  return (sender: WebContents, route: string, body: unknown, dispatch: () => Promise<Response>) => {
    const round = rounds.get(sender);
    if (route !== captureRoute) return round?.observe(route, body, dispatch) ?? dispatch();
    const input = body as { action?: unknown; sessionId?: unknown } | null | undefined;
    if (input?.action === "start" && typeof input.sessionId === "string" && !round) {
      rounds.set(sender, createRound(input.sessionId));
      return { status: 200, body: {} };
    }
    if (input?.action === "confirmed" && round)
      return round.confirmed.then(() => ({ status: 200, body: {} }));
    if (input?.action === "finish" && round)
      return round.finish().then((counts) => {
        rounds.delete(sender);
        return { status: 200, body: counts };
      });
    throw new Error("invalid_desktop_read_state_acceptance_action");
  };
}
