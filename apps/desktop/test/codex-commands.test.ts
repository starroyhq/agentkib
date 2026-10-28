// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  CODEX_COMMAND_REFUSALS,
  CODEX_MENU_COMMANDS,
  codexCommandDecision,
  isCodexCommandRefusal,
} from "@agentkib/runtime-protocol";

// Names from `SlashCommand` in codex-rs/tui of Codex 0.163.0.
describe("slash commands in a managed Codex session", () => {
  it("leaves text that is not one of Codex's commands alone", () => {
    for (const text of [
      "hello",
      "/private/tmp needs cleaning",
      "/unknown-command",
      "/effort high",
      "/prompts:review",
      "please /compact this",
      "",
    ])
      expect(codexCommandDecision(text)).toBeNull();
  });

  it.each([
    ["/compact", { action: { action: "compact" } }],
    ["/fork", { action: { action: "fork" } }],
    ["/stop", { action: { action: "terminals-clean" } }],
    ["/clean", { action: { action: "terminals-clean" } }],
    ["/plan", { action: { action: "settings", fields: { mode: "plan" } } }],
    [
      "/plan  sketch the migration ",
      { action: { action: "settings", fields: { mode: "plan" }, draft: "sketch the migration" } },
    ],
    ["/model gpt-6.1-sol", { action: { action: "settings", fields: { model: "gpt-6.1-sol" } } }],
    ["/model", { panel: "settings" }],
    ["/permissions", { panel: "settings" }],
    ["/status", { panel: "settings" }],
    ["/rename Release prep", { action: { action: "rename", fields: { name: "Release prep" } } }],
    ["/rename", { panel: "actions" }],
    ["/archive", { panel: "actions" }],
    [
      "/goal Ship the release\nwith notes",
      {
        action: {
          action: "goal-set",
          fields: { objective: "Ship the release\nwith notes", intent: "start" },
        },
      },
    ],
    ["/goal", { panel: "goal" }],
    ["/diff", { panel: "files" }],
  ] as const)("stands in for %j with AgentKib's own control", (text, outcome) => {
    const decision = codexCommandDecision(text)!;
    expect(decision).toEqual({
      command: decision.command,
      args: decision.args,
      refusal: "codex-command-agentkib",
      ...outcome,
    });
  });

  it.each(["/compact now", "/fork here", "/archive it", "/status please", "/diff src"])(
    "does not drop the argument of %j",
    (text) => {
      expect(codexCommandDecision(text)).toEqual({
        command: text.slice(1).split(" ")[0],
        args: text.split(" ").slice(1).join(" "),
        refusal: "codex-command-arguments",
      });
    },
  );

  it.each([
    ["/new", "codex-command-new"],
    ["/clear", "codex-command-new"],
    ["/review", "codex-command-review"],
    ["/review focus on auth", "codex-command-review"],
    ["/init", "codex-command-init"],
    ["/quit", "codex-command-terminal"],
    ["/vim", "codex-command-terminal"],
    ["/mcp", "codex-command-terminal"],
    ["/CWD", "codex-command-terminal"],
    ["  /resume", "codex-command-terminal"],
  ])("explains %j instead of sending it", (text, refusal) => {
    const decision = codexCommandDecision(text)!;
    expect(decision.refusal).toBe(refusal);
    expect(decision).not.toHaveProperty("action");
    expect(decision).not.toHaveProperty("panel");
  });

  it("resolves aliases and names its refusals", () => {
    expect(codexCommandDecision("/pet")?.command).toBe("pets");
    expect(codexCommandDecision("/clean")?.command).toBe("stop");
    expect(CODEX_COMMAND_REFUSALS.every(isCodexCommandRefusal)).toBe(true);
    expect(isCodexCommandRefusal("claude-command-clear")).toBe(false);
    // Every menu entry runs or opens something.
    for (const name of CODEX_MENU_COMMANDS) {
      const decision = codexCommandDecision(`/${name}`)!;
      expect(decision.action ?? decision.panel).toBeDefined();
    }
  });
});
