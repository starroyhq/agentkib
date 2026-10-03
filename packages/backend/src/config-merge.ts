import path from "node:path";
import { lstatSync } from "node:fs";
import JSON5 from "json5";
import { parse as parseToml } from "smol-toml";
import { parseDocument, isMap, isSeq } from "yaml";
import { readText } from "./files";
import { MANAGED_START, MANAGED_END, managedContent } from "./default-manifest";
import type { Manifest } from "./manifest";
import type { Agent } from "./doctor-files";
import { compareUtf8 } from "./workspaces";
export type Connection = Manifest["connections"][number];
type ObjectValue = Record<string, any>;
export function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function finiteJson(value: unknown): void {
  const pending = [value];
  while (pending.length) {
    const next = pending.pop();
    if (typeof next === "number" && !Number.isFinite(next))
      throw new Error("JSON number is out of range");
    if (next && typeof next === "object")
      for (const value of Object.values(next)) pending.push(value);
  }
}
export function set(target: ObjectValue, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
export function sortedJson(value: unknown): string {
  const sort = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sort)
      : object(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort(compareUtf8)
              .map((key) => [key, sort(value[key])]),
          )
        : value;
  return JSON.stringify(sort(value), null, 2) + "\n";
}
export function optionalRead(file: string, fallback = ""): string {
  try {
    return readText(file, Infinity, false);
  } catch {
    return fallback;
  }
}
export function replaceManaged(
  existing: string,
  start: string,
  end: string,
  block: string,
): string {
  const a = existing.indexOf(start),
    b = existing.indexOf(end);
  if (a >= 0 && b >= 0) return existing.slice(0, a) + block + existing.slice(b + end.length);
  return existing.trim() ? `${existing.trimEnd()}\n\n${block}\n` : `${block}\n`;
}
export function managedMarkdown(existing: string, generated: string): string {
  const block = `${MANAGED_START}\n${generated.trim()}\n${MANAGED_END}`;
  return !existing.includes(MANAGED_START) && existing.trim() === generated.trim()
    ? block + "\n"
    : replaceManaged(existing, MANAGED_START, MANAGED_END, block);
}
export function cursorRule(existing: string, generated: string): string {
  let header = "",
    body = existing;
  if (existing.startsWith("---\n")) {
    const at = existing.indexOf("\n---\n");
    if (at >= 0) {
      header = existing.slice(0, at) + "\n---\n\n";
      body = existing.slice(at + 5).trimStart();
    }
  }
  return (
    (header ||
      "---\ndescription: AgentKib Cursor-specific instructions\nalwaysApply: true\n---\n\n") +
    managedMarkdown(body, generated)
  );
}
export function promotedGemini(project: string, existing: string, shared: string): string | null {
  if (!existing.trim()) return null;
  let agents: string | null = null;
  try {
    agents = readText(path.join(project, "AGENTS.md"), Infinity, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (agents !== null) {
    const content = managedContent(agents);
    if (content === null || !existing.startsWith(content)) return null;
    const rest = existing.slice(content.length);
    return !rest || /^\p{White_Space}/u.test(rest) ? rest.trimStart() : null;
  }
  const imports = (text: string) =>
      text.split(/\r?\n/).some((line) => line.trim() === "@AGENTS.md"),
    claude = optionalRead(path.join(project, "CLAUDE.md"));
  if ((claude && !imports(claude)) || imports(existing)) return null;
  if (!shared.trim() || !existing.startsWith(shared) || existing.slice(shared.length).trim())
    throw new Error(
      "GEMINI.md may contain the original shared instructions; reconcile it with the edited shared instructions before creating AGENTS.md",
    );
  return existing.slice(shared.length).trimStart();
}
function readObject(file: string): ObjectValue {
  let content: string;
  try {
    content = readText(file, Infinity, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") content = "{}";
    else throw new Error(`Could not read JSON configuration: ${file}`);
  }
  let value: unknown;
  try {
    value = file.endsWith(".jsonc") ? JSON5.parse(content) : JSON.parse(content);
    finiteJson(value);
  } catch {
    throw new Error(`Invalid ${file.endsWith(".jsonc") ? "JSONC" : "JSON"}: ${file}`);
  }
  if (!object(value)) throw new Error("JSON root must be an object");
  return value;
}
function child(root: ObjectValue, key: string, label: string): ObjectValue {
  if (!Object.hasOwn(root, key)) set(root, key, {});
  if (!object(root[key])) throw new Error(label);
  return root[key];
}
export const targeted = (connection: Connection, agent: Agent) =>
  !connection.targets.length || connection.targets.includes(agent);
export function connectionJson(connection: Connection, agent: Agent): ObjectValue {
  const value: ObjectValue = {};
  if (connection.transport === "stdio") {
    if (agent === "opencode") {
      value.type = "local";
      value.command = [connection.command, ...connection.args];
      value.enabled = true;
    } else {
      value.command = connection.command;
      value.args = connection.args;
    }
  } else {
    value[agent === "antigravity" ? "serverUrl" : "url"] = connection.url.replaceAll(
      "{agent}",
      agent,
    );
    if (agent === "claude-code") value.type = "http";
    if (agent === "open-claw") value.transport = "streamable-http";
    if (agent === "opencode") {
      value.type = "remote";
      value.enabled = true;
    }
  }
  if (Object.keys(connection.env).length)
    value[agent === "opencode" ? "environment" : "env"] = connection.env;
  if (connection.allow_tools.length)
    value[agent === "antigravity" ? "enabledTools" : "tools"] =
      agent === "antigravity" ? connection.allow_tools : { include: connection.allow_tools };
  if (agent === "antigravity") value.disabled = false;
  return value;
}
function mergeServer(servers: ObjectValue, connection: Connection, agent: Agent): void {
  const generated = connectionJson(connection, agent),
    existing = Object.hasOwn(servers, connection.name) ? servers[connection.name] : {};
  if (!object(existing)) {
    set(servers, connection.name, generated);
    return;
  }
  if (agent === "antigravity") {
    for (const key of ["tools", "enabledTools", "disabledTools", "type", "transport"])
      delete existing[key];
    for (const key of "serverUrl" in generated
      ? ["command", "args", "cwd", "url", "httpUrl"]
      : ["serverUrl", "url", "httpUrl"])
      delete existing[key];
  }
  for (const [key, value] of Object.entries(generated)) set(existing, key, value);
  set(servers, connection.name, existing);
}
export function mergeJson(
  file: string,
  connections: Connection[],
  agent: Agent,
  includeInstructions = false,
): string {
  const root = readObject(file);
  let servers: ObjectValue;
  if (agent === "opencode") {
    if (!Object.hasOwn(root, "$schema")) set(root, "$schema", "https://opencode.ai/config.json");
    if (includeInstructions) {
      if (!Object.hasOwn(root, "instructions")) set(root, "instructions", []);
      if (!Array.isArray(root.instructions))
        throw new Error("OpenCode instructions must be an array");
      if (!root.instructions.includes(".opencode/agentkib-instructions.md"))
        root.instructions.push(".opencode/agentkib-instructions.md");
    }
    servers = child(root, "mcp", "OpenCode mcp must be an object");
  } else if (agent === "open-claw")
    servers = child(
      child(root, "mcp", "OpenClaw mcp must be an object"),
      "servers",
      "OpenClaw mcp.servers must be an object",
    );
  else servers = child(root, "mcpServers", "mcpServers must be an object");
  for (const connection of connections.filter((connection) => targeted(connection, agent)))
    mergeServer(servers, connection, agent);
  return sortedJson(root);
}
const TOML_START = "# agentkib:managed:start",
  TOML_END = "# agentkib:managed:end";
export const safeKey = (value: string) =>
  [...value].map((char) => (/^[a-zA-Z0-9_-]$/.test(char) ? char : "_")).join("");
export function mergeToml(
  file: string,
  connections: Connection[],
  agent: "codex" | "grok-build",
): string {
  const existing = optionalRead(file),
    selected = connections.filter((connection) => targeted(connection, agent));
  if (!existing.includes(TOML_START)) {
    let config: any;
    try {
      config = parseToml(existing);
    } catch {}
    for (const connection of selected) {
      const key = safeKey(connection.name),
        table = `[mcp_servers.${key}]`;
      if (
        (object(config?.mcp_servers) && Object.hasOwn(config.mcp_servers, key)) ||
        existing.split(/\r?\n/).some((line) => line.trim() === table)
      )
        throw new Error(
          `${agent === "codex" ? "Codex" : "Grok Build"} configuration already contains an unmanaged MCP with the same name: ${connection.name}. Rename one entry or migrate it to AgentKib to preserve platform-specific fields.`,
        );
    }
  }
  const quote = (value: string) =>
    '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
  let block = TOML_START + "\n";
  for (const connection of selected) {
    block += `[mcp_servers.${safeKey(connection.name)}]\n`;
    block +=
      connection.transport === "stdio"
        ? `command = ${quote(connection.command)}\nargs = ${JSON.stringify(connection.args)}\n`
        : `url = ${quote(connection.url.replaceAll("{agent}", agent))}\n`;
    if (connection.allow_tools.length)
      block += `enabled_tools = ${JSON.stringify(connection.allow_tools)}\n`;
    block += "\n";
  }
  block += TOML_END;
  return replaceManaged(existing, TOML_START, TOML_END, block);
}
export function mergeHermes(file: string, project: string, connections: Connection[]): string {
  const doc = parseDocument(optionalRead(file, "{}"));
  if (doc.errors.length || !isMap(doc.contents)) throw new Error(`Invalid YAML: ${file}`);
  if (!doc.has("mcp_servers")) doc.set("mcp_servers", doc.createNode({}));
  const servers = doc.get("mcp_servers", true);
  if (!isMap(servers)) throw new Error("Hermes mcp_servers must be an object");
  for (const connection of connections.filter((connection) => targeted(connection, "hermes")))
    servers.set(connection.name, connectionJson(connection, "hermes"));
  if (!doc.has("external_skill_dirs")) doc.set("external_skill_dirs", doc.createNode([]));
  const skills = doc.get("external_skill_dirs", true);
  if (!isSeq(skills)) throw new Error("Hermes external_skill_dirs must be an array");
  const shared = path.join(project, ".agents/skills");
  if (!skills.toJSON().includes(shared)) skills.add(shared);
  return doc.toString();
}
export function managedConfigPath(project: string): string {
  let effective = path.join(project, ".opencode/opencode.json");
  for (const name of [
    "opencode.json",
    "opencode.jsonc",
    ".opencode/opencode.json",
    ".opencode/opencode.jsonc",
  ]) {
    const file = path.join(project, name);
    try {
      lstatSync(file);
      effective = file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") effective = file;
    }
  }
  return effective;
}
