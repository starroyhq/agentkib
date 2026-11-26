import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

// Use the parser already installed for the Web build and its session UI budget check.
const requireWeb = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { parseSync } = await import(pathToFileURL(requireWeb.resolve("vite")));

const baselinePath = "scripts/architecture-baseline.json";
const registryPath = "docs/development/compat-registry.md";
const maxProductLines = 1500;
const agentIds = new Set([
  "antigravity",
  "claude-code",
  "codex",
  "cursor",
  "deepseek-harness",
  "devin",
  "grok-build",
  "hermes",
  "open-claw",
  "opencode",
]);
const providerDeclaration = "packages/runtime-protocol/src/session-providers.ts";
const compatibilityMarker = /legacy|compat|fallback/i;
const typeScriptFile = /\.(?:[cm]?ts|tsx)$/;
const jsFamilyFile = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const workspaceSource = /^(?:apps|packages)\//;
const productSource = /\.(?:[cm]?[jt]s|[jt]sx|css|html|swift|py|sh|ps1|nsh)$/;
const comparison = new Set(["===", "!==", "==", "!="]);
const expressionWrappers = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

function agentLiteral(node) {
  while (expressionWrappers.has(node?.type)) node = node.expression;
  if (node?.type === "Literal") return agentIds.has(node.value);
  return (
    node?.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    agentIds.has(node.quasis[0].value.cooked)
  );
}

function walk(node, visit) {
  if (typeof node?.type !== "string") return;
  visit(node);
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) child.forEach((item) => walk(item, visit));
    else if (child && typeof child === "object") walk(child, visit);
  }
}

function physicalLines(source) {
  if (source === "") return 0;
  const lines = source.split(/\r\n|\n|\r/);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function productFile(file) {
  return (
    workspaceSource.test(file) &&
    productSource.test(file) &&
    !/(?:^|\/)(?:test|tests|__tests__|fixtures|__fixtures__|__mocks__)(?:\/|$)/.test(file) &&
    !/\.(?:test|spec)\./.test(file)
  );
}

function increment(markers, kind, text, position) {
  const key = `${kind}: ${text}`;
  if (!markers.has(key)) markers.set(key, []);
  markers.get(key).push(position);
}

export function scanSource(file, source) {
  const size = productFile(file) ? physicalLines(source) : 0;
  const agentJudgments = [];
  const markers = new Map();
  if (!jsFamilyFile.test(file)) return { size, agentJudgments, markers };

  const { program, comments, errors } = parseSync(file, source, { sourceType: "unambiguous" });
  if (errors.length) {
    throw new Error(`Could not parse ${file}: ${errors[0].message}`);
  }
  const countAgentJudgments =
    typeScriptFile.test(file) &&
    file !== providerDeclaration &&
    !file.split("/").includes("agents");
  const countMarkers = workspaceSource.test(file);
  const identifierPositions = new Set();
  walk(program, (node) => {
    if (
      countAgentJudgments &&
      ((node.type === "BinaryExpression" &&
        comparison.has(node.operator) &&
        (agentLiteral(node.left) || agentLiteral(node.right))) ||
        (node.type === "SwitchCase" && agentLiteral(node.test)))
    )
      agentJudgments.push(node.start);

    if (
      countMarkers &&
      (node.type === "Identifier" ||
        node.type === "JSXIdentifier" ||
        node.type === "PrivateIdentifier") &&
      compatibilityMarker.test(node.name) &&
      !identifierPositions.has(node.start)
    ) {
      identifierPositions.add(node.start);
      const name = node.type === "PrivateIdentifier" ? `#${node.name}` : node.name;
      increment(markers, "identifier", name, node.start);
    }
  });
  for (const comment of countMarkers ? comments : []) {
    // JSDoc prefixes and indentation do not identify a compatibility branch.
    let position = comment.start + 2; // Skip the opening // or /*.
    for (const line of comment.value.split("\n")) {
      const text = line
        .trim()
        .replace(/^\*\s*/, "")
        .replace(/\s+/g, " ");
      if (compatibilityMarker.test(text)) increment(markers, "comment", text, position);
      position += line.length + 1;
    }
  }
  return { size, agentJudgments, markers };
}

export function registryEntries(markdown) {
  // Other tables can track cross-repository decisions without registering local code.
  const table = markdown.split(/^## Tracked branches\s*$/m)[1]?.split(/^## /m)[0];
  if (!table) throw new Error("Missing Tracked branches section in the compatibility registry");
  const entries = new Map();
  for (const line of table.split(/\r?\n/)) {
    if (!line.startsWith("|") || /^\|\s*(?:(?:Path|代码位置)\s*\||[-:]+\s*\|)/.test(line)) continue;
    const row = /^\|\s*`([^`\s]+)`\s*\|\s*`([^`|]+)`\s*\|([^|]+)\|([^|]+)\|([^|]+)\|\s*$/.exec(
      line,
    );
    const fields = row?.slice(1).map((field) => field.trim());
    if (!fields?.every(Boolean) || !compatibilityMarker.test(fields[1]))
      throw new Error(`Invalid compatibility registry row: ${line}`);
    const [file, marker] = fields;
    if (!entries.has(file)) entries.set(file, new Set());
    if (entries.get(file).has(marker))
      throw new Error(`Duplicate compatibility entry: ${file} ${marker}`);
    entries.get(file).add(marker);
  }
  return entries;
}

function sortedEntries(entries) {
  return Object.fromEntries(
    [...entries].sort(([first], [second]) => (first === second ? 0 : first < second ? -1 : 1)),
  );
}

export function captureBaseline(files) {
  const agent = new Map(),
    large = new Map(),
    compatibility = new Map();
  for (const [file, { size, agentJudgments, markers }] of files) {
    if (agentJudgments.length) agent.set(file, agentJudgments.length);
    if (size > maxProductLines) large.set(file, size);
    if (markers.size)
      compatibility.set(file, sortedEntries([...markers].map(([key, hits]) => [key, hits.length])));
  }
  return {
    agent: sortedEntries(agent),
    large: sortedEntries(large),
    compatibility: sortedEntries(compatibility),
  };
}

export function tightenedBaseline(baseline, actual) {
  function tightenCounts(previous, current) {
    return Object.fromEntries(
      Object.entries(previous).flatMap(([key, limit]) =>
        current[key] ? [[key, Math.min(limit, current[key])]] : [],
      ),
    );
  }
  return {
    agent: tightenCounts(baseline.agent, actual.agent),
    large: tightenCounts(baseline.large, actual.large),
    compatibility: Object.fromEntries(
      Object.entries(baseline.compatibility).flatMap(([file, markers]) => {
        const remaining = tightenCounts(markers, actual.compatibility[file] ?? {});
        return Object.keys(remaining).length ? [[file, remaining]] : [];
      }),
    ),
  };
}

function resolvedLine(source, position) {
  return source.slice(0, position).split(/\r\n|\n|\r/).length;
}

export function violations(files, baseline, registry) {
  const errors = [];
  for (const [file, { source, size, agentJudgments, markers }] of files) {
    const agentLimit = baseline.agent[file] ?? 0;
    if (agentJudgments.length > agentLimit)
      errors.push(
        `${file}:${resolvedLine(source, agentJudgments[agentLimit])}: Agent name comparisons increased from ${agentLimit} to ${agentJudgments.length}. Use Provider capabilities.`,
      );
    const lineLimit = baseline.large[file] ?? maxProductLines;
    if (size > lineLimit)
      errors.push(`${file}: ${size} lines exceeds its ${lineLimit}-line budget.`);
    const registered = registry.get(file);
    for (const [key, positions] of markers) {
      const limit = baseline.compatibility[file]?.[key] ?? 0;
      if (positions.length <= limit) continue;
      const isComment = key.startsWith("comment: ");
      const text = key.slice(key.indexOf(": ") + 2);
      if (
        registered &&
        (isComment ? [...registered].some((entry) => text.includes(entry)) : registered.has(text))
      )
        continue;
      errors.push(
        `${file}:${resolvedLine(source, positions[limit])}: register ${key} in ${registryPath}.`,
      );
    }
  }
  return errors;
}

function scanFiles(sources) {
  return new Map(
    [...sources]
      .filter(([file]) => jsFamilyFile.test(file) || productFile(file))
      .map(([file, source]) => [file, { source, ...scanSource(file, source) }]),
  );
}

function git(root, args, options = {}) {
  return execFileSync("git", args, {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf8",
    ...options,
  });
}

function workingSources(root) {
  const names = new Set(
    git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0"),
  );
  const files = new Map();
  for (const file of names) {
    if (!jsFamilyFile.test(file) && !productFile(file)) continue;
    const path = join(root, file);
    if (lstatSync(path, { throwIfNoEntry: false })?.isFile())
      files.set(file, readFileSync(path, "utf8"));
  }
  return files;
}

export function revisionBaseline(root, ref) {
  const commit = git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
  const tree = git(root, ["ls-tree", "-r", "-z", commit])
    .split("\0")
    .flatMap((entry) => {
      const separator = entry.indexOf("\t");
      if (separator === -1 || !entry.startsWith("100")) return [];
      return [[entry.slice(0, separator).split(" ").at(-1), entry.slice(separator + 1)]];
    });
  const existing = tree.find(([, file]) => file === baselinePath);
  if (existing) return JSON.parse(git(root, ["cat-file", "blob", existing[0]]));

  // At adoption compare against the actual base tree, so the bootstrap cannot
  // bless product changes introduced by the same PR.
  const sources = tree.filter(([, file]) => jsFamilyFile.test(file) || productFile(file));
  const contents = git(root, ["cat-file", "--batch"], {
    input: Buffer.from(sources.map(([hash]) => hash).join("\n") + "\n"),
    encoding: "buffer",
  });
  let offset = 0;
  const files = new Map();
  for (const [hash, file] of sources) {
    const head = contents.indexOf(10, offset);
    const [found, type, bytes] = contents.toString("utf8", offset, head).split(" ");
    const size = Number(bytes);
    if (found !== hash || type !== "blob" || !Number.isSafeInteger(size))
      throw new Error(`Could not read base source: ${file}`);
    files.set(file, contents.toString("utf8", head + 1, head + 1 + size));
    offset = head + size + 2;
  }
  return captureBaseline(scanFiles(files));
}

export function validateBaseline(baseline) {
  if (!baseline || Object.keys(baseline).length !== 3)
    throw new Error("Architecture baseline must have exactly three sections");
  function counts(value, min) {
    return (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value).every((limit) => Number.isSafeInteger(limit) && limit >= min)
    );
  }
  if (
    !counts(baseline.agent, 1) ||
    !counts(baseline.large, maxProductLines + 1) ||
    !baseline.compatibility ||
    typeof baseline.compatibility !== "object" ||
    Array.isArray(baseline.compatibility) ||
    !Object.values(baseline.compatibility).every((value) => counts(value, 1))
  )
    throw new Error("Invalid architecture baseline counts");
}

function summarize(baseline) {
  const sum = (counts) => Object.values(counts).reduce((total, count) => total + count, 0);
  return [
    `Agent comparisons: ${sum(baseline.agent)} in ${Object.keys(baseline.agent).length} files`,
    `large product files: ${Object.keys(baseline.large).length}`,
    `compatibility markers: ${Object.values(baseline.compatibility).reduce((total, markers) => total + sum(markers), 0)} in ${Object.keys(baseline.compatibility).length} files`,
  ].join("; ");
}

function main() {
  const { values } = parseArgs({
    options: { tighten: { type: "boolean" }, base: { type: "string" } },
  });
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const path = join(root, baselinePath);
  const baseline = JSON.parse(readFileSync(path, "utf8"));
  validateBaseline(baseline);
  if (values.base !== undefined) {
    const trusted = revisionBaseline(root, values.base);
    validateBaseline(trusted);
    if (!isDeepStrictEqual(tightenedBaseline(baseline, trusted), baseline))
      throw new Error("Architecture baseline grew compared with the base commit.");
  }
  const files = scanFiles(workingSources(root));
  const errors = violations(
    files,
    baseline,
    registryEntries(readFileSync(join(root, registryPath), "utf8")),
  );
  if (errors.length) throw new Error(errors.join("\n"));
  const next = values.tighten ? tightenedBaseline(baseline, captureBaseline(files)) : baseline;
  if (values.tighten) writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
  console.log(`Architecture baseline — ${summarize(next)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
