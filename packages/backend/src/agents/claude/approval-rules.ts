import { randomUUID } from "node:crypto";
import path from "node:path";
import { applyChanges } from "../../change-apply";
import { hash } from "../../doctor-files";
import {
  approvalRuleEnvironment,
  approvalRuleHome,
  boundedRuleTexts,
  isSafeRulePath,
  parseJsonAllowList,
  readGlobalRules,
  readJsonAllowLists,
  readRuleSource,
  ruleSourceNames,
  sameRulePath,
  toApprovalRule,
  type ApprovalRuleContext,
  type ApprovalRuleSource,
  type ApprovalRulesProvider,
} from "../../sessions/approval-rules";
import { claudeConfigFiles, claudeManagedDir, resolveClaudeConfig } from "./claude-config";

type ClaudeApprovalRuleContext = ApprovalRuleContext & { managedDir?: string | null };
type Source = ApprovalRuleSource & { writable?: boolean };

type Token = { text: string; start: number; end: number };

function propertyValue(tokens: readonly Token[], objectAt: number, name: string): number {
  if (tokens[objectAt]?.text !== "{") return -1;
  let depth = 1;
  let found = -1;
  for (let i = objectAt + 1; depth > 0 && i < tokens.length; i++) {
    const text = tokens[i]!.text;
    if (depth === 1 && text.startsWith('"') && tokens[i + 1]?.text === ":") {
      if (JSON.parse(text) === name) {
        if (found !== -1) return -1;
        found = i + 2;
      }
    }
    if (text === "{" || text === "[") depth++;
    if (text === "}" || text === "]") depth--;
  }
  return found;
}

/** The document was already accepted by JSON.parse. Locate the unique allow list so we can
 * replace just its bytes, preserving other settings, whitespace and even number spellings. */
function allowRange(source: string): { start: number; end: number } | undefined {
  const tokens = Array.from(
    source.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\],:]|[^\s{}[\],:]+/g),
    (match) => ({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
    }),
  );
  const permissionsAt = propertyValue(tokens, 0, "permissions");
  const allowAt = propertyValue(tokens, permissionsAt, "allow");
  const first = tokens[allowAt];
  if (first?.text !== "[") return;
  // Callers restrict writable arrays to literal strings, so the next closing bracket ends it.
  const last = tokens.slice(allowAt + 1).find((token) => token.text === "]");
  if (last) return { start: first.start, end: last.end };
}

function claudeSources(context: ClaudeApprovalRuleContext): Source[] {
  const config = resolveClaudeConfig(approvalRuleEnvironment(context), approvalRuleHome(context));
  const userFile = claudeConfigFiles(config).settings;
  const sources: Source[] = [];
  if (readGlobalRules(context)) {
    const managed =
      context.managedDir === undefined
        ? context.home === undefined
          ? claudeManagedDir()
          : null
        : context.managedDir;
    if (managed) {
      sources.push({
        file: path.join(managed, "managed-settings.json"),
        label: "managed-settings.json",
        scope: "global",
      });
      const dropIns = path.join(managed, "managed-settings.d");
      for (const name of ruleSourceNames(dropIns, ".json"))
        sources.push({
          file: path.join(dropIns, name),
          label: "managed-settings.d/" + name,
          scope: "global",
        });
    }
    sources.push({
      file: userFile,
      label:
        config.overridden && !config.invalid
          ? "CLAUDE_CONFIG_DIR/settings.json"
          : "~/.claude/settings.json",
      scope: "global",
      writable: !config.invalid,
    });
  }
  if (context.workspace) {
    // Do not walk to a repository outside the authorized workspace, even for linked worktrees.
    for (const name of [".claude/settings.json", ".claude/settings.local.json"]) {
      const file = path.join(context.workspace, name);
      if (!sameRulePath(file, userFile))
        sources.push({ file, label: name, scope: "project", writable: true });
    }
  }
  return sources;
}

function claudeRuleEntries(context: ClaudeApprovalRuleContext) {
  return readJsonAllowLists(claudeSources(context)).flatMap(({ source, original, allow }) => {
    const range =
      source.writable &&
      !original.startsWith("\ufeff") &&
      allow.every((rule) => typeof rule === "string")
        ? allowRange(original)
        : undefined;
    const revision = range && hash(original);
    return boundedRuleTexts(allow).map((nativeRule) => ({
      rule: toApprovalRule(source, nativeRule, revision),
      source,
      original,
      nativeRule,
      allow,
      range,
    }));
  });
}

export const claudeApprovalRules = {
  async list(context: ClaudeApprovalRuleContext) {
    return claudeRuleEntries(context).map(({ rule }) => rule);
  },
  async revoke(context: ClaudeApprovalRuleContext, id: string) {
    const { dataDir, authorizeWrite } = context;
    if (!dataDir || !authorizeWrite) throw new Error("approval-rule-write-not-authorized");
    const entry = claudeRuleEntries(context).find(({ rule }) => rule.id === id);
    if (!entry) throw new Error("approval-rule-stale");
    if (!entry.range) throw new Error("approval-rule-read-only");
    const { original, range, source, nativeRule } = entry;
    const remaining = entry.allow.filter((value) => value !== nativeRule);
    const edited =
      original.slice(0, range.start) + JSON.stringify(remaining) + original.slice(range.end);
    // The indexed bytes must be the list we meant to change, never a matching key nested elsewhere.
    const changed = parseJsonAllowList(edited);
    if (JSON.stringify(changed) !== JSON.stringify(remaining))
      throw new Error("approval-rule-read-only");
    await authorizeWrite();
    const backupRoot = path.join(dataDir, "approval-rule-backups");
    if (!isSafeRulePath(backupRoot) || readRuleSource(source.file) !== original)
      throw new Error("approval-rule-stale");
    try {
      applyChanges(
        {
          id: randomUUID(),
          project_root: context.workspace ?? dataDir,
          created_at: new Date().toISOString(),
          requires_home_approval: source.scope === "global",
          changes: [
            {
              target: source.file,
              scope: source.scope === "global" ? "agent-home" : "project",
              original_hash: hash(original),
              before: original,
              after: edited,
              risk: "high",
              validator: "json",
            },
          ],
        },
        backupRoot,
        {
          approvedHome: source.scope === "global" ? [source.file] : [],
          protectedHome: [path.dirname(source.file)],
          approvedApplication: [],
          approveHome: source.scope === "global",
        },
      );
    } catch {
      // The shared transaction verifies the written bytes and retains the private backup if
      // another process has edited them. Its errors can include native paths and content.
      throw new Error("approval-rule-write-unconfirmed");
    }
  },
} satisfies ApprovalRulesProvider;
