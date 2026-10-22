// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  CLAUDE_BRIDGE_COMPATIBILITY,
  CLAUDE_BRIDGE_REQUIRED_CAPABILITIES,
  claudeBridgeCompatibility,
  missingClaudeBridgeCapabilities,
} from "@agentkib/runtime-protocol";

describe("Claude terminal compatibility policy", () => {
  it.each([
    ["2.1.301", "verified"],
    ["2.1.300", "too-old"],
    ["2.1.30", "too-old"],
    ["1.99.999", "too-old"],
    ["2.0.999", "too-old"],
    ["2.1.307", "unverified"],
    ["2.2.0", "unverified"],
    ["3.0.0", "unverified"],
    ["2.1.301-beta.1", "invalid"],
    ["2.1.301+build", "invalid"],
    ["02.1.301", "invalid"],
    ["2.1.9999999", "invalid"],
    ["2.1.301 (Claude Code)", "invalid"],
    [undefined, "invalid"],
    [{ version: "2.1.301" }, "invalid"],
  ])("classifies %j without coercion", (version, expected) => {
    const classification =
      expected === "unverified" &&
      typeof version === "string" &&
      CLAUDE_BRIDGE_COMPATIBILITY.verifiedCliVersions.includes(version)
        ? "verified"
        : expected;
    expect(claudeBridgeCompatibility(version)).toBe(classification);
  });
  it("uses the verified list as data and requires the complete capability contract", () => {
    for (const version of CLAUDE_BRIDGE_COMPATIBILITY.verifiedCliVersions)
      expect(claudeBridgeCompatibility(version)).toBe("verified");
    expect(
      missingClaudeBridgeCapabilities({
        version: 1,
        available: [...CLAUDE_BRIDGE_REQUIRED_CAPABILITIES],
      }),
    ).toEqual([]);
    for (const missing of CLAUDE_BRIDGE_REQUIRED_CAPABILITIES)
      expect(
        missingClaudeBridgeCapabilities({
          version: 1,
          available: CLAUDE_BRIDGE_REQUIRED_CAPABILITIES.filter((name) => name !== missing),
        }),
      ).toEqual([missing]);
    for (const report of [
      undefined,
      {},
      { version: 2, available: [...CLAUDE_BRIDGE_REQUIRED_CAPABILITIES] },
      { version: 1, available: "all" },
    ])
      expect(missingClaudeBridgeCapabilities(report)).toEqual(CLAUDE_BRIDGE_REQUIRED_CAPABILITIES);
  });
});
