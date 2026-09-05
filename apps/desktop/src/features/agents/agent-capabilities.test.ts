import { describe, expect, it } from "vitest";
import { agentSupportsInsights, insightsAgentKinds } from "@/features/insights/insights";
import { sessionHandoffTargets } from "@/features/workspace/session-handoff-targets";

describe("Agent capability boundaries", () => {
  it.each(["grok-build", "opencode"] as const)(
    "does not expose unsupported Insights for %s",
    (agent) => {
      expect(insightsAgentKinds).not.toContain(agent);
      expect(agentSupportsInsights(agent)).toBe(false);
    },
  );

  it("exposes every supported continuation target", () => {
    for (const agent of ["opencode", "grok-build"] as const) {
      expect(sessionHandoffTargets.map(([target]) => target)).toContain(agent);
    }
  });

  it("keeps supported Insights providers enabled", () => {
    for (const agent of insightsAgentKinds) {
      expect(agentSupportsInsights(agent)).toBe(true);
    }
  });
});
