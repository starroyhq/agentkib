import { describe, expect, it } from "vitest";
import type { AgentInstallation } from "@/core/types";
import { agentSupport, canContinueFromHistory, sourceCapabilityReason } from "./agent-capabilities";
import { agentSupportsInsights, insightsAgentKinds } from "@/features/insights/insights";
import { sessionHandoffTargets } from "@/features/workspace/session-handoff-targets";

describe("Agent capability boundaries", () => {
  it("says why a DSH session cannot be handed off and passes other reasons through", () => {
    const copy: Record<string, string> = {
      "handoff.sourceReason.dsh-runtime-offline": "DeepSeek Harness is not running.",
    };
    const tr = (key: string) => copy[key] ?? key;
    expect(sourceCapabilityReason(tr, "dsh-runtime-offline")).toBe(
      "DeepSeek Harness is not running.",
    );
    expect(sourceCapabilityReason(tr, "Conversation transcript is no longer available")).toBe(
      "Conversation transcript is no longer available",
    );
    expect(sourceCapabilityReason(tr, undefined)).toBeUndefined();
  });

  it.each(["grok-build", "opencode"] as const)(
    "does not expose unsupported Insights for %s",
    (agent) => {
      expect(insightsAgentKinds).not.toContain(agent);
      expect(agentSupportsInsights(agent)).toBe(false);
    },
  );

  it("exposes every supported continuation target", () => {
    for (const agent of ["antigravity", "opencode", "grok-build"] as const) {
      expect(sessionHandoffTargets.map(([target]) => target)).toContain(agent);
    }
  });

  it("enables only a successful per-session source check", () => {
    expect(canContinueFromHistory({ status: "supported" })).toBe(true);
    for (const status of ["unavailable", "unsupported", "unverified"] as const) {
      expect(canContinueFromHistory({ status })).toBe(false);
    }
    expect(canContinueFromHistory()).toBe(false);
  });

  it("keeps supported Insights providers enabled", () => {
    for (const agent of insightsAgentKinds) {
      expect(agentSupportsInsights(agent)).toBe(true);
    }
  });

  it("does not infer capabilities for installations from an old runtime", () => {
    const installation: AgentInstallation = {
      agent: "antigravity",
      installed: true,
      configured: true,
      warnings: [],
    };

    expect(agentSupport(installation)).toBeUndefined();
  });

  it("exposes the runtime-reported surfaces without rewriting them", () => {
    const installation: AgentInstallation = {
      agent: "antigravity",
      installed: true,
      configured: true,
      warnings: [],
      support: {
        workspace_discovery: true,
        session_list: true,
        history_read: true,
        continuation: false,
        control: "none",
      },
    };

    expect(agentSupport(installation)).toEqual(installation.support);
  });
});
