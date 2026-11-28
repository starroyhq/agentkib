import type { SessionProviderDeclaration } from "@agentkib/web-client";
import type { SessionSurface } from "../session-surface-copy";
import { resolveSessionProvider } from "../session-provider";
import { claudeSessionBanner } from "./claude-code/connection-notice";

type ConnectionKind = NonNullable<SessionProviderDeclaration["connection"]>["kind"];
type BannerFormatter = typeof claudeSessionBanner;
type BannerState = Parameters<BannerFormatter>[0];
type Banner = ReturnType<BannerFormatter>;

const connectionNotices: Partial<Record<ConnectionKind, BannerFormatter>> = {
  "terminal-bridge": claudeSessionBanner,
};

export function sessionConnectionBanner(
  session: BannerState & {
    current?: Parameters<typeof resolveSessionProvider>[0];
    capabilities?: Parameters<typeof resolveSessionProvider>[1];
  },
  surface: SessionSurface = "desktop",
) {
  const connection = resolveSessionProvider(session.current, session.capabilities)?.connection;
  return connection ? (connectionNotices[connection.kind]?.(session, surface) ?? null) : null;
}

/** The reader presents session recovery and background-process notices above the composer. */
export function sessionBannerAtComposer(banner: Banner): boolean {
  return (
    banner?.reconcileOutcome === true ||
    banner?.notice === "background-limit" ||
    banner?.notice === "lead-turn-limit"
  );
}
