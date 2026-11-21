import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readClaudeSettings, redactText } from "../../../packages/backend/src/agents/claude/claude-settings";
import { scanNativeMcp } from "../../../packages/backend/src/mcp-native-scan";
import { BackendStore } from "../../../packages/backend/src/store";
import { contextFixture, type ContextFixture } from "./fixtures/claude-context";

const fixtures: ContextFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});
function fixture() {
  const created = contextFixture();
  fixtures.push(created);
  return created;
}
const json = (value: unknown) => JSON.stringify(value);
const credentialCommands = [
  "timeout 10 curl -su account:wrapper-canary https://example.test",
  "sudo -n curl -sU account:wrapper-canary https://example.test",
  'curl "-u" account:wrapper-canary https://example.test',
  "curl '--user' account:wrapper-canary https://example.test",
  "curl '--proxy-user=account:wrapper-canary' https://example.test",
  "curl '-suaccount:wrapper-\ncanary' https://example.test",
  "timeout 10 curl '--user' account:wrapper-canary https://example.test",
  "custom-launcher --label example curl -su account:wrapper-canary https://example.test",
  "timeout 10 /usr/bin/cu''rl '-s''u' 'account:wrapper-'canary https://example.test",
  "sudo -n sh -c 'curl -su account:wrapper-canary https://example.test'",
  "sudo -n sh -c 'curl -s\"\"u account:wrapper-canary https://example.test'",
  "timeout 10 sh -c 'cu\"\"rl -su account:wrapper-canary https://example.test'",
  'custom-launcher \'cu""rl -s""u account:wrapper-canary https://example.test\'',
  "sudo -n sh -c 'cu\\rl -s\\u account:wrapper-canary https://example.test'",
  ...["\n", "\r\n"].flatMap((newline) => [
    `sudo -n sh -c 'cu\\${newline}rl -su account:wrapper-canary https://example.test'`,
    `sudo -n sh -c 'curl -s\\${newline}u account:wrapper-canary https://example.test'`,
  ]),
  "timeout 10 sh -c \"curl -s''u account:wrapper-canary https://example.test\"",
  'timeout 10 "$CURL" -su account:wrapper-canary https://example.test',
  "sudo \"$WRAPPER\" cu''rl -s''u account:wrapper-canary https://example.test",
  "echo $(curl -su account:wrapper-canary https://example.test)",
  "sh --unknown 'curl -su account:wrapper-canary https://example.test'",
  "env curl -su account:wrapper-canary https://example.test",
  "$WRAPPER curl -su account:wrapper-canary https://example.test",
  "env $WRAPPER curl -su account:wrapper-canary https://example.test",
  "$CURL -su account:wrapper-canary https://example.test",
  'env "$WRAPPER" curl -sU account:wrapper-canary https://example.test',
  "sh -c '$WRAPPER curl -su account:wrapper-canary https://example.test'",
  "MODE=$VALUE command curl -su account:wrapper-canary https://example.test",
  ...["$1", "$0", "$@", "$*", "$#", "$?", "$$", "$!", "$-", "$_"].map(
    (parameter) => `env ${parameter} curl -su account:wrapper-canary https://example.test`,
  ),
  'env curl "-su" account:wrapper-canary https://example.test',
  'command curl "-sUaccount:wrapper-canary" https://example.test',
  "env curl -su 'account:wrapper-canary",
  "sh -c 'curl -su account:wrapper-canary",
  "env $(printf curl) -su account:wrapper-canary https://example.test",
  "LANG=$(locale) curl -su account:wrapper-canary https://example.test",
  "env -u $(printf OLD) curl -su account:wrapper-canary https://example.test",
  "LANG=`locale` command curl -sU account:wrapper-canary https://example.test",
  "sh $(printf -c) 'curl -su account:wrapper-canary https://example.test'",
  "env MODE=safe curl -sU 'account:wrapper-canary' https://example.test",
  "MODE=safe curl -su account:wrapper-canary https://example.test",
  "command curl -su account:wrapper-canary https://example.test",
  "command -p /usr/bin/curl -sU account:wrapper-canary https://example.test",
  "env -i --unset OLD --chdir . MODE=safe command -- curl -su account:wrapper-canary https://example.test",
  "sh -c 'curl -su account:wrapper-canary https://example.test'",
  'bash -lc "env MODE=safe curl -sU account:wrapper-canary https://example.test"',
  "MODE=safe env sh -c 'command curl -su account:wrapper-canary https://example.test'",
  "env curl -sU 'account:wrapper-'canary https://example.test",
  "MODE=safe curl -sU account:wrapper-\\\ncanary https://example.test",
  "env curl $(printf -s) -su account:wrapper-canary https://example.test",
  "sh -c 'env curl -su $(printf account:wrapper-canary) https://example.test'",
  "env -S 'curl -su account:wrapper-canary https://example.test'",
] as const;

describe("wrapped command credential boundaries", () => {
  it.each(credentialCommands)("redacts a wrapped curl credential: %s", (command) => {
    const output = redactText(command);
    expect(output).toContain("[REDACTED]");
    for (const secret of ["account", "wrapper-", "canary"]) expect(output).not.toContain(secret);
  });

  it.each(credentialCommands)(
    "keeps credentials out of Context and real MCP metadata: %s",
    async (command) => {
      const f = fixture();
      f.write(".claude/settings.json", json({ statusLine: { type: "command", command } }));
      f.write(
        ".claude/commands/check.md",
        `---\ndescription: ${json(command)}\n---\nA public command body.\n`,
      );
      const preview = await f.request();
      const renderer = json(preview);
      expect(renderer).toContain("[REDACTED]");
      expect(preview.sections.find((section) => section.scope === "settings")?.content).toContain(
        "statusLine: command",
      );
      for (const agent of ["claude-code", "codex"]) {
        const mcp = await f.mcp(f.project, agent);
        const output = json(mcp);
        if (agent === "claude-code") {
          expect(output).toContain("[REDACTED]");
          expect(mcp.sections.find((section) => section.scope === "settings")?.content).toContain(
            "statusLine: configured",
          );
          expect(
            mcp.sections.find((section) => section.scope === "settings")?.content,
          ).not.toContain("curl");
        }
        for (const secret of ["account:wrapper", "wrapper-", "canary"]) {
          expect(renderer).not.toContain(secret);
          expect(output).not.toContain(secret);
        }
      }
    },
  );

  it("preserves ordinary wrapper commands and quoted command-looking text", () => {
    for (const command of [
      "MODE=safe env command node build.mjs --watch",
      "env -u OLD MODE=safe command -p curl --head https://example.test",
      "sh -c 'printf ready; npm run build'",
      "env python -u script.py",
      "sh -c 'python -u script.py'",
      "env -S 'node build.mjs --watch'",
      "timeout 10 curl --head https://example.test",
      "sudo -n python -u script.py",
      "sudo -n sh -c 'cu\"\"rl --head https://example.test'",
      "echo timeout 10 curl -su reviewer:group",
      "printf 'sudo -n curl -su reviewer:group'",
      "echo '$(curl -su reviewer:group)'",
      "command tool -su reviewer:group",
      "env echo curl -su reviewer:group",
      "printf 'env curl -su reviewer:group'",
      "command -v curl",
      "\\$WRAPPER curl -su reviewer:group",
      "'$WRAPPER' curl -su reviewer:group",
      "printf '$WRAPPER curl -su reviewer:group'",
      "env NAME='$WRAPPER' command node build.mjs",
      "sh -c 'printf \"$WRAPPER\"'",
      "sh -c 'printf \"\ue0000\ue000\"'",
    ])
      expect(redactText(command)).toBe(command);
  });

  it("bounds nested shell parsing and hides the unparsed script", () => {
    let command = "curl -su account:wrapper-canary https://example.test";
    for (let index = 0; index < 8; index++) command = `sh -c '${command.replace(/'/g, "'\\''")}'`;
    const output = redactText(command);
    expect(output.length).toBeLessThanOrEqual(201);
    expect(output).not.toContain("wrapper-canary");
  });
});

describe("nested URL parameter boundaries", () => {
  const commands = [
    "echo https://example.test?redirect=https://foo.test/?auth[secret]=query-canary",
    "echo https://example.test?redirect=https://foo.test/?token!=query-canary&plain=visible",
    "echo https://example.test?redirect=https://foo.test/?next=https://bar.test/?api[key]=query-canary",
    "echo https://example.test?plain=visible&next=https://foo.test/#access[token]=query-canary",
  ];
  it.each(commands)("redacts nested sensitive values in Context and MCP: %s", async (command) => {
    const f = fixture();
    f.write(".claude/settings.json", json({ statusLine: { type: "command", command } }));
    f.write(".claude/commands/check.md", `---\ndescription: ${json(command)}\n---\nPublic body.\n`);
    for (const output of [redactText(command), json(await f.request()), json(await f.mcp())]) {
      expect(output).not.toContain("query-canary");
      expect(output).toContain("[REDACTED]");
      expect(output).toContain("https://example.test?");
    }
  });
  it("preserves nested ordinary URL parameters", () => {
    const command = "echo https://example.test?redirect=https://foo.test/?page=2&mode=plain";
    expect(redactText(command)).toBe(command);
  });
});

describe("effective settings lists are not display-limited", () => {
  it("retains long nonempty exclusion strings across layers for the shared matcher budget", () => {
    const f = fixture();
    const matching = `**/${"*".repeat(1_024)}CLAUDE.md`;
    const costly = `**/${"q".repeat(180_000)}.md`;
    f.user("settings.json", json({ claudeMdExcludes: [matching, "", null, false, 1] }));
    f.write(".claude/settings.json", json({ claudeMdExcludes: [costly] }));
    const settings = readClaudeSettings({
      root: f.project,
      cwd: f.project,
      environment: f.environment,
      mode: "full",
      managedDir: f.managedDir,
    });
    const rules = settings.claudeMdExcludes();
    expect(rules).toHaveLength(2);
    expect(rules[0] === matching).toBe(true);
    expect(rules[1] === costly).toBe(true);
  });

  it.each([255, 256, 300])(
    "retains managed policy after %i lower-priority rules",
    async (count) => {
      const f = fixture();
      f.user(
        "settings.json",
        json({
          deniedMcpServers: Array.from({ length: count }, (_, index) => ({
            serverName: `lower-${index}`,
          })),
          claudeMdExcludes: Array.from({ length: count }, (_, index) => `unused-${index}.md`),
          disabledMcpjsonServers: Array.from({ length: count }, (_, index) => `lower-${index}`),
        }),
      );
      f.write(
        path.join(f.managedDir, "managed-settings.json"),
        json({
          deniedMcpServers: [{ serverName: "managed-blocked" }],
          claudeMdExcludes: [f.at(".claude", "rules", "private.md")],
          disabledMcpjsonServers: ["managed-rejected"],
        }),
      );
      f.write("CLAUDE.md", "Project instructions.\n");
      f.write(".claude/rules/private.md", "MANAGED-EXCLUDED-BODY");
      f.write(
        ".mcp.json",
        json({
          mcpServers: {
            "managed-blocked": { type: "http", url: "https://example.test/blocked" },
            "managed-rejected": { type: "http", url: "https://example.test/rejected" },
          },
        }),
      );
      const settings = readClaudeSettings({
        root: f.project,
        cwd: f.project,
        environment: f.environment,
        mode: "full",
        managedDir: f.managedDir,
      });
      expect(settings.mcpPolicy().denied).toHaveLength(count + 1);
      expect(settings.mcpPolicy().denied).toContainEqual({ serverName: "managed-blocked" });
      expect(settings.claudeMdExcludes()).toHaveLength(count + 1);
      expect(settings.claudeMdExcludes()).toContain(f.at(".claude", "rules", "private.md"));
      expect(settings.mcpApprovals().disabled.has("managed-rejected")).toBe(true);
      expect(json(await f.request())).not.toContain("MANAGED-EXCLUDED-BODY");
      const store = new BackendStore(path.join(f.root, "db.sqlite"));
      try {
        store.sql.run(
          "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
          "workspace",
          f.project,
          "fixture",
          "healthy",
          new Date().toISOString(),
        );
        const candidates = scanNativeMcp({ project: f.project }, store, f.environment, {
          managedDir: f.managedDir,
        });
        expect(
          candidates
            .find((candidate) => candidate.name === "managed-blocked")
            ?.warning_messages?.map((warning) => warning.key),
        ).toContain("mcp.manage.diagnostic.native_policy_denied");
        expect(
          candidates
            .find((candidate) => candidate.name === "managed-rejected")
            ?.warning_messages?.map((warning) => warning.key),
        ).toContain("mcp.manage.diagnostic.native_project_rejected");
      } finally {
        store.close();
      }
    },
  );

  it("keeps all managed drop-in rules while bounding the displayed list", () => {
    const f = fixture();
    f.write(
      path.join(f.managedDir, "managed-settings.json"),
      json({
        deniedMcpServers: Array.from({ length: 256 }, (_, index) => ({
          serverName: `base-${index}`,
        })),
        permissions: { deny: Array.from({ length: 256 }, (_, index) => `Read(base-${index})`) },
        claudeMdExcludes: Array.from({ length: 256 }, (_, index) => `base-${index}.md`),
        disabledMcpjsonServers: Array.from({ length: 256 }, (_, index) => `base-${index}`),
      }),
    );
    for (const name of ["10-first", "20-last"])
      f.write(
        path.join(f.managedDir, "managed-settings.d", `${name}.json`),
        json({
          deniedMcpServers: [{ serverName: name }],
          permissions: { deny: [`Read(${name})`] },
          claudeMdExcludes: [`${name}.md`],
          disabledMcpjsonServers: [name],
        }),
      );
    const settings = readClaudeSettings({
      root: f.project,
      cwd: f.project,
      environment: f.environment,
      mode: "full",
      managedDir: f.managedDir,
    });
    expect(settings.mcpPolicy().denied).toHaveLength(258);
    expect(settings.mcpPolicy().denied.at(-1)).toEqual({ serverName: "20-last" });
    expect(settings.claudeMdExcludes()).toHaveLength(258);
    expect(settings.claudeMdExcludes().at(-1)).toBe("20-last.md");
    expect(settings.mcpApprovals().disabled.size).toBe(258);
    expect(settings.mcpApprovals().disabled.has("20-last")).toBe(true);
    const description = settings.describe("full");
    expect(description).toContain("permissions.deny: 258 entries");
    expect(description).toContain("… (+208 more)");
    expect(description).not.toContain("Read(base-50)");
    expect(description).toContain("deniedMcpServers: 258 entries");
  });
});
