import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  canConfirmClaudeHandoff as webCanConfirm,
  claudeHandoffBlockReason as webBlockReason,
  type ClaudeHandoffBlockReason,
} from "../conversation/features/sessions/claude-handoff";
import { managedControlCopy as webCopy } from "../conversation/features/sessions/managed-control-copy";

type Fixture = {
  selected: string;
  current?: { id: string; agent: string };
  live?: {
    sessionId: string;
    executionMode?: string;
    reason?: string;
    status?: string;
    activity?: string;
    approvals?: unknown[];
    questions?: unknown[];
  };
  capabilities?: {
    sessionId: string;
    reason?: string;
    features: { adopt?: { available: boolean } };
  };
  access?: {
    status: string;
    protocolVersion: number;
    experimentalEnabled: boolean;
    device?: { manage: boolean; send: boolean };
  };
  online: boolean;
  controlReady: boolean;
  busy: boolean;
  notice?: string;
};
const fixture = (): Fixture => ({
  selected: "session",
  current: { id: "session", agent: "claude-code" },
  live: { sessionId: "session", reason: "handoff-required", status: "idle" },
  capabilities: { sessionId: "session", features: { adopt: { available: true } } },
  access: {
    status: "approved",
    protocolVersion: 2,
    experimentalEnabled: true,
    device: { manage: true, send: true },
  },
  online: true,
  controlReady: true,
  busy: false,
});

const blockedCases: [string, ClaudeHandoffBlockReason, (session: Fixture) => void][] = [
  [
    "no selection",
    "session",
    (s) => {
      s.selected = "";
    },
  ],
  [
    "no current session",
    "session",
    (s) => {
      s.current = undefined;
    },
  ],
  [
    "different current session",
    "session",
    (s) => {
      s.current!.id = "other";
    },
  ],
  [
    "another Agent",
    "session",
    (s) => {
      s.current!.agent = "codex";
    },
  ],
  [
    "missing live state",
    "session",
    (s) => {
      s.live = undefined;
    },
  ],
  [
    "stale live state",
    "session",
    (s) => {
      s.live!.sessionId = "other";
    },
  ],
  [
    "missing capabilities",
    "session",
    (s) => {
      s.capabilities = undefined;
    },
  ],
  [
    "stale capabilities",
    "session",
    (s) => {
      s.capabilities!.sessionId = "other";
    },
  ],
  [
    "missing adoption capability",
    "capability",
    (s) => {
      s.capabilities!.features.adopt = undefined;
    },
  ],
  [
    "unavailable adoption",
    "capability",
    (s) => {
      s.capabilities!.features.adopt!.available = false;
    },
  ],
  [
    "another capability reason",
    "capability",
    (s) => {
      s.capabilities!.reason = "unsupported";
    },
  ],
  [
    "not awaiting handoff",
    "ownership",
    (s) => {
      s.live!.reason = "control-outcome-unconfirmed";
    },
  ],
  [
    "original terminal connection with stale handoff capabilities",
    "ownership",
    (s) => {
      s.live!.executionMode = "claude-follower";
    },
  ],
  [
    "active turn",
    "turn",
    (s) => {
      s.live!.status = "running";
    },
  ],
  [
    "unknown turn status",
    "turn",
    (s) => {
      s.live!.status = undefined;
    },
  ],
  [
    "context compaction",
    "compacting",
    (s) => {
      s.live!.activity = "compacting";
    },
  ],
  [
    "pending approvals",
    "approvals",
    (s) => {
      s.live!.approvals = [{}];
    },
  ],
  [
    "pending questions",
    "questions",
    (s) => {
      s.live!.questions = [{}];
    },
  ],
  [
    "missing access",
    "access",
    (s) => {
      s.access = undefined;
    },
  ],
  [
    "unapproved access",
    "access",
    (s) => {
      s.access!.status = "pending";
    },
  ],
  [
    "unsupported protocol",
    "protocol",
    (s) => {
      s.access!.protocolVersion = 1;
    },
  ],
  [
    "disabled experimental controls",
    "experimental",
    (s) => {
      s.access!.experimentalEnabled = false;
    },
  ],
  [
    "missing device",
    "management",
    (s) => {
      s.access!.device = undefined;
    },
  ],
  [
    "no management permission",
    "management",
    (s) => {
      s.access!.device!.manage = false;
    },
  ],
  [
    "no send permission",
    "send",
    (s) => {
      s.access!.device!.send = false;
    },
  ],
  [
    "offline host",
    "offline",
    (s) => {
      s.online = false;
    },
  ],
  [
    "unsynchronized controls",
    "synchronizing",
    (s) => {
      s.controlReady = false;
    },
  ],
  [
    "session operation in progress",
    "sessionBusy",
    (s) => {
      s.busy = true;
    },
  ],
  [
    "unknown previous outcome",
    "uncertain",
    (s) => {
      s.notice = "uncertain";
    },
  ],
];

describe("Claude handoff eligibility", () => {
  it.each(blockedCases)(
    "keeps %s blocked with a corresponding explanation",
    (_label, reason, mutate) => {
      const state = fixture();
      mutate(state);
      // Fixtures include only the fields consumed by the gate.
      const session = state as unknown as Parameters<typeof webCanConfirm>[0];
      expect(webCanConfirm(session)).toBe(false);
      expect(webBlockReason(session)).toBe(reason);
    },
  );
  it.each([
    ["idle", undefined],
    ["released", undefined],
    ["idle", "handoff-required"],
    ["released", "handoff-required"],
  ])("allows %s sessions with capability reason %s", (status, reason) => {
    const state = fixture();
    state.live!.status = status;
    state.live!.approvals = [];
    state.live!.questions = [];
    state.capabilities!.reason = reason;
    const session = state as unknown as Parameters<typeof webCanConfirm>[0];
    expect(webCanConfirm(session)).toBe(true);
    expect(webBlockReason(session)).toBeUndefined();
  });
});

it("keeps all localized management explanations aligned between Desktop and Web", () => {
  const webRoot = resolve(process.cwd(), "src/features/conversation/features/sessions");
  const desktopRoot = resolve(
    process.cwd(),
    "../desktop/src/features/sessions/conversation/features/sessions",
  );
  expect(readFileSync(resolve(desktopRoot, "claude-handoff.ts"), "utf8")).toBe(
    readFileSync(resolve(webRoot, "claude-handoff.ts"), "utf8"),
  );
  // Locale imports differ by host; the actual four-language feedback stays identical.
  expect(
    readFileSync(resolve(desktopRoot, "managed-control-copy.ts"), "utf8")
      .split("\n")
      .slice(1)
      .join("\n"),
  ).toBe(
    readFileSync(resolve(webRoot, "managed-control-copy.ts"), "utf8")
      .split("\n")
      .slice(1)
      .join("\n"),
  );
  for (const copy of Object.values(webCopy)) {
    expect(Object.keys(copy).sort()).toEqual(Object.keys(webCopy["en-US"]).sort());
    expect(Object.values(copy).every((text) => text.trim().length > 0)).toBe(true);
  }
  for (const key of Object.keys(webCopy["en-US"]) as (keyof (typeof webCopy)["en-US"])[]) {
    expect(webCopy["zh-Hant"][key]).not.toBe(webCopy["zh-CN"][key]);
    expect(webCopy["ja-JP"][key]).not.toBe(webCopy["zh-CN"][key]);
  }
});
