import { describe, expect, it } from "vitest";
import {
  agentKibCommand,
  claudeSlashOptions,
  matchSlashCommands,
  slashCommandCopy,
  slashCommandQuery,
  type SlashCommandOption,
} from "@agentkib/session-ui";

const option = (name: string, aliases: string[] = []): SlashCommandOption => ({ name, aliases });

describe("the slash menu's matching", () => {
  it.each([
    ["/", ""],
    ["/Comp", "comp"],
    ["/plugin:cmd", "plugin:cmd"],
  ])("reads %j as the query %j", (draft, query) => {
    expect(slashCommandQuery(draft)).toBe(query);
  });

  it.each(["", "compact", " /compact", "/compact ", "/private/tmp", "/a b", "/x\n"])(
    "opens no menu for %j",
    (draft) => {
      expect(slashCommandQuery(draft)).toBeNull();
    },
  );

  it("orders names, then aliases, then names containing the query", () => {
    const options = [
      option("recap"),
      option("code-review", ["review"]),
      option("compact"),
      option("usage", ["cost", "stats"]),
      option("Context"),
    ];
    expect(matchSlashCommands(options, "co").map((entry) => entry.name)).toEqual([
      "code-review",
      "compact",
      "Context",
      "usage",
    ]);
    expect(matchSlashCommands(options, "rev").map((entry) => entry.name)).toEqual(["code-review"]);
    expect(matchSlashCommands(options, "ca").map((entry) => entry.name)).toEqual(["recap"]);
    expect(matchSlashCommands(options, "")).toEqual(options);
    expect(matchSlashCommands(options, "zzz")).toEqual([]);
  });
});

describe("AgentKib's own action for a refused command", () => {
  it.each([
    [
      { command: "model", args: "opus", refusal: "claude-command-settings" },
      { action: "settings", fields: { model: "opus" } },
    ],
    [
      { command: "effort", args: "XHigh", refusal: "claude-command-settings" },
      { action: "settings", fields: { effort: "xhigh" } },
    ],
    [
      { command: "rename", args: "Probe title", refusal: "claude-command-rename" },
      { action: "rename", fields: { name: "Probe title" } },
    ],
    [
      { command: "goal", args: "tests pass", refusal: "claude-command-goal" },
      { action: "goal-set", fields: { objective: "tests pass", intent: "start" } },
    ],
  ])("maps %j", (decision, expected) => {
    expect(agentKibCommand(decision)).toEqual(expected);
  });

  it.each([
    { command: "effort", args: "ultracode on", refusal: "claude-command-settings" },
    { command: "rename", args: "", refusal: "claude-command-rename" },
    { command: "goal", args: "", refusal: "claude-command-goal" },
    { command: "clear", args: "fresh", refusal: "claude-command-clear" },
    { command: "loop", args: "5m hi", refusal: "claude-command-background" },
    { command: "config", args: "x=1", refusal: "claude-command-owner-only" },
    { command: "compact", args: "now", refusal: null },
  ])("only explains %j", (decision) => {
    expect(agentKibCommand(decision)).toBeNull();
  });
});

describe("menu descriptions", () => {
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"])(
    "describes AgentKib's action for the commands it handles in %s",
    (locale) => {
      const copy = slashCommandCopy(locale);
      const options = claudeSlashOptions(
        [
          { name: "model", description: "Set the AI model", argumentHint: "<model>", aliases: [] },
          { name: "Clear", argumentHint: "[name]", aliases: ["reset"] },
          { name: "effort", argumentHint: "<low|…|auto|ultracode [on|off]>", aliases: [] },
          { name: "compact", description: "Free up context", argumentHint: "<text>", aliases: [] },
          { name: "constructor", aliases: [] },
        ],
        locale,
      );
      expect(options).toEqual([
        { name: "model", description: copy.model, argumentHint: "<model>", aliases: [] },
        // AgentKib starts no session with a name, and takes only the levels it can set.
        { name: "Clear", description: copy.clear, aliases: ["reset"] },
        {
          name: "effort",
          description: copy.effort,
          argumentHint: "<low|medium|high|xhigh|max>",
          aliases: [],
        },
        { name: "compact", description: "Free up context", argumentHint: "<text>", aliases: [] },
        { name: "constructor", aliases: [] },
      ]);
      expect(new Set(Object.values(copy)).size).toBe(Object.keys(copy).length);
    },
  );
});
