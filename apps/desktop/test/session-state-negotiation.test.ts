// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  negotiateSessionState,
  type LiveSessionAgent,
  type SessionStateNegotiation,
} from "@agentkib/runtime-protocol";

const fixtureRoot = new URL("../../../packages/runtime-protocol/test/fixtures/", import.meta.url);
const fixture = JSON.parse(
  readFileSync(new URL("session-state-negotiation.json", fixtureRoot), "utf8"),
) as {
  hosts: Record<string, Parameters<typeof negotiateSessionState>[0]>;
  cases: {
    name: string;
    host: string;
    provider: LiveSessionAgent;
    state?: unknown;
    stateSample?: string;
    expected: SessionStateNegotiation["kind"];
  }[];
};
const samples = JSON.parse(
  readFileSync(new URL("session-state.json", fixtureRoot), "utf8"),
) as Record<string, { live: { state: unknown } }>;

it.each(fixture.cases)("$name", ({ host, provider, state, stateSample, expected }) => {
  const value = stateSample === undefined ? state : samples[stateSample]!.live.state;
  const result = negotiateSessionState(fixture.hosts[host]!, provider, value);
  expect(result).toEqual(expected === "v1" ? { kind: "v1", state: value } : { kind: expected });
});
