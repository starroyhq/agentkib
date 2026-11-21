import { afterEach, describe, expect, it } from "vitest";
import { redactText } from "../../../packages/backend/src/agents/claude/claude-settings";
import { contextFixture, type ContextFixture } from "./fixtures/claude-context";

const fixtures: ContextFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});
const credentialCommands = [
  "curl --h''eader 'Author''ization: shortcanary' https://example.test",
  'curl --h""eader "aUtHoR""iZaTiOn: shortcanary" https://example.test',
  String.raw`curl -\H 'Author''ization: shortcanary' https://example.test`,
  String.raw`curl --hea\der 'Author''ization: shortcanary' https://example.test`,
  "curl '--header=Author''ization: shortcanary' https://example.test",
  "curl --proxy-h''eader 'Proxy-Author''ization: shortcanary' https://example.test",
  "curl -sH 'Author''ization: shortcanary' https://example.test",
  "curl '-sHAuthor''ization: shortcanary' https://example.test",
  "run --to''ken shortcanary --format json; echo ready",
  String.raw`run --to\ken shortcanary --format json; echo ready`,
  "run '--To''KeN' shortcanary --format json; echo ready",
  "run '--to''ken=shortcanary' --format json; echo ready",
  "run --api-''key 'short'canary --format json; echo ready",
  'run --pass""word short\\canary --format json; echo ready',
  "env MODE=safe command run --to''ken shortcanary; echo ready",
  "bash -lc \"run --to''ken shortcanary; echo ready\"",
  "run --to''ken $(printf shortcanary); echo hidden",
  "curl --h''eader \"Author${PART}ization: shortcanary\" https://example.test",
  "curl --h''eader 'Author''ization: shortcanary",
  "run --to''ken 'shortcanary",
  "run --to${PART}ken shortcanary; echo hidden",
  "\"$WRAPPER\" run --to''ken shortcanary; echo hidden",
  "timeout 10 curl --h''eader 'Author''ization: shortcanary' https://example.test",
  "curl https://example.test?api''_key=shortcanary",
  String.raw`curl https://example.test?api\_key=shortcanary`,
  "curl https://example.test?api_\\\nkey=shortcanary",
  "curl 'https://example.test?to''ken=shortcanary&mode=safe'",
  "curl 'https://account:short''canary@example.test/path'",
  String.raw`curl https://account:short\canary@example.test/path`,
  'curl --h\\\neader "Author\\\nization: shortcanary" https://example.test',
  "curl -su account:shortcanary 'https://example.test?api''_key=shortcanary'",
  "TO''KEN=shortcanary run --mode safe; echo ready",
  "echo 'Author''ization: shortcanary'",
] as const;

describe("decoded shell option redaction", () => {
  it.each(credentialCommands)("hides a complete literal or uncertain credential: %s", (command) => {
    const output = redactText(command);
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("short");
    expect(output).not.toContain("canary");
  });

  it.each([
    "run --mo''de safe --format json; echo ready",
    String.raw`run --mo\de safe --format json; echo ready`,
    "curl --h''eader 'Content-''Type: application/json' https://example.test; echo ready",
    String.raw`curl -\H 'Accept: application/json' https://example.test`,
    "curl -sH 'Accept: application/json' https://example.test",
    "curl -d 'Content-''Type: public' https://example.test",
    "curl -dH 'Accept: application/json' https://example.test",
    "echo 'run --to''ken public'",
    "printf '%s' '--header=public'",
    "run --output 'safe'path; echo ready",
    "curl 'https://example.test?pa''ge=2&mode=safe'",
    String.raw`curl https://example.test?pa\ge=2`,
  ])("preserves safe literal syntax: %s", (command) => {
    expect(redactText(command)).toBe(command);
  });

  it("retains the original option syntax and following safe commands", () => {
    expect(redactText("run --to''ken 'short'canary --format json; echo ready")).toBe(
      "run --to''ken [REDACTED] --format json; echo ready",
    );
    expect(
      redactText("curl --h''eader 'Author''ization: shortcanary' https://example.test; echo ready"),
    ).toBe("curl --h''eader [REDACTED] https://example.test; echo ready");
  });

  it("hides an uncertain credential through the end instead of guessing its boundary", () => {
    expect(redactText("run --to''ken $(printf shortcanary); echo hidden")).toBe(
      "run --to''ken [REDACTED]",
    );
  });

  it("keeps user markers separate from protected URL words and nested scripts", () => {
    for (const command of [
      "echo \ue0000\ue000; curl 'https://example.test?to''ken=shortcanary&mode=\ue0001\ue000'; echo ready",
      "echo \ue0000\ue000; sh -c \"curl --h''eader 'Author''ization: shortcanary' https://example.test\"; echo ready",
    ]) {
      const output = redactText(command);
      expect(output).toContain("echo \ue0000\ue000;");
      expect(output).toContain("[REDACTED]");
      expect(output).toContain("echo ready");
      expect(output).not.toContain("shortcanary");
    }
  });

  it("keeps every hook and command credential out of real Context and MCP output", async () => {
    const f = contextFixture();
    fixtures.push(f);
    const hooks = credentialCommands.map((command) => ({ type: "command", command }));
    for (const [offset, layer] of ["user", "project"].entries()) {
      const settings = JSON.stringify({
        hooks: { SessionStart: [{ hooks: hooks.slice(offset * 20, (offset + 1) * 20) }] },
      });
      if (layer === "user") f.user("settings.json", settings);
      else f.write(".claude/settings.json", settings);
    }
    f.write(
      ".claude/commands/check.md",
      `---\ndescription: ${JSON.stringify(credentialCommands[0])}\n---\nPublic body.\n`,
    );
    const preview = await f.request();
    expect(
      preview.sections.find((section) => section.source === "Claude Code hooks")?.content,
    ).toContain("[REDACTED]");
    for (const result of [preview, await f.mcp(), await f.mcp(f.project, "codex")]) {
      const output = JSON.stringify(result);
      expect(output).not.toContain("shortcanary");
      expect(output).not.toContain("short\\\\canary");
    }
    const mcp = await f.mcp();
    const settings = mcp.sections.find((section) => section.scope === "settings")?.content;
    expect(settings).toContain("commands hidden");
    expect(settings).not.toContain("--h''eader");
    expect(mcp.sections.some((section) => section.source === "Claude Code hooks")).toBe(false);
    expect(
      mcp.sections.find((section) => section.source === "Claude Code commands")?.content,
    ).toContain("[REDACTED]");
  });
});
