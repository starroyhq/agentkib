import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const requireWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { parseAst } = await import(pathToFileURL(requireWeb.resolve("vite")));

const sharedSessionUi = "packages/session-ui/src";
const roots = [
  sharedSessionUi,
  "apps/web/src/features/conversation",
  "apps/web/src/features/sessions",
  "apps/desktop/src/features/sessions",
];

// Baseline: origin/main at e77efe196. One hit per source line, including usages in each copy.
// This is a syntactic budget outside the Agent registry, independent of the 137 review items.
const maximum = { files: 94, lines: 1132 };
const agentIds = new Set(["claude-code", "codex", "deepseek-harness", "devin", "antigravity"]);
const agentNames = new Set(["Claude Code", "Codex", "DeepSeek Harness", "Devin", "Antigravity"]);
const agentMembers = new Set(["claude", "codex", "dsh", "deepseek", "devin", "antigravity"]);
const agentPredicates = new Set([
  "isLiveSessionAgent",
  "isReadStateProvider",
  "isSessionProviderAgent",
  "managedAgentOf",
]);
const namedAgent = /^(?:claude|codex|dsh|deepseek(?:-harness)?|devin|antigravity)(?:-|\/)/;
const namedSymbol =
  /^(?:claude|codex|dsh|devin|antigravity)(?=[A-Z])|(?:Claude|Codex|DSH|Dsh|DeepSeek(?:Harness)?|Devin|Antigravity)(?:$|[A-Z])/;
const modes = new Set(["managed-resume", "acp-managed"]);

function sourcePaths(root) {
  const directory = join(repo, root);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => {
      const path = relative(directory, file);
      const segments = path.split(sep);
      return (
        !/\.(?:test|spec)\.tsx?$/.test(path) &&
        !segments.includes("__tests__") &&
        !(root === sharedSessionUi && segments[0] === "agents")
      );
    });
}

function matches(node, parent) {
  if (node.type === "Identifier" || node.type === "JSXIdentifier") {
    return (
      node.name === "executionMode" ||
      agentPredicates.has(node.name) ||
      namedSymbol.test(node.name) ||
      (agentMembers.has(node.name) &&
        ((parent?.type === "MemberExpression" && parent.property === node) ||
          (parent?.type === "Property" && parent.key === node)))
    );
  }
  if (node.type === "TemplateElement") return namedAgent.test(node.value.cooked ?? "");
  if (node.type !== "Literal" || typeof node.value !== "string") return false;
  const value = node.value;
  if (agentIds.has(value) || modes.has(value)) return true;
  if (agentNames.has(value)) {
    return parent?.type === "ConditionalExpression" || parent?.type === "CallExpression";
  }
  if (value.startsWith(".") && namedAgent.test(basename(value))) return true;
  if (parent?.type === "Property" && parent.key === node && !parent.computed) return false;
  return (
    (namedAgent.test(value) && /^[a-z0-9_./:-]+$/.test(value)) ||
    (value.startsWith("agentkib:") && namedAgent.test(value.slice("agentkib:".length)))
  );
}

// Keep TypeScript nodes that still wrap or declare runtime values.
const runtimeTypeScriptNodes = new Set([
  "TSAsExpression",
  "TSEnumBody",
  "TSEnumDeclaration",
  "TSEnumMember",
  "TSInstantiationExpression",
  "TSNonNullExpression",
  "TSParameterProperty",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

function matchingLines(file) {
  const source = readFileSync(file, "utf8");
  const lang = file.endsWith(".tsx") ? "tsx" : "ts";
  const lines = new Set();
  // A named module counts once even when its implementation contains no other branded token.
  if (namedAgent.test(basename(file))) lines.add(1);
  const visit = (node, parent) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type.startsWith("TS") && !runtimeTypeScriptNodes.has(node.type)) return;
    if (node.importKind === "type" || node.exportKind === "type") return;
    if (matches(node, parent)) lines.add(source.slice(0, node.start).split("\n").length);
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach((item) => visit(item, node));
      else if (child && typeof child === "object") visit(child, node);
    }
  };
  visit(parseAst(source, { lang }, file));
  return lines;
}

test("session UI Agent-specific references stay within the existing budget", () => {
  const matched = roots
    .flatMap(sourcePaths)
    .sort()
    .flatMap((file) => {
      const lines = [...matchingLines(file)].sort((a, b) => a - b);
      return lines.length ? [{ path: relative(repo, file), lines }] : [];
    });
  const lines = matched.reduce((sum, match) => sum + match.lines.length, 0);
  assert.ok(
    lines <= maximum.lines && matched.length <= maximum.files,
    `Found ${matched.length} files and ${lines} matching lines; upper bounds are ` +
      `${maximum.files} files and ${maximum.lines} lines.\n` +
      matched.map((match) => `${match.path}: ${match.lines.join(", ")}`).join("\n"),
  );
});
