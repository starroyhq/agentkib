// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  CLAUDE_COMMAND_REFUSALS,
  claudeCommandDecision,
  claudeCommandRefusal,
  claudeInputCommandRefusal,
  claudeMenuCommands,
  isClaudeCommandRefusal,
  parseClaudeSlashCommand,
  type ClaudeCommandEntry,
} from "@agentkib/runtime-protocol";

// Names, flags, aliases and argument hints as CLI 2.1.311 reported them at initialize, run
// against the local API stub; descriptions shortened. The two project entries are synthetic.
const catalog: ClaudeCommandEntry[] = [
  { name: "probe-skill", description: "A probe skill (project)" },
  { name: "hello", description: "Greets someone (project)", argumentHint: "<name>" },
  { name: "code-review", builtin: true, aliases: ["review"], argumentHint: "[<target>]" },
  { name: "batch", builtin: true, argumentHint: "<instruction>" },
  { name: "doctor", builtin: true, aliases: ["checkup"] },
  { name: "loop", builtin: true, aliases: ["proactive"], argumentHint: "[interval] [prompt]" },
  { name: "autocompact", builtin: true, argumentHint: "[auto|<tokens>]" },
  { name: "clear", builtin: true, aliases: ["reset", "new"], argumentHint: "[name]" },
  { name: "compact", builtin: true, argumentHint: "<optional instructions>" },
  { name: "config", builtin: true, aliases: ["settings"], argumentHint: "key=value" },
  { name: "output-style", builtin: true, argumentHint: "[style]" },
  { name: "context", builtin: true, description: "Show current context usage" },
  { name: "effort", builtin: true, argumentHint: "<low|medium|high|xhigh|max>" },
  { name: "heapdump", builtin: true },
  { name: "mcp", builtin: true, argumentHint: "[reconnect|enable|disable [<server>|all]]" },
  { name: "model", builtin: true, argumentHint: "<model>" },
  { name: "__remote-workflow", builtin: true },
  { name: "workflow-launch-exec", builtin: true },
  { name: "rename", builtin: true, aliases: ["name"], argumentHint: "[name]" },
  { name: "usage", builtin: true, aliases: ["cost", "stats"] },
  { name: "goal", builtin: true },
  { name: "list-agents", builtin: true, aliases: ["peers"] },
];
const owner = { owner: true, commands: catalog };
const remote = { owner: false, commands: catalog };

describe("reading a slash command", () => {
  it.each([
    ["/compact", { name: "compact", args: "" }],
    ["  /Config   permissionMode=auto  ", { name: "config", args: "permissionMode=auto" }],
    ["/config\npermissionMode=auto", { name: "config", args: "permissionMode=auto" }],
    ["/plugin:cmd do it", { name: "plugin:cmd", args: "do it" }],
    ["/__remote-workflow", { name: "__remote-workflow", args: "" }],
  ])("reads %j", (text, expected) => {
    expect(parseClaudeSlashCommand(text)).toEqual(expected);
  });

  // The CLI sends these to the model as text.
  it.each(["/private/tmp is a path", "hello /config", "/", "/ config", "", "/-x", "//config"])(
    "leaves %j as text",
    (text) => {
      expect(parseClaudeSlashCommand(text)).toBeNull();
      expect(claudeCommandRefusal(text, remote)).toBeNull();
    },
  );
});

describe("commands AgentKib refuses for every device", () => {
  it.each([
    ["/clear", "claude-command-clear"],
    ["/clear fresh start", "claude-command-clear"],
    ["/reset", "claude-command-clear"],
    ["/NEW", "claude-command-clear"],
    ["/loop 5m say hi", "claude-command-background"],
    ["/proactive", "claude-command-background"],
    ["/batch migrate everything", "claude-command-background"],
    ["/goal", "claude-command-goal"],
    ["/goal tests pass", "claude-command-goal"],
    ["/rename", "claude-command-rename"],
    ["/rename Probe title", "claude-command-rename"],
    ["/name Probe title", "claude-command-rename"],
    ["/model opus", "claude-command-settings"],
    ["/effort high", "claude-command-settings"],
  ] as const)("%s → %s", (text, refusal) => {
    expect(claudeCommandRefusal(text, owner)).toBe(refusal);
    expect(claudeCommandRefusal(text, remote)).toBe(refusal);
    // Before any worker has reported a catalog as well.
    expect(claudeCommandRefusal(text, { owner: false })).toBe(refusal);
  });
});

describe("commands from the person at this computer", () => {
  it.each([
    "/config permissionMode=auto",
    "/settings autoScroll=false",
    "/heapdump",
    "/doctor",
    "/model",
    "/effort",
    "/output-style Concise",
    "/autocompact 200000",
    "/mcp disable all",
    "/list-agents",
    "/compact",
    "/probe-skill tell me something",
    "/definitely-not-a-command",
  ])("sends %s, as the terminal would", (text) => {
    expect(claudeCommandRefusal(text, owner)).toBeNull();
  });
});

describe("commands from a remote device", () => {
  it.each([
    "/compact",
    "/compact keep the test names",
    "/context",
    "/usage",
    "/cost",
    "/stats",
    "/init",
    "/review",
    "/code-review high 42",
    "/security-review",
    "/simplify src",
    "/verify",
    "/recap",
    "/deep-research topic",
    "/dataviz",
    "/claude-api",
    "/run",
    "/color orange",
    "/focus",
    "/fast",
    "/agents",
    "/reload-skills",
    "/model",
    "/effort",
    "/output-style",
    "/autocompact",
    "/mcp",
  ])("sends %s", (text) => {
    expect(claudeCommandRefusal(text, remote)).toBeNull();
  });

  it.each([
    // Writes `permissions.defaultMode` to ~/.claude/settings.json; later sessions start in auto.
    "/config permissionMode=auto",
    "/settings",
    "/CONFIG autoScroll=false",
    // Writes project or user settings.
    "/output-style Concise",
    "/autocompact 200000",
    "/mcp disable all",
    // Writes a heap snapshot to the Desktop.
    "/heapdump",
    "/doctor",
    "/checkup",
    "/insights",
    "/list-agents",
    "/peers",
    "/fewer-permission-prompts",
    "/update-config",
    "/auto-mode-setup",
    "/reload-plugins",
    "/__remote-workflow",
  ])("refuses %s", (text) => {
    expect(claudeCommandRefusal(text, remote)).toBe("claude-command-owner-only");
    // The built-in list covers the time before a worker has reported a catalog.
    expect(claudeCommandRefusal(text, { owner: false })).toBe("claude-command-owner-only");
  });

  it("sends skills, custom and plugin commands, and names the CLI does not know", () => {
    for (const text of [
      "/probe-skill tell me something",
      "/hello world",
      "/plugin:deploy staging",
      "/definitely-not-a-command",
    ])
      expect(claudeCommandRefusal(text, remote)).toBeNull();
  });

  it("refuses a built-in that only the reported catalog knows", () => {
    const commands = [...catalog, { name: "new-thing", builtin: true }];
    expect(claudeCommandRefusal("/new-thing", { owner: false, commands })).toBe(
      "claude-command-owner-only",
    );
    expect(claudeCommandRefusal("/new-thing", { owner: false, commands: catalog })).toBeNull();
    expect(claudeCommandRefusal("/new-thing", { owner: true, commands })).toBeNull();
  });

  it("resolves aliases the reported catalog adds", () => {
    const commands = [
      { name: "config", builtin: true, aliases: ["prefs"] },
      { name: "clear", builtin: true, aliases: ["wipe"] },
    ];
    expect(claudeCommandRefusal("/prefs x=1", { owner: false, commands })).toBe(
      "claude-command-owner-only",
    );
    expect(claudeCommandRefusal("/prefs x=1", { owner: true, commands })).toBeNull();
    expect(claudeCommandRefusal("/wipe", { owner: true, commands })).toBe("claude-command-clear");
  });

  it("keeps a project command from unlocking a built-in name or alias", () => {
    // Which of the two the CLI runs is not verified, so the stricter rule applies.
    expect(claudeCommandRefusal("/config", { owner: false, commands: [{ name: "config" }] })).toBe(
      "claude-command-owner-only",
    );
    expect(
      claudeCommandRefusal("/settings", { owner: false, commands: [{ name: "settings" }] }),
    ).toBe("claude-command-owner-only");
    expect(claudeCommandRefusal("/review", { owner: false, commands: [{ name: "review" }] })).toBe(
      null,
    );
  });

  it("ignores malformed catalog entries", () => {
    const commands = [
      null,
      { name: 7 },
      { name: "x", aliases: "config" },
      { name: "y", aliases: [null, 3] },
    ] as unknown as ClaudeCommandEntry[];
    expect(claudeCommandRefusal("/config", { owner: false, commands })).toBe(
      "claude-command-owner-only",
    );
    expect(claudeCommandRefusal("/x", { owner: false, commands })).toBeNull();
    expect(claudeMenuCommands(commands, true).map((entry) => entry.name)).toEqual(["x", "y"]);
  });
});

describe("a message with several blocks", () => {
  const image = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
  };

  it("checks every text block", () => {
    expect(claudeInputCommandRefusal([image, { type: "text", text: "/config x=1" }], remote)).toBe(
      "claude-command-owner-only",
    );
    expect(
      claudeInputCommandRefusal(
        [
          { type: "text", text: "hello" },
          { type: "text", text: "/clear" },
        ],
        owner,
      ),
    ).toBe("claude-command-clear");
    expect(claudeInputCommandRefusal([image, { type: "text", text: "/compact" }], remote)).toBe(
      null,
    );
  });

  it("passes plain text and anything without text", () => {
    expect(claudeInputCommandRefusal("hello", remote)).toBeNull();
    expect(claudeInputCommandRefusal("/heapdump", remote)).toBe("claude-command-owner-only");
    expect(claudeInputCommandRefusal([image, { type: "text", text: 4 }, null], remote)).toBeNull();
    expect(claudeInputCommandRefusal(undefined, remote)).toBeNull();
    expect(claudeInputCommandRefusal({ text: "/config" }, remote)).toBeNull();
  });
});

describe("what a command resolves to", () => {
  it("names the command an alias runs, for clients that map it to AgentKib", () => {
    expect(claudeCommandDecision("/name Probe title", owner)).toEqual({
      name: "name",
      args: "Probe title",
      command: "rename",
      refusal: "claude-command-rename",
    });
    expect(claudeCommandDecision("/model opus", remote)).toMatchObject({
      command: "model",
      args: "opus",
      refusal: "claude-command-settings",
    });
    expect(claudeCommandDecision("/cost", remote)).toMatchObject({
      command: "usage",
      refusal: null,
    });
    expect(claudeCommandDecision("/probe-skill go", remote)).toMatchObject({
      command: "probe-skill",
      refusal: null,
    });
    expect(claudeCommandDecision("plain text", owner)).toBeNull();
  });

  it("lists exactly the refusal codes", () => {
    expect(CLAUDE_COMMAND_REFUSALS).toEqual([
      "claude-command-clear",
      "claude-command-background",
      "claude-command-goal",
      "claude-command-rename",
      "claude-command-settings",
      "claude-command-owner-only",
    ]);
    expect(isClaudeCommandRefusal("claude-command-clear")).toBe(true);
    expect(isClaudeCommandRefusal("claude-command")).toBe(false);
    expect(isClaudeCommandRefusal(undefined)).toBe(false);
  });
});

describe("the / menu", () => {
  it("offers the owner everything but background and internal commands", () => {
    const names = claudeMenuCommands(catalog, true).map((entry) => entry.name);
    expect(names).toEqual([
      "probe-skill",
      "hello",
      "code-review",
      "doctor",
      "autocompact",
      "clear",
      "compact",
      "config",
      "output-style",
      "context",
      "effort",
      "heapdump",
      "mcp",
      "model",
      "rename",
      "usage",
      "goal",
      "list-agents",
    ]);
  });

  it("offers a remote device only what it may run", () => {
    const menu = claudeMenuCommands(catalog, false);
    expect(menu.map((entry) => entry.name)).toEqual([
      "probe-skill",
      "hello",
      "code-review",
      "autocompact",
      "clear",
      "compact",
      "output-style",
      "context",
      "effort",
      "mcp",
      "model",
      "rename",
      "usage",
      "goal",
    ]);
    const byName = Object.fromEntries(menu.map((entry) => [entry.name, entry]));
    // Bare only: no argument hint. /model and /effort keep theirs, AgentKib maps them.
    expect(byName["output-style"]).toEqual({ name: "output-style", aliases: [] });
    expect(byName.autocompact?.argumentHint).toBeUndefined();
    expect(byName.mcp?.argumentHint).toBeUndefined();
    expect(byName.model?.argumentHint).toBe("<model>");
    expect(byName.effort?.argumentHint).toBe("<low|medium|high|xhigh|max>");
    expect(byName.hello).toEqual({
      name: "hello",
      description: "Greets someone (project)",
      argumentHint: "<name>",
      aliases: [],
    });
    expect(byName.usage?.aliases).toEqual(["cost", "stats"]);
  });

  it("lists a name once, keeping the first entry", () => {
    const menu = claudeMenuCommands(
      [
        { name: "Hello", description: "first" },
        { name: "hello", description: "second" },
      ],
      true,
    );
    expect(menu).toEqual([{ name: "Hello", description: "first", aliases: [] }]);
  });
});
