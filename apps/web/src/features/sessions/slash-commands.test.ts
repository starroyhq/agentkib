import { describe, expect, it } from "vitest";
import {
  agentKibCommand,
  agentKibPanel,
  claudeSlashOptions,
  codexCommandPrompt,
  matchSlashCommands,
  slashCommandCopy,
  slashCommandQuery,
  unsupportedEffortReason,
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

  // CLI 2.1.311 also takes auto and ultracode [on|off]; next-turn settings take low to max.
  it.each(["auto", "Ultracode on", "turbo"])(
    "explains /effort %s by the levels it takes",
    (args) => {
      expect(
        unsupportedEffortReason({ command: "effort", args, refusal: "claude-command-settings" }),
      ).toBe("claude-effort-unsupported");
    },
  );

  it.each([
    { command: "effort", args: "HIGH", refusal: "claude-command-settings" },
    { command: "effort", args: "", refusal: null },
    { command: "model", args: "auto", refusal: "claude-command-settings" },
    { command: "effort", args: "auto", refusal: "claude-command-owner-only" },
  ])("keeps the refusal for %j", (decision) => {
    expect(unsupportedEffortReason(decision)).toBeNull();
  });
});

describe("the AgentKib control a bare command opens", () => {
  it.each([
    [{ command: "model", args: "" }, "settings"],
    [{ command: "effort", args: "" }, "settings"],
    [{ command: "goal", args: "" }, "goal"],
    [{ command: "rename", args: "" }, "actions"],
  ] as const)("opens %j in %s", (decision, panel) => {
    expect(agentKibPanel(decision)).toBe(panel);
  });

  it.each([
    { command: "model", args: "opus" },
    { command: "rename", args: "Probe title" },
    { command: "goal", args: "tests pass" },
    { command: "clear", args: "" },
    { command: "compact", args: "" },
    { command: "config", args: "" },
  ])("opens nothing for %j", (decision) => {
    expect(agentKibPanel(decision)).toBeNull();
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
          { name: "effort", argumentHint: "<low|…|auto|ultracode [on|off]>", aliases: [] },
          { name: "Rename", argumentHint: "[name]", aliases: ["name"] },
          { name: "goal", aliases: [] },
          { name: "compact", description: "Free up context", argumentHint: "<text>", aliases: [] },
          { name: "constructor", aliases: [] },
        ],
        locale,
      );
      // The argument is optional: without one the command opens AgentKib's control. /effort
      // takes only the levels AgentKib can set.
      expect(options).toEqual([
        { name: "model", description: copy.model, argumentHint: "[model]", aliases: [] },
        {
          name: "effort",
          description: copy.effort,
          argumentHint: "[low|medium|high|xhigh|max]",
          aliases: [],
        },
        { name: "Rename", description: copy.rename, argumentHint: "[name]", aliases: ["name"] },
        { name: "goal", description: copy.goal, argumentHint: "[objective]", aliases: [] },
        { name: "compact", description: "Free up context", argumentHint: "<text>", aliases: [] },
        { name: "constructor", aliases: [] },
      ]);
      expect(new Set(Object.values(copy)).size).toBe(Object.keys(copy).length);
    },
  );
});

describe("messages AgentKib writes for Codex's /review and /init", () => {
  const locales = ["zh-CN", "zh-TW", "en-US", "ja-JP"];
  it.each(locales)("reviews without changes and keeps an existing AGENTS.md, in %s", (locale) => {
    const uncommitted = codexCommandPrompt(locale, { kind: "review", base: null });
    const branch = codexCommandPrompt(locale, { kind: "review", base: "origin/main" });
    const init = codexCommandPrompt(locale, { kind: "init" });
    // git diff leaves out untracked files, so the uncommitted review names git status too.
    expect(uncommitted).toContain("`git status`");
    expect(uncommitted).toContain("`git diff --staged`");
    expect(uncommitted).not.toContain("merge-base");
    // A branch review starts where the current branch left the base.
    expect(branch).toContain("`origin/main`");
    expect(branch).toContain("`git merge-base HEAD origin/main`");
    expect(branch).not.toContain("--staged");
    // Both follow the repository's own instructions; init writes them.
    for (const prompt of [uncommitted, branch, init]) expect(prompt).toContain("AGENTS.md");
    expect(new Set([uncommitted, branch, init]).size).toBe(3);
  });
  it("writes in the reader's language, English for the others", () => {
    const init = (locale: string) => codexCommandPrompt(locale, { kind: "init" });
    expect(new Set(locales.map(init)).size).toBe(4);
    expect(init("fr-FR")).toBe(init("en-US"));
    expect(init("zh-HK")).toBe(init("zh-CN"));
    expect(init("ja")).toBe(init("ja-JP"));
    expect(codexCommandPrompt("zh-CN", { kind: "review", base: "HEAD~3" })).toContain(
      "`git merge-base HEAD HEAD~3`",
    );
  });
});
