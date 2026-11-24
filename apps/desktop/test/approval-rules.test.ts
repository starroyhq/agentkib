import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as files from "../../../packages/backend/src/files";
import { antigravityApprovalRules } from "../../../packages/backend/src/agents/antigravity/approval-rules";
import { claudeApprovalRules } from "../../../packages/backend/src/agents/claude/approval-rules";
import { codexApprovalRules } from "../../../packages/backend/src/agents/codex/approval-rules";
import { devinApprovalRules } from "../../../packages/backend/src/agents/devin/approval-rules";
import type { ApprovalRuleContext } from "../../../packages/backend/src/sessions/approval-rules";

const roots: string[] = [];

function fixture() {
  // macOS's temporary-directory path may use a /var symlink.
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agentkib-approval-rules-")));
  roots.push(home);
  const workspace = path.join(home, "test-workspace");
  const dataDir = path.join(home, "agentkib-data");
  mkdirSync(workspace);
  mkdirSync(dataDir);
  const write = (file: string, content: string) => {
    const target = path.join(home, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    return target;
  };
  const allowed = (file: string, ...allow: string[]) =>
    write(file, JSON.stringify({ permissions: { allow, deny: ["never-exported"] } }));
  const context: ApprovalRuleContext = {
    home,
    dataDir,
    authorizeWrite: vi.fn(async () => {}),
  };
  return { home, workspace, dataDir, write, allowed, context };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native automatic allow rules", () => {
  it("separates readable Claude user, project, local, and managed file layers", async () => {
    const f = fixture();
    f.allowed("claude-override/settings.json", "Bash(git status)");
    f.allowed("test-workspace/.claude/settings.json", "Read(src/**)");
    f.allowed("test-workspace/.claude/settings.local.json", "Bash(npm run test)");
    f.allowed("policy/managed-settings.json", "Read(docs/**)");
    f.allowed("policy/managed-settings.d/10-team.json", "Read(tests/**)");
    const context = {
      ...f.context,
      env: { CLAUDE_CONFIG_DIR: path.join(f.home, "claude-override") },
      managedDir: path.join(f.home, "policy"),
    };
    const global = await claudeApprovalRules.list(context);
    expect(global).toMatchObject([
      {
        scope: "global",
        source: "managed-settings.json",
        content: "Read(docs/**)",
        revocable: false,
      },
      {
        scope: "global",
        source: "managed-settings.d/10-team.json",
        content: "Read(tests/**)",
        revocable: false,
      },
      {
        scope: "global",
        source: "CLAUDE_CONFIG_DIR/settings.json",
        content: "Bash(git status)",
        revocable: true,
      },
    ]);
    await expect(claudeApprovalRules.revoke(context, global[0]!.id)).rejects.toThrow(
      "approval-rule-read-only",
    );
    const project = await claudeApprovalRules.list({ ...context, workspace: f.workspace });
    expect(project).toMatchObject([
      {
        scope: "project",
        source: ".claude/settings.json",
        content: "Read(src/**)",
        revocable: true,
      },
      {
        scope: "project",
        source: ".claude/settings.local.json",
        content: "Bash(npm run test)",
        revocable: true,
      },
    ]);
    expect(JSON.stringify({ global, project })).not.toContain("never-exported");
  });

  it("redacts arguments without accepting redacted text as a rule identity", async () => {
    const f = fixture();
    const file = f.allowed(
      ".claude/settings.json",
      "Bash(tool run --token first-test-canary)",
      "Bash(tool run --token second-test-canary)",
    );
    const rules = await claudeApprovalRules.list(f.context);
    expect(rules).toHaveLength(2);
    for (const rule of rules) expect(rule.content).toContain("[REDACTED]");
    expect(JSON.stringify(rules)).not.toContain("test-canary");
    expect(rules[0]!.id).not.toBe(rules[1]!.id);
    await claudeApprovalRules.revoke(f.context, rules[0]!.id);
    expect(JSON.parse(readFileSync(file, "utf8")).permissions.allow).toEqual([
      "Bash(tool run --token second-test-canary)",
    ]);
  });

  it("does not treat a global Claude or Codex source as a workspace source", async () => {
    const f = fixture();
    f.allowed(".claude/settings.json", "Read(private/**)");
    f.write(".codex/rules/default.rules", 'prefix_rule(pattern=["git", "status"])');
    const context = { ...f.context, workspace: f.home, includeGlobal: false };
    await expect(claudeApprovalRules.list(context)).resolves.toEqual([]);
    await expect(codexApprovalRules.list(context)).resolves.toEqual([]);
  });

  it("does not follow a workspace setting symlink or hard link", async () => {
    const f = fixture();
    const privateFile = f.allowed("private/settings.json", "Read(private/**)");
    const workspaceConfig = path.join(f.workspace, ".claude");
    mkdirSync(workspaceConfig);
    // Windows may require elevated privileges to create a symlink. Hard links still exercise
    // the boundary in its normal test environment.
    if (process.platform !== "win32")
      symlinkSync(privateFile, path.join(workspaceConfig, "settings.json"));
    linkSync(privateFile, path.join(workspaceConfig, "settings.local.json"));
    await expect(
      claudeApprovalRules.list({ ...f.context, workspace: f.workspace }),
    ).resolves.toEqual([]);
  });

  it("lists documented literal Codex allow rules without interpreting policy code", async () => {
    const f = fixture();
    f.write(
      ".codex/rules/default.rules",
      '# Codex emits one call per approval\nprefix_rule(pattern=["git", "status"], decision="allow")\n' +
        'prefix_rule(pattern=["npm", ["run", "test"]], match=[["npm", "test"]])\n' +
        'prefix_rule(pattern=["curl"], decision="prompt")\n' +
        'prefix_rule(pattern=["sudo"], decision="forbidden")\n' +
        'prefix_rule(pattern=["tool", "--token", "codex-test-canary"], decision="allow")\n',
    );
    f.write(".codex/rules/unhandled.rules", "prefix_rule(pattern=custom_pattern)\n");
    f.write("test-workspace/.codex/rules/project.rules", 'prefix_rule(pattern=["pnpm", "test"])');
    const global = await codexApprovalRules.list(f.context);
    expect(global).toMatchObject([
      {
        scope: "global",
        source: "~/.codex/rules/default.rules",
        content: "git status",
        revocable: false,
      },
      { scope: "global", content: "npm (run | test)", revocable: false },
      { scope: "global", content: expect.stringContaining("[REDACTED]"), revocable: false },
    ]);
    expect(JSON.stringify(global)).not.toContain("codex-test-canary");
    expect(codexApprovalRules.revoke).toBeUndefined();
    await expect(
      codexApprovalRules.list({ ...f.context, workspace: f.workspace }),
    ).resolves.toMatchObject([
      {
        scope: "project",
        source: ".codex/rules/project.rules",
        content: "pnpm test",
        revocable: false,
      },
    ]);
  });

  it("reads Devin JSONC allow lists and the Antigravity CLI global allow list", async () => {
    const f = fixture();
    const devinGlobal =
      process.platform === "win32"
        ? "AppData/Roaming/devin/config.json"
        : ".config/devin/config.json";
    f.write(devinGlobal, '// kept by Devin\n{"permissions":{"allow":["Exec(git)"],},}');
    f.allowed("test-workspace/.devin/config.json", "Exec(npm run)");
    f.allowed("test-workspace/.devin/config.local.json", "Read(src/**)");
    f.allowed(".gemini/antigravity-cli/settings.json", "command(git status)");
    await expect(devinApprovalRules.list(f.context)).resolves.toMatchObject([
      { scope: "global", content: "Exec(git)", revocable: false },
    ]);
    await expect(
      devinApprovalRules.list({ ...f.context, workspace: f.workspace }),
    ).resolves.toMatchObject([
      {
        scope: "project",
        source: ".devin/config.json",
        content: "Exec(npm run)",
        revocable: false,
      },
      {
        scope: "project",
        source: ".devin/config.local.json",
        content: "Read(src/**)",
        revocable: false,
      },
    ]);
    await expect(antigravityApprovalRules.list(f.context)).resolves.toMatchObject([
      {
        scope: "global",
        source: "~/.gemini/antigravity-cli/settings.json",
        content: "command(git status)",
        revocable: false,
      },
    ]);
    expect(devinApprovalRules.revoke).toBeUndefined();
    expect(antigravityApprovalRules.revoke).toBeUndefined();
  });
});

describe("revoking a Claude rule", () => {
  it("backs up the exact config and changes only the intended allow array", async () => {
    const f = fixture();
    const before =
      '{\n  "other": {"allow":["outside"],"number":9007199254740993},\n' +
      '  "permissions":{"allow":["Bash(git status)", "Read(src/**)", "Bash(git status)"],"deny":["Write(*)"]}\n}\n';
    const file = f.write("test-workspace/.claude/settings.local.json", before);
    const context = { ...f.context, workspace: f.workspace };
    const [target] = await claudeApprovalRules.list(context);
    await claudeApprovalRules.revoke(context, target!.id);
    expect(context.authorizeWrite).toHaveBeenCalledOnce();
    expect(readFileSync(file, "utf8")).toBe(
      before.replace(
        '["Bash(git status)", "Read(src/**)", "Bash(git status)"]',
        '["Read(src/**)"]',
      ),
    );
    await expect(claudeApprovalRules.list(context)).resolves.toMatchObject([
      { content: "Read(src/**)" },
    ]);
    const backup = path.join(f.dataDir, "approval-rule-backups");
    expect(readFileSync(path.join(backup, readdirSync(backup)[0]!, "0.bak"), "utf8")).toBe(before);
    await expect(claudeApprovalRules.revoke(context, target!.id)).rejects.toThrow(
      "approval-rule-stale",
    );
  });

  it("lists unusual or ambiguous settings files without exposing a write", async () => {
    const f = fixture();
    const global = f.write(
      ".claude/settings.json",
      '\ufeff{"permissions":{"allow":["Bash(git status)"]}}',
    );
    const project = f.write(
      "test-workspace/.claude/settings.json",
      '{"permissions":{"allow":["Bash(git status)"],"allow":["Read(src/**)"]}}',
    );
    for (const [context, file] of [
      [f.context, global],
      [{ ...f.context, workspace: f.workspace }, project],
    ] as const) {
      const before = readFileSync(file, "utf8");
      const [rule] = await claudeApprovalRules.list(context);
      expect(rule?.revocable).toBe(false);
      await expect(claudeApprovalRules.revoke(context, rule!.id)).rejects.toThrow(
        "approval-rule-read-only",
      );
      expect(readFileSync(file, "utf8")).toBe(before);
    }
    expect(f.context.authorizeWrite).not.toHaveBeenCalled();
    expect(readdirSync(f.dataDir)).toEqual([]);
  });

  it("leaves host edits untouched and writes nothing if authorization is lost", async () => {
    const f = fixture();
    const file = f.allowed(".claude/settings.json", "Bash(git status)");
    const before = readFileSync(file, "utf8");
    const [rule] = await claudeApprovalRules.list(f.context);
    const refuse = {
      ...f.context,
      authorizeWrite: async () => {
        throw new Error("device-revoked");
      },
    };
    await expect(claudeApprovalRules.revoke(refuse, rule!.id)).rejects.toThrow("device-revoked");
    expect(readFileSync(file, "utf8")).toBe(before);
    const updated = before.replace("never-exported", "new-external-value");
    await expect(
      claudeApprovalRules.revoke(
        {
          ...f.context,
          authorizeWrite: async () => writeFileSync(file, updated),
        },
        rule!.id,
      ),
    ).rejects.toThrow("approval-rule-stale");
    expect(readFileSync(file, "utf8")).toBe(updated);
    expect(readdirSync(f.dataDir)).toEqual([]);
  });

  it("rolls back to the exact original if the guarded write fails validation", async () => {
    const f = fixture();
    const file = f.allowed(".claude/settings.json", "Bash(git status)");
    const before = readFileSync(file, "utf8");
    const [rule] = await claudeApprovalRules.list(f.context);
    const read = files.readText;
    const spy = vi.spyOn(files, "readText").mockImplementation((target, limit, regular) => {
      if (target === file && regular === false) throw new Error("fake native readback failure");
      return read(target, limit, regular);
    });
    await expect(claudeApprovalRules.revoke(f.context, rule!.id)).rejects.toThrow(
      "approval-rule-write-unconfirmed",
    );
    expect(spy).toHaveBeenCalledWith(file, Infinity, false);
    expect(readFileSync(file, "utf8")).toBe(before);
    const backup = path.join(f.dataDir, "approval-rule-backups");
    expect(readFileSync(path.join(backup, readdirSync(backup)[0]!, "0.bak"), "utf8")).toBe(before);
  });
});
