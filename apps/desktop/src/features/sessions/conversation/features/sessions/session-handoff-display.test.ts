import { sessionContinuationCopy } from "@agentkib/session-ui";
import { describe, expect, it } from "vitest";
import { sessionDisplayState } from "@/features/sessions/conversation/features/sessions/session-display-state";
import type { SessionController } from "@/features/sessions/conversation/features/sessions/use-session-controller";

function fixture(): SessionController {
  return {
    locale: "en-US",
    selected: "session",
    current: {
      id: "session",
      agent: "claude-code",
      availability: "readable",
      origin: "interactive",
    },
    online: true,
    controlReady: true,
    canSend: false,
    busy: false,
    access: {
      status: "approved",
      protocolVersion: 2,
      experimentalEnabled: true,
      device: { id: "device", send: true, manage: true },
    },
    live: {
      sessionId: "session",
      executionMode: "managed-resume",
      status: "idle",
      reason: "handoff-required",
      sendEnabled: false,
      approvals: [],
      questions: [],
    },
    capabilities: {
      sessionId: "session",
      status: "idle",
      executionMode: "managed-resume",
      features: {
        adopt: { available: true },
        resume: { available: false },
        send: { available: false, reason: "handoff-required" },
      },
    },
  } as unknown as SessionController;
}
describe("handoff-aware session presentation", () => {
  it.each(["idle", "released"] as const)(
    "continues an idle or retired %s Claude session without a handoff action",
    (status) => {
      const state = fixture();
      state.live!.status = status;
      state.live!.reason = undefined;
      state.live!.sendEnabled = true;
      state.capabilities!.features.send = { available: true };
      state.canSend = true;
      expect(sessionDisplayState(state)).not.toHaveProperty("nextAction");
      expect(sessionDisplayState(state)).toMatchObject({
        label: "",
        reason: "",
        continuation: "idle",
      });
      expect(state.canSend).toBe(true);
    },
  );
  function codexFixture() {
    const state = fixture();
    state.current!.agent = "codex";
    Object.assign(state.live!, {
      executionMode: "codex-managed",
      reason: undefined,
      ownershipReason: null,
      executionLocation: null,
      sendEnabled: true,
    });
    state.capabilities!.executionMode = "codex-managed";
    state.capabilities!.features.send = { available: true };
    state.canSend = true;
    return state;
  }
  it("keeps an idle Codex session ready without a badge or manual resume", () => {
    const state = codexFixture();
    state.capabilities!.features.resume = { available: true };
    expect(sessionDisplayState(state)).not.toHaveProperty("nextAction");
    expect(sessionDisplayState(state)).toMatchObject({
      label: "",
      reason: "",
      continuation: "idle",
    });
  });
  it("keeps settings-only receipt verification out of the connection display", () => {
    const state = codexFixture();
    state.controlReady = false;
    state.canSend = false;
    state.settingsNotice = { group: "permissions", status: "uncertain" };
    expect(sessionDisplayState(state)).toEqual({
      label: "",
      reason: "",
      tone: "muted",
      continuation: "idle",
    });
    state.capabilities!.sessionId = "previous";
    expect(sessionDisplayState(state)).toMatchObject({ label: "Verifying state", loading: true });
    state.capabilities!.sessionId = state.selected;
    state.notice = "uncertain";
    expect(sessionDisplayState(state)).toMatchObject({
      label: "Result unconfirmed",
      tone: "warning",
    });
    state.notice = undefined;
    state.live!.status = "outcome-unknown";
    expect(sessionDisplayState(state)).toMatchObject({
      label: "Result unconfirmed",
      tone: "warning",
    });
  });
  it("does not require management permission to send to an automatically continued Codex session", () => {
    const state = codexFixture();
    state.access!.device!.manage = false;
    expect(sessionDisplayState(state)).not.toHaveProperty("nextAction");
    expect(sessionDisplayState(state).continuation).toBe("idle");
  });
  it("identifies the external Codex owner without a handoff action or warning color", () => {
    const state = codexFixture();
    state.canSend = false;
    Object.assign(state.live!, {
      sendEnabled: false,
      executionLocation: "external",
      ownershipReason: "codex-owner-busy",
      reason: "codex-owner-busy",
    });
    expect(sessionDisplayState(state)).not.toHaveProperty("nextAction");
    expect(sessionDisplayState(state)).toMatchObject({
      label: "In use in Codex",
      continuation: "busy",
      tone: "muted",
    });
  });
  it("clears the old occupancy while the same session's capabilities refresh", () => {
    const state = codexFixture();
    state.capabilities!.features.send = { available: false, reason: "codex-owner-busy" };
    expect(sessionDisplayState(state)).toMatchObject({
      continuation: "idle",
      label: "",
      reason: "",
    });

    state.canSend = false;
    state.live!.sendEnabled = false;
    expect(sessionDisplayState(state)).not.toMatchObject({ reason: "In use in Codex" });

    Object.assign(state.live!, {
      executionMode: "codex-follower",
      executionLocation: "external",
    });
    // A setting staged in AgentKib can still prevent sending through the connected owner.
    expect(sessionDisplayState(state)).toMatchObject({
      label: "Running in Codex · Connected",
      continuation: "codex",
    });
    expect(state.live!.sendEnabled).toBe(false);
  });
  it("shows the archive reason even when the original Codex writer still holds the thread", () => {
    const state = codexFixture();
    state.canSend = false;
    Object.assign(state.live!, {
      status: "archived",
      sendEnabled: false,
      ownershipReason: "codex-owner-busy",
      reason: "session-archived",
    });
    expect(sessionDisplayState(state)).toMatchObject({
      continuation: "view-only",
      reason: "This session is archived. Unarchive it first.",
    });
  });
  it("lets a message go to the Codex app that holds the session with no window on it", () => {
    const state = codexFixture();
    Object.assign(state.live!, {
      sendEnabled: true,
      executionLocation: "external",
      ownershipReason: "codex-owner-busy",
      reason: "codex-owner-busy",
      ownerHandoff: true,
    });
    expect(sessionDisplayState(state)).toMatchObject({
      label: "Open in Codex · Connects when you send",
      reason: "",
      tone: "muted",
      continuation: "codex",
    });
    // Without sending open, the session is simply in use.
    Object.assign(state.live!, { sendEnabled: false });
    expect(sessionDisplayState(state)).toMatchObject({ continuation: "busy" });
  });
  it("labels a followed Codex session as connected without a starting hint", () => {
    const state = codexFixture();
    Object.assign(state.live!, {
      executionMode: "codex-follower",
      executionLocation: "external",
      ownershipReason: null,
      reason: undefined,
      sendEnabled: true,
    });
    expect(sessionDisplayState(state)).toMatchObject({
      label: "Running in Codex · Connected",
      reason: "",
      tone: "muted",
      continuation: "codex",
    });
    state.pendingSend = {
      sessionId: "session",
      text: "draft",
    } as SessionController["pendingSend"];
    expect(sessionDisplayState(state)).toMatchObject({
      label: "Running in Codex · Connected",
      continuation: "codex",
    });
  });
  it("returns a retired Codex session to idle without asking for resume confirmation", () => {
    const state = codexFixture();
    state.live!.status = "released";
    expect(sessionDisplayState(state)).not.toHaveProperty("nextAction");
    expect(sessionDisplayState(state)).toMatchObject({ label: "", continuation: "idle" });
  });
  const blocked: [string, (state: SessionController) => void][] = [
    [
      "metadata source",
      (s) => {
        s.current!.availability = "metadata-only";
      },
    ],
    [
      "remote source",
      (s) => {
        Object.assign(s.current!, { remote: { host_id: "remote" } });
      },
    ],
    [
      "auxiliary record",
      (s) => {
        s.current!.origin = "auxiliary";
      },
    ],
    [
      "execution record",
      (s) => {
        s.current!.origin = "execution";
      },
    ],
    [
      "unsupported Agent",
      (s) => {
        s.current!.agent = "cursor";
      },
    ],
    [
      "wrong current identity",
      (s) => {
        s.current!.id = "other";
      },
    ],
    [
      "stale live identity",
      (s) => {
        s.live!.sessionId = "other";
      },
    ],
    [
      "stale capabilities",
      (s) => {
        s.capabilities!.sessionId = "other";
      },
    ],
    [
      "unapproved access",
      (s) => {
        s.access!.status = "pending";
      },
    ],
    [
      "incompatible protocol",
      (s) => {
        s.access!.protocolVersion = 1;
      },
    ],
    [
      "disabled experimental controls",
      (s) => {
        s.access!.experimentalEnabled = false;
      },
    ],
    [
      "no send permission",
      (s) => {
        s.access!.device!.send = false;
      },
    ],
    [
      "no management permission",
      (s) => {
        s.access!.device!.manage = false;
      },
    ],
    [
      "unverified installation",
      (s) => {
        s.capabilities!.reason = "unverified-installation";
      },
    ],
    [
      "unavailable adoption capability",
      (s) => {
        Object.assign(s.capabilities!.features, { adopt: { available: false } });
      },
    ],
    [
      "offline",
      (s) => {
        s.online = false;
      },
    ],
    [
      "control synchronization",
      (s) => {
        s.controlReady = false;
      },
    ],
    [
      "in-flight operation",
      (s) => {
        s.busy = true;
      },
    ],
    [
      "unknown outcome",
      (s) => {
        s.notice = "uncertain";
      },
    ],
    [
      "active turn",
      (s) => {
        s.live!.status = "running";
      },
    ],
    [
      "unsupported status",
      (s) => {
        s.live!.status = "unsupported";
      },
    ],
    [
      "compaction",
      (s) => {
        s.live!.activity = "compacting";
      },
    ],
    [
      "approval",
      (s) => {
        s.live!.approvals = [{ requestId: "approval" }] as NonNullable<
          SessionController["live"]
        >["approvals"];
      },
    ],
    [
      "question",
      (s) => {
        s.live!.questions = [{ requestId: "question" }] as NonNullable<
          SessionController["live"]
        >["questions"];
      },
    ],
  ];
  it.each(blocked)("does not advertise an executable handoff for %s", (_name, mutate) => {
    const state = fixture();
    mutate(state);
    const result = sessionDisplayState(state);
    expect(result).not.toHaveProperty("nextAction");
    expect(result.label).not.toBe("Handoff required");
    expect(result.label).not.toBe("Resume required");
    expect(state.canSend).toBe(false);
  });
  it("identifies stale control evidence as verification, not a permanent view-only source", () => {
    const state = fixture();
    state.capabilities!.sessionId = "previous";
    expect(sessionDisplayState(state)).toMatchObject({ label: "Verifying state", loading: true });
  });
  it("keeps installation verification and unknown outcomes distinct from handoff", () => {
    const state = fixture();
    state.capabilities!.reason = "unverified-installation";
    expect(sessionDisplayState(state)).toMatchObject({ label: "View only" });
    state.controlReady = false;
    expect(sessionDisplayState(state)).toMatchObject({ label: "Verifying state" });
    state.notice = "uncertain";
    expect(sessionDisplayState(state)).toMatchObject({
      label: "Result unconfirmed",
      tone: "warning",
    });
  });
  it.each([
    [
      "Access approval needed",
      (s: SessionController) => {
        s.access!.status = "pending";
      },
    ],
    [
      "Permission required",
      (s: SessionController) => {
        s.access!.device!.send = false;
      },
    ],
    [
      "Control disabled",
      (s: SessionController) => {
        s.access!.experimentalEnabled = false;
      },
    ],
    [
      "Control unavailable",
      (s: SessionController) => {
        s.access!.protocolVersion = 1;
      },
    ],
  ] as const)("explains %s without advertising an operation", (label, mutate) => {
    const state = fixture();
    mutate(state);
    expect(sessionDisplayState(state)).toMatchObject({ label, tone: "muted" });
    expect(sessionDisplayState(state)).not.toHaveProperty("nextAction");
    expect(sessionDisplayState(state).reason.length).toBeGreaterThan(0);
  });
  it("does not claim that a failed native resume capability can be entered without the separate managed capability", () => {
    const state = fixture();
    state.current!.agent = "codex";
    Object.assign(state.capabilities!.features, { adopt: { available: false } });
    expect(sessionDisplayState(state)).not.toHaveProperty("nextAction");
  });
  it("continues to report send readiness only from the existing dispatch decision", () => {
    const state = fixture();
    state.live!.reason = undefined;
    state.canSend = true;
    state.capabilities!.features.send = { available: true };
    expect(sessionDisplayState(state)).toMatchObject({ label: "", continuation: "idle" });
    expect(sessionDisplayState(state)).not.toHaveProperty("nextAction");
  });
  it("uses the same neutral ownership state for both Agents in all four locales", () => {
    for (const locale of ["en-US", "zh-CN", "zh-Hant", "ja-JP"] as const) {
      const state = fixture();
      state.locale = locale;
      for (const [agent, reason, name] of [
        ["claude-code", "claude-owner-busy", "Claude Code"],
        ["codex", "codex-owner-busy", "Codex"],
      ] as const) {
        state.current!.agent = agent;
        state.live!.ownershipReason = reason;
        state.live!.reason = reason;
        expect(sessionDisplayState(state)).toMatchObject({
          label: sessionContinuationCopy(locale).busy(name),
          reason: "",
          tone: "muted",
          continuation: "busy",
        });
      }
    }
  });
  it("does not require management permission for automatic Claude continuation", () => {
    const state = fixture();
    state.access!.device!.manage = false;
    state.live!.reason = undefined;
    state.live!.sendEnabled = true;
    state.canSend = true;
    expect(sessionDisplayState(state)).toMatchObject({ label: "", continuation: "idle" });
  });
});
