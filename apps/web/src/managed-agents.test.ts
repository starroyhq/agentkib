import { describe, expect, expectTypeOf, it } from "vitest";
import {
  isLiveSessionAgent,
  LIVE_SESSION_AGENTS,
  MANAGED_AGENTS,
  managedAgentOf,
  type ManagedAgent,
} from "@agentkib/web-client";
import { NEW_SESSION_AGENTS, type NewSessionAgent } from "@agentkib/session-ui";

describe("managed Agent registry", () => {
  it("is the list a new session can start from", () => {
    // session-ui keeps its own list because it depends on no other package; it must not drift.
    expect([...NEW_SESSION_AGENTS].sort()).toEqual([...MANAGED_AGENTS].sort());
    expectTypeOf<NewSessionAgent>().toEqualTypeOf<ManagedAgent>();
  });

  it("names the managed Agent of a value, and nothing else", () => {
    for (const agent of MANAGED_AGENTS) expect(managedAgentOf(agent)).toBe(agent);
    expect(managedAgentOf("antigravity")).toBeNull();
    expect(managedAgentOf(undefined)).toBeNull();
    expect(managedAgentOf(42)).toBeNull();
  });

  it("opens managed sessions and Antigravity live", () => {
    for (const agent of MANAGED_AGENTS) expect(isLiveSessionAgent(agent)).toBe(true);
    expect(LIVE_SESSION_AGENTS).toContain("antigravity");
    expect(isLiveSessionAgent("antigravity")).toBe(true);
    expect(isLiveSessionAgent("cursor")).toBe(false);
    expect(isLiveSessionAgent(null)).toBe(false);
  });
});
