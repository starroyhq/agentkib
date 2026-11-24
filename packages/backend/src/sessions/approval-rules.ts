import { createHmac, randomBytes } from "node:crypto";
import { lstatSync, opendirSync } from "node:fs";
import path from "node:path";
import type { ApprovalRule } from "@agentkib/runtime-protocol";
import { redactText } from "../agents/claude/claude-settings";
import { isNetworkOrDevicePath, pathKey } from "../context-claude-sources";
import { readText, safeAncestors } from "../files";
import { userHome } from "../mcp-config-read";

export type ApprovalRuleContext = {
  /** Canonical, authorized workspace supplied by the host. */
  workspace?: string;
  includeGlobal?: boolean;
  home?: string;
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
  /** Recheck current access immediately before the synchronous native change. */
  authorizeWrite?: () => Promise<void>;
};

type Rule = Omit<ApprovalRule, "agent">;
export type ApprovalRulesProvider = {
  list(context: ApprovalRuleContext): Promise<Rule[]>;
  revoke?(context: ApprovalRuleContext, id: string): Promise<void>;
};

export type ApprovalRuleSource = {
  file: string;
  label: string;
  scope: "global" | "project";
};

const MAX_BYTES = 256 * 1024;
const MAX_RULES_PER_SOURCE = 128;
const MAX_RULE_LENGTH = 4_096;
const MAX_DIRECTORY_ENTRIES = 128;
const MAX_SOURCE_FILES = 32;
const idKey = randomBytes(32);

export function approvalRuleEnvironment(context: ApprovalRuleContext): NodeJS.ProcessEnv {
  return context.env ?? (context.home === undefined ? process.env : {});
}

export function approvalRuleHome(context: ApprovalRuleContext): string {
  return context.home ?? userHome(approvalRuleEnvironment(context));
}

export function isSafeRulePath(file: string): boolean {
  return (
    path.isAbsolute(file) &&
    !file.includes("\0") &&
    !isNetworkOrDevicePath(file, process.platform) &&
    safeAncestors(file, path.parse(file).root)
  );
}

export function readRuleSource(file: string): string | undefined {
  try {
    if (!isSafeRulePath(file)) return;
    const metadata = lstatSync(file);
    // A hard link could make a host-global rule visible as a workspace rule.
    if (!metadata.isFile() || metadata.nlink !== 1) return;
    return readText(file, MAX_BYTES);
  } catch {
    // Missing, unsupported or unsafe sources make no claim about the effective native policy.
    return;
  }
}

export function ruleSourceNames(directory: string, extension: string): string[] {
  if (!isSafeRulePath(directory)) return [];
  try {
    const handle = opendirSync(directory);
    try {
      const names: string[] = [];
      for (let i = 0; i < MAX_DIRECTORY_ENTRIES; i++) {
        const item = handle.readSync();
        if (!item) break;
        if (item.isFile() && !item.name.startsWith(".") && item.name.endsWith(extension))
          names.push(item.name);
      }
      return names.sort().slice(0, MAX_SOURCE_FILES);
    } finally {
      handle.closeSync();
    }
  } catch {
    return [];
  }
}

export function readGlobalRules(context: ApprovalRuleContext): boolean {
  return context.includeGlobal ?? context.workspace === undefined;
}

export function sameRulePath(a: string, b: string): boolean {
  return (
    pathKey(path.normalize(a), process.platform) === pathKey(path.normalize(b), process.platform)
  );
}

export function toApprovalRule(
  source: ApprovalRuleSource,
  nativeRule: string,
  revision?: string,
): Rule {
  return {
    id: createHmac("sha256", idKey)
      .update(JSON.stringify([source.file, source.scope, nativeRule, revision]))
      .digest("hex"),
    scope: source.scope,
    source: redactText(source.label, 200),
    content: redactText(nativeRule, 320),
    revocable: revision !== undefined,
  };
}

function recognizedRule(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_RULE_LENGTH;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseJsonAllowList(
  text: string,
  parse: (value: string) => unknown = JSON.parse,
): unknown[] | undefined {
  try {
    const json = text.replace(/^\ufeff/, "");
    const document = object(parse(json));
    const allow = object(document?.permissions)?.allow;
    return Array.isArray(allow) ? allow : undefined;
  } catch {
    return;
  }
}

export function boundedRuleTexts(values: readonly unknown[]): string[] {
  return [...new Set(values.slice(0, MAX_RULES_PER_SOURCE).filter(recognizedRule))];
}

export function readJsonAllowLists<T extends ApprovalRuleSource>(
  sources: readonly T[],
  parse?: (value: string) => unknown,
): { source: T; original: string; allow: unknown[] }[] {
  return sources.flatMap((source) => {
    const original = readRuleSource(source.file);
    if (original === undefined) return [];
    const allow = parseJsonAllowList(original, parse);
    return allow ? [{ source, original, allow }] : [];
  });
}

export function listJsonAllowRules(
  sources: readonly ApprovalRuleSource[],
  parse?: (value: string) => unknown,
): Rule[] {
  return readJsonAllowLists(sources, parse).flatMap(({ source, allow }) =>
    boundedRuleTexts(allow).map((rule) => toApprovalRule(source, rule)),
  );
}
