import { sessionContinuationCopy } from "@agentkib/session-ui";
import { describe, expect, it } from "vitest";
import {
  claudeBackgroundStatus,
  claudeComposerNotice,
  claudeSessionBanner,
} from "./claude-session-banner";
import { claudeConnectionCopy, claudeConnectionReason } from "./claude-connection-copy";
import { sessionDisplayState } from "./session-display-state";
import type { SessionController } from "./use-session-controller";

function fixture(
  locale: SessionController["locale"],
  executionMode: string,
  status: string,
  reason?: string,
) {
  return {
    locale,
    online: true,
    controlReady: true,
    canSend: false,
    busy: false,
    t: { controlUnconfirmed: "unconfirmed" },
    current: { id: "s", agent: "claude-code", availability: "readable", origin: "interactive" },
    selected: "s",
    access: {
      status: "approved",
      protocolVersion: 2,
      experimentalEnabled: true,
      device: { send: true, manage: true },
    },
    live: { sessionId: "s", executionMode, status, reason, approvals: [], questions: [] },
    capabilities: { sessionId: "s", features: { adopt: { available: true } } },
  } as unknown as SessionController;
}
describe("Claude execution and terminal connection presentation", () => {
  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "explains authenticated reconnect compatibility failures without overriding safety in %s",
    (locale) => {
      const copy = claudeConnectionCopy[locale];
      for (const reason of [
        "bridge-cli-too-old",
        "bridge-cli-unsupported",
        "bridge-capabilities-missing",
        "bridge-plugin-update-required",
      ]) {
        const failed = fixture(locale, "claude-follower", "unsupported", reason);
        const failure = {
          reason,
          cliVersion: "2.1.300",
          missingCapabilities: ["session-messages"],
        };
        Object.assign(failed.live!, { bridgeConnectionFailure: failure });
        const expected = claudeConnectionReason(locale, reason, "desktop", failure);
        expect(claudeSessionBanner(failed)).toEqual({
          title: copy.lostTitle,
          body: expected,
          connection: true,
        });
        expect(sessionDisplayState(failed)).toMatchObject({
          reason: expected,
          continuation: "view-only",
        });
        expect(claudeSessionBanner({ ...failed, online: false })).toEqual({
          title: copy.hostDisconnected,
          body: copy.hostDisconnectedInfo,
          connection: true,
        });
        const uncertain = { ...failed, notice: "uncertain" as const };
        expect(claudeSessionBanner(uncertain)?.body).toBe(copy.connectionUnconfirmed);
        expect(sessionDisplayState(uncertain).reason).not.toBe(expected);
        const denied = {
          ...failed,
          access: { ...failed.access!, device: { ...failed.access!.device!, send: false } },
        };
        expect(claudeSessionBanner(denied)).toBeNull();
        expect(sessionDisplayState(denied).reason).not.toBe(expected);
        Object.assign(failed.live!, {
          bridgeConnectionFailure: { ...failure, reason: "other-failure" },
        });
        expect(claudeSessionBanner(failed)?.body).toBe(copy.lost);
        Object.assign(failed.live!, { bridgeConnectionFailure: null });
        expect(claudeSessionBanner(failed)?.body).toBe(copy.lost);
        expect(sessionDisplayState(failed).reason).toBe(copy.lost);
        Object.assign(failed.live!, {
          bridgeConnectionFailure: null,
          reason: "claude-bridge-disconnected",
        });
        expect(claudeSessionBanner(failed)).toEqual({
          title: copy.lostTitle,
          body: copy.lost,
          connection: true,
        });
        expect(sessionDisplayState(failed).reason).toBe(copy.lost);
      }
    },
  );
  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "keeps ownership, connection and failure states distinct in %s",
    (locale) => {
      const copy = claudeConnectionCopy[locale];
      expect(copy.managedUnconfirmed).toContain("Claude Code");
      expect(copy.managedUnconfirmed).not.toMatch(
        /主机|主機|\bhost\b|ホスト|刷新|重新整理|refresh/i,
      );
      const continuation = sessionContinuationCopy(locale);
      const idle = fixture(locale, "claude-managed", "idle");
      idle.canSend = true;
      expect(claudeSessionBanner(idle)).toBeNull();
      expect(sessionDisplayState(idle)).toMatchObject({ label: "", continuation: "idle" });
      const managed = fixture(locale, "claude-managed", "idle");
      managed.live!.executionLocation = "agentkib";
      expect(claudeSessionBanner(managed)).toBeNull();
      expect(sessionDisplayState(managed)).toMatchObject({
        label: continuation.running,
        continuation: "running",
      });
      for (const unconfirmed of [
        fixture(locale, "claude-managed", "outcome-unknown", "control-outcome-unconfirmed"),
        fixture(locale, "claude-managed", "outcome-unknown", "Claude process cleanup unconfirmed"),
        fixture(locale, "claude-managed", "outcome-unknown", "Claude initialize timed out"),
        { ...managed, notice: "uncertain" as const },
      ]) {
        expect(claudeSessionBanner(unconfirmed)).toEqual({
          title: "",
          body: copy.managedUnconfirmed,
        });
        expect(sessionDisplayState(unconfirmed).continuation).not.toBe("idle");
        expect(copy.managedUnconfirmed).not.toContain("Claude process cleanup unconfirmed");
        expect(copy.managedUnconfirmed).not.toBe(copy.connectionUnconfirmed);
      }
      const ended = {
        ...idle,
        live: { ...idle.live!, continuationNotice: "background-ended" as const },
      };
      expect(claudeSessionBanner(ended)).toEqual({
        title: "",
        body: continuation.backgroundEnded,
        notice: "background-ended",
      });
      expect(claudeComposerNotice(claudeSessionBanner(ended))).toBe(true);
      // Stopped after too many turns the CLI started by itself: also a line above the composer.
      const limited = {
        ...idle,
        live: { ...idle.live!, continuationNotice: "background-limit" as const },
      };
      expect(claudeSessionBanner(limited)).toEqual({
        title: "",
        body: continuation.backgroundLimit,
        notice: "background-limit",
      });
      expect(claudeComposerNotice(claudeSessionBanner(limited))).toBe(true);
      // A Project Agent past its automatic turns: the turn its CLI started was stopped.
      const leadLimited = {
        ...idle,
        live: { ...idle.live!, continuationNotice: "lead-turn-limit" as const },
      };
      expect(claudeSessionBanner(leadLimited)).toEqual({
        title: "",
        body: continuation.leadTurnLimit,
        notice: "lead-turn-limit",
      });
      expect(claudeComposerNotice(claudeSessionBanner(leadLimited))).toBe(true);
      const conflict = {
        ...idle,
        live: {
          ...idle.live!,
          continuationNotice: "owner-opened-elsewhere" as const,
          ownershipReason: "owner-opened-elsewhere",
        },
      };
      expect(claudeSessionBanner(conflict)).toEqual({
        title: "",
        body: continuation.ownerOpenedElsewhere,
        notice: "owner-opened-elsewhere",
      });
      expect(sessionDisplayState(conflict)).toMatchObject({
        label: continuation.busy("Claude Code"),
        continuation: "busy",
        tone: "muted",
      });
      const connected = fixture(locale, "claude-follower", "idle");
      connected.live!.executionLocation = "terminal";
      expect(claudeSessionBanner(connected)).toBeNull();
      // The released plugin cannot take messages from here, so the terminal is only followed.
      expect(sessionDisplayState(connected)).toMatchObject({
        label: continuation.terminalConnected,
        continuation: "terminal-watch",
        tone: "muted",
      });
      expect(
        sessionDisplayState({ ...connected, live: { ...connected.live!, terminalSend: true } }),
      ).toMatchObject({
        label: continuation.terminalConnected,
        continuation: "terminal",
        tone: "muted",
      });
      const picker = fixture(locale, "claude-follower", "idle", "claude-model-picker-open");
      Object.assign(picker.live!, {
        executionLocation: "terminal",
        terminalSend: false,
        sendEnabled: false,
      });
      expect(claudeSessionBanner(picker)).toBeNull();
      expect(sessionDisplayState(picker)).toEqual({
        label: continuation.terminalAttached,
        reason: "",
        tone: "muted",
        continuation: "terminal",
      });
      // A terminal that cannot take messages is explained once, in place of the composer.
      for (const reason of [
        "claude-follower-send-unverified",
        "claude-terminal-approval",
        "claude-terminal-question",
      ])
        expect(
          claudeSessionBanner({ ...connected, live: { ...connected.live!, reason } }),
        ).toBeNull();
      const hostOffline = { ...connected, online: false };
      expect(claudeSessionBanner(hostOffline)).toEqual({
        title: copy.hostDisconnected,
        body: copy.hostDisconnectedInfo,
        connection: true,
      });
      for (const unconfirmed of [
        {
          ...fixture(locale, "claude-follower", "outcome-unknown", "control-outcome-unconfirmed"),
          online: false,
        },
        { ...hostOffline, notice: "uncertain" as const },
      ]) {
        expect(claudeSessionBanner(unconfirmed)).toEqual({
          title: unconfirmed.t.controlUnconfirmed,
          body: copy.connectionUnconfirmed,
        });
        expect(sessionDisplayState(unconfirmed).tone).toBe("warning");
      }
      const gap = fixture(locale, "claude-follower", "unsupported", "claude-bridge-event-gap");
      expect(claudeSessionBanner(gap)).toEqual({ title: copy.connected, body: copy.gap });
      for (const status of ["idle", "unsupported"]) {
        const lost = fixture(locale, "claude-follower", status, "claude-bridge-disconnected");
        expect(claudeSessionBanner(lost)).toEqual({
          title: copy.lostTitle,
          body: copy.lost,
          connection: true,
        });
        expect(sessionDisplayState(lost).label).toBe(continuation.viewOnly);
      }
      expect(claudeConnectionReason(locale, "platform-unsupported")).toBe(copy.platformUnsupported);
      expect(claudeConnectionReason(locale, "claude-bridge-unavailable")).toBe(
        copy.bridgeUnavailable,
      );
    },
  );
  it("uses 對話 consistently in traditional Chinese connection copy", () => {
    expect(Object.values(claudeConnectionCopy["zh-Hant"]).join(" ")).not.toContain("會話");
  });
  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "says what runs in the background of a managed session in %s",
    (locale) => {
      const continuation = sessionContinuationCopy(locale);
      const session = (live: Record<string, unknown>) => {
        const value = fixture(locale, "claude-managed", "idle");
        Object.assign(value.live!, live);
        return value;
      };
      expect(claudeBackgroundStatus(session({}))).toBeNull();
      expect(claudeBackgroundStatus(session({ backgroundTasks: [] }))).toBeNull();
      const one = {
        kind: "command",
        description: "Run the tests",
        startedAt: "2026-11-13T09:00:00.000Z",
      };
      expect(claudeBackgroundStatus(session({ backgroundTasks: [one] }))).toBe(
        continuation.backgroundRunning(1, "Run the tests"),
      );
      expect(continuation.backgroundRunning(1, "Run the tests")).toContain("Run the tests");
      expect(
        claudeBackgroundStatus(
          session({ backgroundTasks: [one, { ...one, kind: "agent", description: null }] }),
        ),
      ).toBe(continuation.backgroundRunning(2, "Run the tests"));
      expect(continuation.backgroundRunning(2, "Run the tests")).toContain("2");
      // While the CLI continues by itself, that is what the line says.
      for (const status of ["running", "waiting-approval"])
        expect(
          claudeBackgroundStatus(session({ status, turnOrigin: "self", backgroundTasks: [one] })),
        ).toBe(continuation.backgroundTurn);
      expect(
        claudeBackgroundStatus(
          session({ status: "running", turnOrigin: "host", backgroundTasks: [] }),
        ),
      ).toBeNull();
      // Only a process AgentKib runs reports background tasks.
      const follower = fixture(locale, "claude-follower", "idle");
      Object.assign(follower.live!, { backgroundTasks: [one] });
      expect(claudeBackgroundStatus(follower)).toBeNull();
    },
  );
});
