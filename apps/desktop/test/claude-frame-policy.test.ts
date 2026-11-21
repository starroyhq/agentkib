import { describe, expect, it } from "vitest";
import {
  boundedUnknownFields,
  ClaudeProtocolDiagnostics,
  ClaudeProtocolError,
  ClaudeTurnFailure,
  controlDeny,
  controlError,
  formatTermination,
  frameOrigin,
  terminationCodeOf,
} from "../../../packages/backend/src/agents/claude/claude-frame-policy";
import {
  CLAUDE_MANAGED_VERIFIED_THROUGH,
  isNewerThanVerified,
} from "../../../packages/backend/src/agents/claude/claude-version";

// Pure functions of the frame policy. Nothing here starts a process or reads a configuration.

describe("frameOrigin", () => {
  it.each<[string, Record<string, unknown>]>([
    ["a missing field", {}],
    ["null", { parent_tool_use_id: null }],
    ["undefined", { parent_tool_use_id: undefined }],
  ])("treats %s as the main thread", (_label, frame) => {
    expect(frameOrigin(frame)).toEqual({ kind: "main" });
  });

  it("reads a bounded non-empty string as the spawning Agent call of a sub-agent", () => {
    expect(frameOrigin({ parent_tool_use_id: "toolu_1" })).toEqual({
      kind: "subagent",
      spawner: "toolu_1",
    });
    expect(frameOrigin({ parent_tool_use_id: "p".repeat(256) }).kind).toBe("subagent");
  });

  it.each<[string, unknown]>([
    ["a number", 7],
    ["zero", 0],
    ["false", false],
    ["an object", {}],
    ["an array", ["toolu_1"]],
    ["an empty string", ""],
    ["a 257-byte string", "p".repeat(257)],
    ["a string over 256 bytes in UTF-8", "界".repeat(100)],
  ])("never mistakes %s for the main thread or a sub-agent", (_label, parent) => {
    expect(frameOrigin({ parent_tool_use_id: parent })).toEqual({ kind: "unattributed" });
  });
});

describe("termination reasons", () => {
  it("builds `<code>: <detail>` with a cleaned and bounded detail", () => {
    expect(formatTermination("claude-background-task", "plain")).toBe(
      "claude-background-task: plain",
    );
    const formatted = formatTermination(
      "claude-protocol-violation",
      `a\u0000b\u001b[31m${"x".repeat(500)}`,
    );
    expect(formatted.startsWith("claude-protocol-violation: ab[31m")).toBe(true);
    // The code and separator plus at most 200 characters of detail.
    expect(formatted.length).toBe("claude-protocol-violation: ".length + 200);
    // eslint-disable-next-line no-control-regex
    expect(formatted).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("names the version only when it is newer than the verified one", () => {
    expect(
      formatTermination("claude-unrequested-turn", "late result", {
        version: "2.1.300",
        verified: CLAUDE_MANAGED_VERIFIED_THROUGH,
      }),
    ).toBe(
      "claude-unrequested-turn: late result (Claude Code 2.1.300, newer than the 2.1.299 AgentKib verified)",
    );
  });

  it.each([
    ["claude-background-task", "claude-background-task"],
    ["claude-unrequested-turn: Claude result outside an active turn", "claude-unrequested-turn"],
    ["claude-protocol-violation: x", "claude-protocol-violation"],
    ["control-outcome-unconfirmed", null],
    ["claude-background-tasks: x", null],
    ["Claude process exited (1)", null],
    ["", null],
    [undefined, null],
    [7, null],
  ])("reads the code of %j", (reason, code) => {
    expect(terminationCodeOf(reason)).toBe(code);
  });

  it("keeps the classes apart: a turn failure carries no code", () => {
    expect(new ClaudeTurnFailure("Claude turn failed: x")).not.toBeInstanceOf(ClaudeProtocolError);
    const error = new ClaudeProtocolError("claude-background-task", "text");
    expect(error.code).toBe("claude-background-task");
    expect(error.message).toBe("text");
  });
});

describe("answers to the CLI", () => {
  it("refuses with an error that can never read as an approval", () => {
    const answer = controlError("req-1");
    expect(answer).toEqual({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: "req-1",
        error: "This request is not supported by AgentKib managed sessions.",
      },
    });
    expect(JSON.stringify(answer)).not.toMatch(/allow/i);
  });

  it("denies with an explanation the model can pass on", () => {
    const answer = controlDeny("req-2");
    expect(answer.response).toMatchObject({
      subtype: "success",
      request_id: "req-2",
      response: { behavior: "deny" },
    });
    expect(JSON.stringify(answer)).not.toContain('"allow"');
    expect(answer.response.response.message).toContain("Claude Code terminal");
  });
});

describe("boundedUnknownFields", () => {
  const known = new Set(["tool_name", "input"]);
  const reserved = new Set(["blockedPath"]);

  it("keeps plain identifiers, stringifies other values, and leaves known keys out", () => {
    const result = boundedUnknownFields(
      { tool_name: "x", input: {}, mcp_server: { name: "docs" }, label: "text", count: 3 },
      known,
      reserved,
    );
    expect(result.fields).toEqual({ mcp_server: '{"name":"docs"}', label: "text", count: "3" });
    expect(result.dropped).toEqual([]);
  });

  it("drops names that are not identifiers, collide, or attack the prototype", () => {
    const request = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":1,"prototype":2,"bad-key":1,"a b":1,"blockedPath":"x","ok":1,"":1}',
    );
    const result = boundedUnknownFields(request, known, reserved);
    expect(Object.keys(result.fields)).toEqual(["ok"]);
    expect(result.dropped.sort()).toEqual(
      ["", "__proto__", "a b", "bad-key", "blockedPath", "constructor", "prototype"].sort(),
    );
    expect(Object.getPrototypeOf(result.fields)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("keeps at most 32 fields and clips each value to 4 KiB", () => {
    const request = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`field_${index}`, "v"]),
    );
    const result = boundedUnknownFields(request, known, reserved);
    expect(Object.keys(result.fields)).toHaveLength(32);
    expect(result.dropped).toHaveLength(8);

    const clipped = boundedUnknownFields({ big: "界".repeat(5000) }, known, reserved).fields.big!;
    expect(clipped.endsWith("[truncated]")).toBe(true);
    expect(Buffer.byteLength(clipped)).toBeLessThanOrEqual(4096 + "[truncated]".length);
    // The clip never splits a character.
    expect(clipped).not.toContain("\uFFFD");
  });

  it("survives values that cannot be serialized", () => {
    const result = boundedUnknownFields({ big: 10n as unknown }, known, reserved);
    expect(result.fields.big).toBe("[unserializable]");
  });
});

describe("ClaudeProtocolDiagnostics", () => {
  it("counts by category and bounded key, and reports a key once", () => {
    const diagnostics = new ClaudeProtocolDiagnostics();
    diagnostics.record("ignoredFrameTypes", "future_frame");
    diagnostics.record("ignoredFrameTypes", "future_frame");
    diagnostics.record("refusedRequests", "hook_callback");
    expect(diagnostics.snapshot()).toEqual({
      ignoredFrameTypes: { future_frame: 2 },
      refusedRequests: { hook_callback: 1 },
    });
    expect(diagnostics.takeNew().map((entry) => `${entry.category}:${entry.key}`)).toEqual([
      "ignoredFrameTypes:future_frame",
      "refusedRequests:hook_callback",
    ]);
    expect(diagnostics.takeNew()).toEqual([]);
    diagnostics.record("ignoredFrameTypes", "future_frame");
    expect(diagnostics.takeNew()).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["a value with spaces", "two words"],
    ["a quote", 'a"b'],
    ["a line break", "a\nb"],
    ["a 65-character name", "x".repeat(65)],
    ["a number", 7],
    ["undefined", undefined],
  ])("folds %s into `other` so nothing unfiltered reaches a log line", (_label, value) => {
    const diagnostics = new ClaudeProtocolDiagnostics();
    diagnostics.record("ignoredFrameTypes", value);
    expect(diagnostics.snapshot()).toEqual({ ignoredFrameTypes: { other: 1 } });
  });

  it("keeps at most 32 different keys per category and merges the rest", () => {
    const diagnostics = new ClaudeProtocolDiagnostics();
    for (let index = 0; index < 50; index++) diagnostics.record("ignoredFrameTypes", `t${index}`);
    const counts = diagnostics.snapshot().ignoredFrameTypes!;
    expect(Object.keys(counts)).toHaveLength(33);
    expect(counts.other).toBe(18);
  });
});

describe("the verified-through version", () => {
  it("is a record for explanations, 2.1.299", () => {
    expect(CLAUDE_MANAGED_VERIFIED_THROUGH).toBe("2.1.299");
  });

  it.each([
    ["2.1.299 (Claude Code)", false],
    ["2.1.298 (Claude Code)", false],
    ["2.1.300 (Claude Code)", true],
    ["2.1.301 (Claude Code)", true],
    ["3.0.0 (Claude Code)", true],
    ["2.1.300", false],
    ["not a version", false],
    [null, false],
    [undefined, false],
  ])("judges %j newer-than-verified as %s", (value, newer) => {
    expect(isNewerThanVerified(value)).toBe(newer);
  });
});
