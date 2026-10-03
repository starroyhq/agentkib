import path from "node:path";
import { lstatSync, statSync } from "node:fs";
import { parse as toml } from "smol-toml";
import { Commands } from "./commands";
import { canonicalize, isDirectory } from "./paths";
import { isFile, readText, within, withinLexical } from "./files";
import {
  append,
  budgetWarning,
  decodePrefix,
  entries,
  lines,
  prefix,
  readContext,
  TOTAL_CHARS,
  type Budget,
} from "./context-files";
import { userHome } from "./mcp-config-read";
export interface Section {
  source: string;
  scope: string;
  content: string;
  precedence: number;
}
function canonical(value: string): string | null {
  try {
    return canonicalize(value);
  } catch {
    return null;
  }
}
export function deepseekRoot(root: string, cwd: string): string {
  for (let current = cwd; ; current = path.dirname(current)) {
    try {
      statSync(path.join(current, ".git"));
      return current;
    } catch {}
    if (
      current === root ||
      path.dirname(current) === current ||
      !within(path.dirname(current), root)
    )
      return cwd;
  }
}
export function deepseekSkills(root: string, environment: NodeJS.ProcessEnv): string[] {
  const home = userHome(environment),
    dsh = environment.DSH_HOME ?? path.join(home, ".dsh"),
    names = new Set<string>();
  for (const directory of [
    path.join(root, ".dsh/skills"),
    path.join(root, ".agents/skills"),
    path.join(dsh, "skills"),
    path.join(home, ".agents/skills"),
  ])
    for (const file of entries(directory))
      if (
        (isDirectory(file) && isFile(path.join(file, "SKILL.md"))) ||
        path.extname(file) === ".md"
      )
        names.add(path.basename(file, path.extname(file)));
  return [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}
export function deepseekSections(
  root: string,
  dirs: string[],
  warnings: string[],
  environment: NodeJS.ProcessEnv,
): Section[] {
  const output: Section[] = [],
    home = environment.DSH_HOME ?? path.join(userHome(environment), ".dsh");
  let remaining = 65536;
  const push = (file: string, scope: string, content: string) => {
    if (!remaining) {
      warnings.push("DeepSeek Harness instruction budget of 64 KiB was exhausted");
      return;
    }
    const bytes = Buffer.from(content),
      take = Math.min(bytes.length, remaining);
    let end = take;
    while (end > 0 && end < bytes.length && (bytes[end]! & 192) === 128) end--;
    output.push({
      source: file,
      scope,
      content: bytes.subarray(0, end).toString("utf8"),
      precedence: output.length,
    });
    remaining -= end;
    if (end < bytes.length)
      warnings.push(`DeepSeek Harness instruction budget of 64 KiB truncated ${file}`);
  };
  const read = (file: string): string | null => {
    let metadata;
    try {
      metadata = statSync(file);
    } catch {
      return null;
    }
    if (!metadata.isFile()) return null;
    if (metadata.size > 1024 * 1024) {
      warnings.push(`DeepSeek Harness instruction file exceeds 1 MiB and was skipped: ${file}`);
      return null;
    }
    try {
      return readText(file, 1024 * 1024, false);
    } catch {
      warnings.push(`Could not read ${file}`);
      return null;
    }
  };
  const global = path.join(home, "AGENTS.md"),
    content = read(global);
  if (content !== null) push(global, "agent-home", content);
  if (
    [
      path.join(home, "cordis.patch.yml"),
      ...entries(path.join(home, "profiles")).map((file) => path.join(file, "cordis.patch.yml")),
    ].some((file) => {
      try {
        const { content } = readContext(file);
        return content.includes("agent-instructions") || content.includes("skill-filesystem");
      } catch {
        return false;
      }
    })
  )
    warnings.push(
      "DeepSeek Harness custom instruction or Skill loading rules were detected; this preview uses the public default rules",
    );
  for (const dir of dirs) {
    const seen = new Set<string>();
    for (const name of ["AGENTS.md", "CLAUDE.md", "AGENTS.local.md", "CLAUDE.local.md"]) {
      const file = path.join(dir, name),
        content = read(file);
      if (content === null || seen.has(content.trim())) continue;
      seen.add(content.trim());
      if (name === "CLAUDE.md" && lines(content).some((line) => line.trim() === "@AGENTS.md"))
        warnings.push(
          "DeepSeek Harness reads @AGENTS.md in CLAUDE.md as literal text, not as a Claude Code import",
        );
      push(file, path.relative(root, dir), content);
    }
  }
  return output;
}
const GENERIC = ["Agents.md", "Claude.md", "CLAUDE.md", "CLAUDE.local.md", "AGENT.md", "AGENTS.md"];
export async function grokSections(
  root: string,
  dirs: string[],
  warnings: string[],
  environment: NodeJS.ProcessEnv,
  commands: Commands,
): Promise<Section[]> {
  const user = userHome(environment),
    home = environment.GROK_HOME ?? path.join(user, ".grok");
  const config = (file: string): Record<string, unknown> => {
    try {
      return toml(readText(file, 1024 * 1024, false)) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const global = config(path.join(home, "config.toml")),
    project = config(path.join(root, ".grok/config.toml"));
  const configured = (
    value: Record<string, unknown>,
    vendor: string,
    surface: string,
  ): boolean | undefined => {
    const compat = value.compat as Record<string, Record<string, unknown>> | undefined;
    return typeof compat?.[vendor]?.[surface] === "boolean"
      ? (compat[vendor]![surface] as boolean)
      : undefined;
  };
  const enabled = (vendor: string, surface: string) => {
    const value = environment[`GROK_${vendor.toUpperCase()}_${surface.toUpperCase()}_ENABLED`]
      ?.trim()
      .toLowerCase();
    const fromEnv =
      value && ["1", "true", "yes", "on", "0", "false", "no", "off"].includes(value)
        ? ["1", "true", "yes", "on"].includes(value)
        : undefined;
    return (
      fromEnv ?? configured(project, vendor, surface) ?? configured(global, vendor, surface) ?? true
    );
  };
  const claudeAgents = enabled("claude", "agents"),
    claudeRules = enabled("claude", "rules"),
    cursorAgents = enabled("cursor", "agents"),
    cursorRules = enabled("cursor", "rules"),
    trustedHome = canonical(home),
    trustedUser = canonical(user),
    sources: string[] = [];
  const safe = (base: string, file: string) => {
    try {
      return lstatSync(file).isFile() && withinLexical(canonicalize(file), base);
    } catch {
      return false;
    }
  };
  const ignored = async (gitRoot: string, files: string[]): Promise<Set<string>> => {
    if (!files.length) return new Set();
    try {
      const result = await commands.run("git", ["check-ignore", "--no-index", "-z", "--stdin"], {
        cwd: gitRoot,
        env: environment,
        allowFailure: true,
        input: Buffer.from(files.map((file) => file + "\0").join("")),
      });
      if ([0, 1].includes(result.exitCode ?? -1) && !result.truncated)
        return new Set(
          new TextDecoder("utf-8", { fatal: true })
            .decode(result.bytes)
            .split("\0")
            .filter(Boolean),
        );
    } catch {}
    const output = new Set<string>();
    for (const file of files)
      try {
        if (
          (
            await commands.run("git", ["check-ignore", "--quiet", "--no-index", "--", file], {
              cwd: gitRoot,
              env: environment,
              allowFailure: true,
            })
          ).success
        )
          output.add(file);
      } catch {}
    return output;
  };
  const collect = async (
    base: string,
    names: string[],
    rules: [string, boolean][],
    gitRoot: string | null,
  ) => {
    const named = names.map((name) => path.join(base, name)).filter((file) => safe(base, file));
    const excluded = gitRoot ? await ignored(gitRoot, named) : new Set();
    sources.push(...named.filter((file) => !excluded.has(file)));
    for (const [relative, mdc] of rules) {
      const directory = path.join(base, relative);
      try {
        if (!lstatSync(directory).isDirectory()) continue;
      } catch {
        continue;
      }
      const files = entries(directory)
        .filter(
          (file) =>
            /^\.md$/i.test(path.extname(file)) || (mdc && /^\.mdc$/i.test(path.extname(file))),
        )
        .filter((file) => safe(base, file));
      const excluded = gitRoot ? await ignored(gitRoot, files) : new Set();
      sources.push(
        ...files
          .filter((file) => !excluded.has(file))
          .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
      );
    }
  };
  if (trustedHome) await collect(trustedHome, GENERIC, [["rules", false]], null);
  if (trustedUser) {
    if (claudeAgents || claudeRules)
      await collect(
        path.join(trustedUser, ".claude"),
        claudeAgents ? GENERIC : [],
        claudeRules ? [["rules", false]] : [],
        null,
      );
    if (cursorAgents || cursorRules)
      await collect(
        path.join(trustedUser, ".cursor"),
        cursorAgents ? GENERIC : [],
        cursorRules ? [["rules", true]] : [],
        null,
      );
  }
  const names = [
      ...GENERIC,
      ...(claudeAgents ? [".claude/CLAUDE.md", ".claude/CLAUDE.local.md"] : []),
    ],
    rules: [string, boolean][] = [
      [".grok/rules", false],
      ...(claudeRules ? [[".claude/rules", false] as [string, boolean]] : []),
      ...(cursorRules ? [[".cursor/rules", true] as [string, boolean]] : []),
    ];
  for (const dir of dirs) await collect(dir, names, rules, root);
  const seen = new Set<string>(),
    output: Section[] = [],
    budget: Budget = { remaining: TOTAL_CHARS };
  for (const source of sources) {
    if (!budget.remaining) {
      budgetWarning(warnings);
      break;
    }
    const resolved = canonical(source);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    if (
      !withinLexical(resolved, root) &&
      !(trustedHome && withinLexical(resolved, trustedHome)) &&
      !(
        trustedUser &&
        (withinLexical(resolved, path.join(trustedUser, ".claude")) ||
          withinLexical(resolved, path.join(trustedUser, ".cursor")))
      )
    )
      continue;
    let content: string, truncated: boolean;
    try {
      const raw = decodePrefix(prefix(resolved, 40004, true), true),
        chars = [...raw];
      content = chars.slice(0, 10000).join("");
      truncated = chars.length > 10000;
    } catch {
      warnings.push(`Could not read ${source}`);
      continue;
    }
    if (path.basename(path.dirname(source)).toLowerCase() === "rules") {
      const rows = lines(content);
      if (rows.shift()?.trim() === "---") {
        const end = rows.findIndex((line) => line.trim() === "---");
        if (end >= 0) content = rows.slice(end + 1).join("\n");
      }
    }
    if (truncated)
      warnings.push(
        `Grok Build instruction file exceeds 10000 characters and was truncated for preview: ${source}`,
      );
    output.push({
      source,
      scope: withinLexical(path.dirname(source), root)
        ? path.relative(root, path.dirname(source))
        : "agent-home",
      content: append(content, budget, warnings),
      precedence: output.length,
    });
  }
  return output;
}
