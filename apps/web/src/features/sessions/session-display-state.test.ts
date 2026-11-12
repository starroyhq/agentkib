import { sessionContinuationCopy } from "@agentkib/session-ui";
import { describe, expect, it } from "vitest";
import { dictionaries } from "@/features/conversation/i18n";
import { codexReason } from "@/features/conversation/features/sessions/codex-copy";
import { sessionDisplayState } from "@/features/conversation/features/sessions/session-display-state";
import type { SessionController } from "@/features/conversation/features/sessions/use-session-controller";
const state = {
  locale: "zh-CN",
  online: true,
  controlReady: true,
  canSend: true,
  busy: false,
  access: {
    status: "approved",
    protocolVersion: 2,
    experimentalEnabled: true,
    device: { send: true },
  },
  live: { status: "idle", sendEnabled: true, approvals: [] },
} as unknown as SessionController;
describe("session display state", () => {
  it("shows compaction after actionable approvals and never over an unknown outcome", () => {
    const compacting = { ...state, live: { ...state.live!, activity: "compacting" as const } };
    expect(sessionDisplayState(compacting).label).toBe("正在压缩上下文");
    expect(
      sessionDisplayState({
        ...compacting,
        live: { ...compacting.live, reason: "control-outcome-unconfirmed" },
      }).label,
    ).toBe("结果待确认");
    expect(
      sessionDisplayState({
        ...compacting,
        live: { ...compacting.live, status: "waiting-approval" },
      }).label,
    ).toBe("待审批");
  });
  it("only displays ready after the existing dispatch gate accepts", () => {
    expect(sessionDisplayState(state).label).toBe("可发送");
    expect(
      sessionDisplayState({
        ...state,
        canSend: false,
        live: { ...state.live!, sendEnabled: false },
      }).label,
    ).toBe("仅可查看");
  });
  it("never describes SSE alone as controllable", () => {
    expect(
      sessionDisplayState({ ...state, canSend: false, controlReady: false, live: undefined }).label,
    ).toBe("正在检查状态");
    expect(
      sessionDisplayState({
        ...state,
        canSend: false,
        access: { ...state.access!, device: { ...state.access!.device!, send: false } },
      }).label,
    ).toBe("权限不足");
  });
  it("prioritizes unconfirmed results even when the connection drops", () => {
    expect(
      sessionDisplayState({
        ...state,
        online: false,
        live: { ...state.live!, reason: "control-outcome-unconfirmed" },
      }).label,
    ).toBe("结果待确认");
  });
  it("does not present stale approval as currently actionable offline", () => {
    expect(
      sessionDisplayState({
        ...state,
        online: false,
        live: { ...state.live!, status: "waiting-approval" },
      }).label,
    ).toBe("已断线");
  });
  it("explains blocked sending without echoing private errors", () => {
    const result = sessionDisplayState({
      ...state,
      canSend: false,
      live: { ...state.live!, reason: "secret runtime detail" },
    });
    expect(result.reason).not.toContain("secret");
    expect(sessionDisplayState(state).reason).toBe("");
  });
  it.each([
    ["handoff-required", codexReason("zh-CN", "handoff-required").text],
    ["unverified-installation", dictionaries["zh-CN"].unverifiedInstallation],
    ["open-in-original-client", dictionaries["zh-CN"].openOriginalClient],
  ])("explains %s from live state or send capability", (reason, expected) => {
    const unavailable = {
      ...state,
      canSend: false,
      live: { ...state.live!, status: "unsupported" as const, sendEnabled: false },
    };
    expect(
      sessionDisplayState({ ...unavailable, live: { ...unavailable.live, reason } }),
    ).toMatchObject({
      label: reason === "unverified-installation" ? "尚未验证" : "仅可查看",
      reason: expected,
    });
    expect(
      sessionDisplayState({
        ...unavailable,
        capabilities: {
          sessionId: "s",
          executionMode: "codex-follower",
          status: "unsupported",
          features: { send: { available: false, reason } },
        },
      }),
    ).toMatchObject({
      label: reason === "unverified-installation" ? "尚未验证" : "仅可查看",
      reason: expected,
    });
  });
  it("provides localized status for every locale", () => {
    for (const locale of ["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)
      expect(sessionDisplayState({ ...state, locale }).label).toBeTruthy();
  });
});

it("shows a cancelled Claude turn while leaving the idle send eligibility unchanged", () => {
  const value = { ...state, live: { ...state.live!, lastOutcome: "cancelled" as const } };
  expect(sessionDisplayState(value).label).toBe("已取消");
  expect(value.canSend).toBe(true);
  expect(sessionDisplayState({ ...value, online: false }).label).toBe("已断线");
});

it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
  "projects Codex continuation states in %s",
  (locale) => {
    const copy = sessionContinuationCopy(locale);
    const codex = {
      ...state,
      locale,
      selected: "codex",
      current: { id: "codex", agent: "codex", availability: "readable" },
      live: {
        ...state.live!,
        sessionId: "codex",
        executionMode: "codex-managed",
        executionLocation: null,
        ownershipReason: null,
      },
      capabilities: { sessionId: "codex", features: { send: { available: true } } },
    } as SessionController;
    expect(sessionDisplayState(codex)).toMatchObject({
      continuation: "idle",
      label: "",
      reason: "",
    });
    expect(
      sessionDisplayState({ ...codex, pendingSend: { sessionId: "codex", text: "draft" } }),
    ).toMatchObject({ continuation: "starting", label: copy.starting, loading: true });
    expect(
      sessionDisplayState({ ...codex, live: { ...codex.live!, executionLocation: "agentkib" } }),
    ).toMatchObject({ continuation: "running", label: copy.running, tone: "active" });
    expect(
      sessionDisplayState({
        ...codex,
        canSend: false,
        live: {
          ...codex.live!,
          ownershipReason: "codex-owner-busy",
          executionLocation: "external",
        },
      }),
    ).toMatchObject({ continuation: "busy", label: copy.busy("Codex"), tone: "muted" });
    const follower = {
      ...codex,
      live: {
        ...codex.live!,
        executionMode: "codex-follower",
        executionLocation: "external",
      },
    } as SessionController;
    expect(sessionDisplayState(follower)).toMatchObject({
      continuation: "codex",
      label: copy.codexConnected,
      reason: "",
      tone: "muted",
    });
    expect(
      sessionDisplayState({ ...follower, pendingSend: { sessionId: "codex", text: "draft" } }),
    ).toMatchObject({ continuation: "codex", label: copy.codexConnected });
    expect(
      sessionDisplayState({
        ...codex,
        canSend: false,
        live: { ...codex.live!, sendEnabled: false, reason: "codex-cli-version-too-old" },
      }),
    ).toMatchObject({
      continuation: "view-only",
      label: copy.viewOnly,
      reason: copy.codexVersionTooOld,
    });
    expect(
      sessionDisplayState({
        ...codex,
        live: { ...codex.live!, sessionId: "old", ownershipReason: "codex-owner-busy" },
      }),
    ).toMatchObject({ loading: true });
    expect(
      sessionDisplayState({
        ...codex,
        notice: "uncertain",
        live: { ...codex.live!, ownershipReason: "codex-owner-busy" },
      }).continuation,
    ).toBeUndefined();
  },
);

it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
  "projects Claude continuation without weakening dispatch in %s",
  (locale) => {
    const copy = sessionContinuationCopy(locale);
    const claude = {
      ...state,
      locale,
      selected: "claude",
      current: { id: "claude", agent: "claude-code", availability: "readable" },
      live: {
        ...state.live!,
        sessionId: "claude",
        executionMode: "claude-managed",
        executionLocation: null,
        ownershipReason: null,
      },
      capabilities: { sessionId: "claude", features: { send: { available: true } } },
    } as SessionController;
    expect(sessionDisplayState(claude)).toMatchObject({ continuation: "idle", label: "" });
    expect(
      sessionDisplayState({ ...claude, pendingSend: { sessionId: "claude", text: "draft" } }),
    ).toMatchObject({ continuation: "starting", label: copy.starting, loading: true });
    expect(
      sessionDisplayState({ ...claude, live: { ...claude.live!, executionLocation: "agentkib" } }),
    ).toMatchObject({ continuation: "running", label: copy.running, tone: "active" });
    expect(
      sessionDisplayState({
        ...claude,
        live: {
          ...claude.live!,
          executionLocation: "terminal",
          executionMode: "claude-follower",
          sendEnabled: false,
          terminalSend: true,
          reason: "claude-terminal-approval",
        },
        canSend: false,
      }),
    ).toMatchObject({ continuation: "terminal", label: copy.terminalConnected, tone: "muted" });
    // The production plugin cannot take messages yet: follow the terminal, never offer an input.
    expect(
      sessionDisplayState({
        ...claude,
        live: {
          ...claude.live!,
          executionLocation: "terminal",
          executionMode: "claude-follower",
          sendEnabled: false,
          terminalSend: false,
          reason: "claude-follower-send-unverified",
        },
        canSend: false,
      }),
    ).toMatchObject({
      continuation: "terminal-watch",
      label: copy.terminalConnected,
      reason: "",
      tone: "muted",
    });
    for (const ownershipReason of [
      "claude-owner-busy",
      "claude-background-session-running",
      "owner-opened-elsewhere",
    ])
      expect(
        sessionDisplayState({
          ...claude,
          canSend: false,
          live: { ...claude.live!, ownershipReason },
        }),
      ).toMatchObject({
        continuation: "busy",
        label: copy.busy("Claude Code"),
        reason: "",
        tone: "muted",
      });
    expect(
      sessionDisplayState({
        ...claude,
        canSend: false,
        live: { ...claude.live!, sendEnabled: false, reason: "platform-unsupported" },
      }),
    ).toMatchObject({ continuation: "view-only", reason: copy.claudeWindowsUnsupported });
    expect(
      sessionDisplayState({
        ...claude,
        live: { ...claude.live!, sessionId: "old", executionLocation: "terminal" },
      }),
    ).toMatchObject({ loading: true });
    expect(
      sessionDisplayState({
        ...claude,
        live: { ...claude.live!, status: "outcome-unknown", executionLocation: "agentkib" },
      }).continuation,
    ).toBeUndefined();
    for (const executionLocation of ["terminal", "agentkib"] as const)
      expect(
        sessionDisplayState({
          ...claude,
          pendingSend: { sessionId: "claude", text: "next" },
          live: { ...claude.live!, executionLocation },
        }).continuation,
      ).toBe(executionLocation === "terminal" ? "terminal" : "running");
    expect(claude.canSend).toBe(true);
  },
);

it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
  "projects a DeepSeek Harness that AgentKib starts as ready, not view-only, in %s",
  (locale) => {
    const copy = sessionContinuationCopy(locale);
    const dsh = {
      ...state,
      locale,
      selected: "dsh",
      current: { id: "dsh", agent: "deepseek-harness", availability: "readable" },
      live: {
        ...state.live!,
        sessionId: "dsh",
        executionMode: "dsh-follower",
        executionLocation: null,
        ownershipReason: null,
      },
      capabilities: { sessionId: "dsh", features: { send: { available: true } } },
    } as SessionController;
    // No DSH runs yet: the next message starts one in the background.
    expect(sessionDisplayState(dsh)).toMatchObject({ continuation: "idle", label: "" });
    expect(
      sessionDisplayState({ ...dsh, pendingSend: { sessionId: "dsh", text: "draft" } }),
    ).toMatchObject({ continuation: "starting", label: copy.starting, loading: true });
    const background = {
      ...dsh,
      live: { ...dsh.live!, executionLocation: "agentkib" },
    } as SessionController;
    expect(sessionDisplayState(background)).toMatchObject({ continuation: "idle", label: "" });
    expect(
      sessionDisplayState({
        ...background,
        canSend: false,
        pendingSend: { sessionId: "dsh", text: "next" },
        live: { ...background.live!, status: "running", sendEnabled: false },
      }),
    ).toMatchObject({ continuation: "running", label: copy.running, tone: "active" });
    expect(
      sessionDisplayState({
        ...background,
        canSend: false,
        live: { ...background.live!, sendEnabled: false, questions: [{ id: "q" }] },
      } as unknown as SessionController).tone,
    ).toBe("warning");
    // Starting is off and no DSH runs: view only, with the reason.
    expect(
      sessionDisplayState({
        ...dsh,
        canSend: false,
        live: {
          ...dsh.live!,
          status: "unsupported",
          sendEnabled: false,
          reason: "dsh-runtime-offline",
        },
      } as unknown as SessionController),
    ).toMatchObject({
      continuation: "view-only",
      label: copy.viewOnly,
      reason: codexReason(locale, "dsh-runtime-offline").text,
    });
    // The person's own DSH, with the plugin, is followed as before.
    expect(
      sessionDisplayState({ ...dsh, live: { ...dsh.live!, executionLocation: "external" } }),
    ).toMatchObject({ continuation: "dsh", label: copy.dshConnected });
  },
);
