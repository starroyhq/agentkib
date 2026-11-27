import { describe, expect, it } from "vitest";
import { claudeModelDisplayName, claudeModelOption } from "@agentkib/runtime-protocol";
import type { ClaudeModelOption } from "../../../packages/backend/src/agents/claude/claude-managed-runner";

// The list CLI 2.1.311 reports at initialize (offline, local API stub), trimmed to what matters.
const models: ClaudeModelOption[] = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus" },
  { value: "fable", resolvedModel: "claude-fable-5-1", displayName: "Fable" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet" },
  { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku" },
];

describe("the model /model names", () => {
  it.each([
    ["haiku", "haiku"],
    ["Haiku", "haiku"],
    ["SONNET", "sonnet"],
    ["default", "default"],
    ["claude-haiku-5-5", "haiku"],
    ["Claude-Sonnet-5-5", "sonnet"],
    // Two aliases resolve to this model; the named one is meant, not the moving default.
    ["claude-opus-5-5", "opus"],
  ])("%s → %s", (typed, value) => {
    expect(claudeModelOption(models, typed)?.value).toBe(value);
  });

  it("uses default when only default resolves to the model", () => {
    const only = [models[0], models[3]];
    expect(claudeModelOption(only, "claude-opus-5-5")?.value).toBe("default");
  });

  it.each(["no-such-model", "claude-opus-4-1", "", "   "])("finds nothing for %j", (typed) => {
    expect(claudeModelOption(models, typed)).toBeUndefined();
  });
});

describe("Claude model display names", () => {
  it.each([
    ["claude-fable-5-2", "Fable 5.2"],
    ["claude-fable-5-2[1m]", "Fable 5.2"],
    ["claude-aurora-123-4", "Aurora 123.4"],
    ["claude-3-5-sonnet-20241022", "Sonnet 3.5"],
    ["claude-sonnet-4-20250514", "Sonnet 4"],
    ["claude-haiku-4-5-20251001", "Haiku 4.5"],
    ["claude-opus-5-5-latest", "Opus 5.5"],
    ["opus", "Opus"],
    ["sonnet", "Sonnet"],
    ["haiku", "Haiku"],
    ["fable", "Fable"],
    ["fable[1m]", "Fable"],
    ["opus[1m]", "Opus"],
    ["sonnet[1m]", "Sonnet"],
    ["aurora", "Aurora"],
    ["default", "default"],
    ["best", "best"],
    ["inherit", "inherit"],
    ["opusplan", "opusplan"],
    ["opusplan[1m]", "opusplan[1m]"],
    ["private/model:v2", "private/model:v2"],
  ])("displays %s as %s", (model, label) => {
    expect(claudeModelDisplayName(model) ?? model).toBe(label);
  });
});
