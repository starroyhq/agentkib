import { describe, expect, it } from "vitest";
import {
  claudeModelOption,
  type ClaudeModelOption,
} from "../../../packages/backend/src/claude-managed-runner";

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
