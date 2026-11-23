// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { sessionProviderCapabilities, type SessionCapabilities } from "@agentkib/web-client";
import {
  composerLocalSlashOptions,
  sessionComposerCapabilities,
  useNewSessionGoalDraft,
} from "@agentkib/session-ui";

afterEach(cleanup);

describe("composer draft capabilities", () => {
  it.each(["codex", "claude-code", "deepseek-harness", "devin"] as const)(
    "retains %s slots across execution modes without retaining write grants",
    (agent) => {
      const provider = sessionProviderCapabilities(agent)!;
      const modes = {
        codex: ["codex-managed", "codex-follower"],
        "claude-code": ["claude-managed", "claude-follower"],
        "deepseek-harness": ["dsh-follower"],
        devin: ["devin-print"],
      } as const;
      for (const executionMode of modes[agent]) {
        const value = sessionComposerCapabilities({
          sessionId: "source",
          provider,
          slotsGranted: true,
          legacyReads: false,
          attachmentsGranted: true,
          capabilities: {
            sessionId: "source",
            executionMode,
            features: {
              "settings-state": { available: false, reason: "unsupported" },
              settings: { available: false, reason: "unsupported" },
            },
          } as SessionCapabilities,
        });
        expect(value).toMatchObject({
          reservesModelSlot: provider.composer!.modelPicker,
          reservesPermissionSlot: provider.composer!.permissionPicker,
          resourcesOffered: provider.composer!.workspaceResources,
          attachmentOffered: provider.composer!.attachments,
          planOffered: provider.composer!.plan,
          goalOffered: provider.composer!.goal,
          settingsReadable: false,
          settingsWritable: false,
          resourcesReadable: false,
          attachmentAllowed: false,
          goalDraftOffered: false,
        });
      }
    },
  );

  it("keeps registry slots separate from device grants and refuses known denied reads", () => {
    const provider = sessionProviderCapabilities("claude-code")!;
    const input = {
      sessionId: "source",
      provider,
      legacyReads: true,
      attachmentsGranted: true,
    };
    expect(sessionComposerCapabilities(input).reservesModelSlot).toBe(false);
    const denied = sessionComposerCapabilities({
      ...input,
      slotsGranted: true,
      capabilities: {
        sessionId: "source",
        features: { "settings-state": { available: false, reason: "permission_denied" } },
      } as SessionCapabilities,
    });
    expect(denied).toMatchObject({
      settingsAccessDenied: true,
      reservesModelSlot: false,
      reservesPermissionSlot: false,
      settingsReadable: false,
      settingsWritable: false,
      resourcesReadable: false,
      attachmentAllowed: false,
    });
    for (const agent of ["gemini-cli", "unknown-reader"]) {
      expect(sessionProviderCapabilities(agent)).toBeUndefined();
    }
  });

  const capabilities = {
    sessionId: "source",
    status: "idle",
    executionMode: "claude-managed",
    features: {
      "settings-state": { available: true },
      settings: { available: true },
      attachments: { available: true },
      resources: { available: true },
      "goal-draft": { available: true },
      send: { available: false, reason: "claude-owner-busy" },
    },
  } as const;
  const read = (sessionId: string, attachmentsGranted = true) =>
    sessionComposerCapabilities({
      capabilities,
      sessionId,
      legacyReads: false,
      attachmentsGranted,
    });

  it("prepares authorized drafts while sending remains unavailable", () => {
    expect(read("source")).toMatchObject({
      settingsReadable: true,
      settingsWritable: true,
      attachmentAllowed: true,
      resourcesReadable: true,
      goalDraftOffered: true,
    });
    expect(read("source").feature("send")?.available).toBe(false);
    expect(read("source", false).attachmentAllowed).toBe(false);
  });

  it("never reuses another conversation's capabilities", () => {
    expect(read("destination")).toMatchObject({
      settingsReadable: false,
      settingsWritable: false,
      attachmentAllowed: false,
      resourcesReadable: false,
      goalDraftOffered: false,
    });
    expect(read("destination").feature("settings")).toBeUndefined();
  });

  it("merges granted local controls without inventing native commands", () => {
    const reported = ["project-skill", "model"].map((name) => ({ name, aliases: [] }));
    expect(
      composerLocalSlashOptions(reported, { model: true, effort: true, goal: false }, "en-US").map(
        ({ name }) => name,
      ),
    ).toEqual(["project-skill", "model", "effort"]);
    expect(
      composerLocalSlashOptions(reported, { model: false, effort: false, goal: true }, "en-US").map(
        ({ name }) => name,
      ),
    ).toEqual(["project-skill", "goal"]);
  });

  it("keeps local goals and late completion callbacks within their host authority", () => {
    const first = {};
    const second = {};
    const view = renderHook(({ authority }) => useNewSessionGoalDraft("same-session", authority), {
      initialProps: { authority: first },
    });
    act(() => view.result.current.stage({ objective: "Host A" }));
    const oldStage = view.result.current.stage;
    const oldConfirmation = view.result.current.confirmFirstMessage;
    view.rerender({ authority: second });
    expect(view.result.current.value).toBeUndefined();
    act(() => view.result.current.stage({ objective: "Host B" }));
    act(() => oldConfirmation(1));
    act(() => oldStage({ objective: "Late Host A" }));
    expect(view.result.current.value).toMatchObject({
      value: { objective: "Host B" },
      apply: false,
    });
  });
});
