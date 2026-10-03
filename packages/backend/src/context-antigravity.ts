import path from "node:path";
import { lstatSync, statSync } from "node:fs";
import { isFile, readText } from "./files";
import { entries, lines, readContext, FILE_CHARS } from "./context-files";
import { ruleFiles } from "./context-sources";
import { userHome } from "./mcp-config-read";
interface Plugin {
  name: string;
  root: string;
  disabled: boolean;
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function manifest(root: string, cli: boolean): Plugin {
  const file = path.join(root, "plugin.json");
  let metadata;
  try {
    metadata = statSync(file);
  } catch {
    throw new Error("plugin.json is required");
  }
  if (!metadata.isFile() || metadata.size > FILE_CHARS * 4)
    throw new Error("plugin.json must be a bounded regular file");
  let value: unknown;
  try {
    value = JSON.parse(readText(file, FILE_CHARS * 4, false));
  } catch {
    throw new Error("plugin.json is not valid JSON");
  }
  const record = object(value);
  if (!record) throw new Error("plugin.json must be an object");
  if (
    Object.keys(record).some(
      (key) => !["$schema", "name", "description", ...(cli ? ["disabled"] : [])].includes(key),
    )
  )
    throw new Error("plugin.json contains fields outside the published schema");
  for (const key of ["$schema", "description"])
    if (key in record && typeof record[key] !== "string")
      throw new Error("plugin.json metadata fields must be strings");
  if ("disabled" in record && typeof record.disabled !== "boolean")
    throw new Error("plugin disabled must be a boolean");
  if ("name" in record && typeof record.name !== "string")
    throw new Error("plugin name must be a string");
  if (cli && !("name" in record)) throw new Error("plugin name is required for CLI staged plugins");
  const name = "name" in record ? String(record.name) : path.basename(root);
  if (!/^[a-zA-Z0-9_-]+$/.test(name))
    throw new Error("plugin name does not match ^[a-zA-Z0-9-_]+$");
  return { root, name, disabled: record.disabled === true };
}
function discover(root: string, cli: boolean, warnings: string[]): Plugin[] {
  return entries(root)
    .filter((file) => {
      try {
        return lstatSync(file).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .flatMap((root) => {
      try {
        return [manifest(root, cli)];
      } catch (error) {
        warnings.push(
          `Invalid Antigravity plugin manifest; rules were excluded: ${root} (${(error as Error).message})`,
        );
        return [];
      }
    });
}
function overrides(file: string): Map<string, boolean | null> {
  let metadata;
  try {
    metadata = statSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw new Error("config.json metadata could not be read");
  }
  if (!metadata.isFile() || metadata.size > FILE_CHARS * 4)
    throw new Error("config.json must be a bounded regular file");
  let value: unknown;
  try {
    value = JSON.parse(readText(file, FILE_CHARS * 4, false));
  } catch {
    throw new Error("config.json is not valid JSON");
  }
  const record = object(value);
  if (!record) throw new Error("config.json must be an object");
  if (!("plugins" in record)) return new Map();
  const plugins = object(record.plugins);
  if (!plugins) throw new Error("config.json plugins must be an object");
  return new Map(
    Object.entries(plugins).map(([name, value]) => {
      const state = object(value);
      return [name, typeof state?.enabled === "boolean" ? state.enabled : null];
    }),
  );
}
function staged(root: string, config: string, warnings: string[]): Plugin[] {
  const plugins = discover(root, true, warnings);
  if (!plugins.length) return [];
  let states: Map<string, boolean | null>;
  try {
    states = overrides(config);
  } catch (error) {
    warnings.push(
      `Antigravity CLI plugin overrides could not be verified; staged rules were excluded: ${config} (${(error as Error).message})`,
    );
    return [];
  }
  return plugins.filter((plugin) => {
    const name = path.basename(plugin.root),
      enabled = states.has(name) ? states.get(name) : !plugin.disabled;
    if (enabled === true) return true;
    warnings.push(
      enabled === false
        ? `Antigravity CLI staged plugin is disabled; its rules were excluded: ${plugin.root}`
        : `Antigravity CLI staged plugin override is malformed; its rules were excluded: ${plugin.root}`,
    );
    return false;
  });
}
function activation(file: string): "always" | "conditional" | "unknown" {
  let content: string[];
  try {
    content = lines(readContext(file).content);
  } catch {
    return "unknown";
  }
  if (content.shift()?.trim() !== "---") return "always";
  let ended = false,
    active: "always" | "conditional" | "unknown" | null = null;
  for (const line of content) {
    if (line.trim() === "---") {
      ended = true;
      break;
    }
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase(),
      value = line
        .slice(colon + 1)
        .trim()
        .replace(/^['"]+|['"]+$/g, "")
        .toLowerCase();
    let next: "always" | "conditional" | "unknown" | null = null;
    if (key === "trigger") {
      const mode = value.replace(/[- ]/g, "_");
      next = ["always", "always_on"].includes(mode)
        ? "always"
        : ["manual", "model_decision", "glob", "glob_pattern"].includes(mode)
          ? "conditional"
          : "unknown";
    } else if (key === "alwaysapply")
      next = value === "true" ? "always" : value === "false" ? "conditional" : "unknown";
    if (next !== null) active = active === null || active === next ? next : "unknown";
  }
  return ended ? (active ?? "always") : "unknown";
}
function collect(root: string, output: string[], warnings: string[], shadowed?: Set<string>): void {
  for (const file of ruleFiles(root)) {
    if (shadowed?.has(path.relative(root, file))) continue;
    const mode = activation(file);
    if (mode === "always") output.push(file);
    else
      warnings.push(
        mode === "conditional"
          ? `Antigravity rule is not always active and was excluded from effective context: ${file}`
          : `Antigravity rule activation could not be verified and was excluded from effective context: ${file}`,
      );
  }
}
export function antigravitySources(
  dirs: string[],
  warnings: string[],
  environment: NodeJS.ProcessEnv,
): string[] {
  const result: string[] = [],
    plugins: Plugin[] = [],
    home = path.join(userHome(environment), ".gemini"),
    cli = path.join(home, "antigravity-cli"),
    global = path.join(home, "GEMINI.md");
  if (isFile(global)) result.push(global);
  collect(path.join(cli, "rules"), result, warnings);
  plugins.push(
    ...discover(path.join(home, "config/plugins"), false, warnings),
    ...staged(path.join(cli, "plugins"), path.join(home, "config/config.json"), warnings),
    ...discover(path.join(dirs[0]!, ".agents/plugins"), false, warnings),
  );
  const names = new Map<string, Plugin[]>();
  for (const plugin of plugins) {
    const list = names.get(plugin.name) ?? [];
    list.push(plugin);
    names.set(plugin.name, list);
  }
  for (const [name, values] of [...names].sort(([a], [b]) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  )) {
    if (values.length !== 1) {
      warnings.push(`Antigravity plugin name is not unique and its rules were excluded: ${name}`);
      continue;
    }
    const plugin = values[0]!;
    if (isFile(path.join(plugin.root, "rules.json"))) {
      warnings.push(
        `Antigravity plugin rules.json cannot be verified and its rules were excluded: ${plugin.root}`,
      );
      continue;
    }
    result.push(...ruleFiles(path.join(plugin.root, "rules")));
  }
  for (const dir of dirs) {
    result.push(...["AGENTS.md", "GEMINI.md"].map((name) => path.join(dir, name)).filter(isFile));
    const current = path.join(dir, ".agents/rules");
    collect(current, result, warnings);
    collect(
      path.join(dir, ".agent/rules"),
      result,
      warnings,
      new Set(ruleFiles(current).map((file) => path.relative(current, file))),
    );
  }
  return result;
}
