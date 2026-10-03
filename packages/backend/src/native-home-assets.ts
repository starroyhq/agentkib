import { lstatSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { canonicalize, pathIdentity } from "./paths";
import { isReparseOrSymlink } from "./native-files";
import { fileTime, inspectSkill } from "./asset-scanner";
import { userHome } from "./mcp-config-read";
import type { CatalogAsset } from "./workspaces";

const ignored = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
]);

const homeCandidates: Record<string, readonly string[]> = {
  codex: ["AGENTS.md", "config.toml", "skills", "agents", "hooks"],
  "claude-code": ["CLAUDE.md", "settings.json", "config.json", "skills", "agents", "hooks"],
  cursor: ["mcp.json", "rules", "commands", "hooks.json", "skills"],
  opencode: [
    "AGENTS.md",
    "opencode.json",
    "opencode.jsonc",
    "skills",
    "agents",
    "commands",
    "plugins",
    "tools",
  ],
  "open-claw": ["openclaw.json", "skills", "agents", "hooks", "SOUL.md", "MEMORY.md"],
  hermes: ["config.yaml", "SOUL.md", "MEMORY.md", "skills", "profiles", "hooks"],
  "grok-build": [
    "config.toml",
    "managed_config.toml",
    "requirements.toml",
    "AGENTS.md",
    "rules",
    "skills",
    "plugins",
    "agents",
    "hooks",
    "workflows",
  ],
  antigravity: ["GEMINI.md"],
  "deepseek-harness": [
    "AGENTS.md",
    "settings.yaml",
    "cordis.patch.yml",
    "profiles",
    "skills",
    ".agent-presets",
  ],
};

/** Read-only allowlisted files from agent homes; private/session state is excluded. */
export function scanNativeHomeAssets(environment: NodeJS.ProcessEnv): CatalogAsset[] {
  const assets: CatalogAsset[] = [];
  for (const [agent, home] of homes(environment)) {
    try {
      if (isDirectory(home)) assets.push(...scanKnownHome(agent, home, homeCandidates[agent]!));
      if (agent === "antigravity") {
        for (const [suffix, names] of [
          ["antigravity-cli", ["settings.json", "skills", "rules", "plugins"]],
          ["config", ["mcp_config.json", "skills", "plugins"]],
        ] as const) {
          const root = path.join(home, suffix);
          if (isDirectory(root)) assets.push(...scanKnownHome(agent, root, names));
        }
      }
    } catch {}
  }
  const agentkibHome =
    environment.AGENTKIB_HOME ??
    path.join(
      userHome(environment),
      environment.AGENTKIB_APP_FLAVOR === "ai.agentkib.dev" ? ".agentkib-dev" : ".agentkib",
    );
  assets.push(...scanSkillLibrary(agentkibHome));
  const unique = new Map<string, CatalogAsset>();
  for (const asset of assets) unique.set(`${asset.agent ?? ""}\0${asset.path}`, asset);
  return [...unique.values()].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
  );
}

function homes(environment: NodeJS.ProcessEnv): [string, string][] {
  const home = userHome(environment),
    xdg =
      environment.XDG_CONFIG_HOME && path.isAbsolute(environment.XDG_CONFIG_HOME)
        ? environment.XDG_CONFIG_HOME
        : process.platform === "win32"
          ? (environment.APPDATA ?? path.join(home, "AppData/Roaming"))
          : path.join(home, ".config"),
    entries: [string, string][] = [
      ["codex", environment.CODEX_HOME ?? path.join(home, ".codex")],
      ["claude-code", environment.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude")],
      ["cursor", path.join(home, ".cursor")],
      ["opencode", path.join(xdg, "opencode")],
      ["open-claw", environment.OPENCLAW_STATE_DIR ?? path.join(home, ".openclaw")],
      ["hermes", environment.HERMES_HOME ?? path.join(home, ".hermes")],
      ["grok-build", environment.GROK_HOME ?? path.join(home, ".grok")],
      ["antigravity", path.join(home, ".gemini")],
      ["deepseek-harness", environment.DSH_HOME ?? path.join(home, ".dsh")],
    ];
  const hermes = entries.find(([agent]) => agent === "hermes")![1],
    profileRoot = path.join(hermes, "profiles");
  try {
    if (isDirectory(profileRoot))
      for (const entry of readdirSync(profileRoot, { withFileTypes: true })) {
        const profile = path.join(profileRoot, entry.name);
        if (entry.isDirectory() && !isReparseOrSymlink(profile, entry))
          entries.push(["hermes", profile]);
      }
  } catch {}
  return entries;
}

function scanKnownHome(agent: string, homeValue: string, names: readonly string[]): CatalogAsset[] {
  let home: string;
  try {
    home = canonicalize(homeValue);
  } catch {
    return [];
  }
  const allowed = new Set(names),
    output: CatalogAsset[] = [];
  for (const name of names) {
    const root = path.join(home, name);
    let metadata;
    try {
      metadata = lstatSync(root, { bigint: true });
      if (isReparseOrSymlink(root, metadata)) continue;
    } catch {
      continue;
    }
    if (metadata.isFile()) {
      if (!isPrivate(root)) output.push(homeAsset(agent, root));
      continue;
    }
    if (!metadata.isDirectory()) continue;
    const rootDevice = metadata.dev,
      stack = [{ directory: root, depth: 0 }];
    while (stack.length) {
      const current = stack.pop()!;
      for (const entry of readdirSync(current.directory, { withFileTypes: true })) {
        const file = path.join(current.directory, entry.name);
        let item;
        try {
          item = lstatSync(file, { bigint: true });
          if (isReparseOrSymlink(file, item) || item.dev !== rootDevice) continue;
        } catch {
          continue;
        }
        if (item.isDirectory()) {
          if (current.depth + 1 < 4 && !ignored.has(entry.name))
            stack.push({ directory: file, depth: current.depth + 1 });
        } else if (item.isFile() && !isPrivate(file)) {
          const relative = path.relative(home, file);
          if (hasComponent(relative, "skills") && path.basename(file) !== "SKILL.md") continue;
          output.push(homeAsset(agent, file));
        }
      }
    }
  }
  return output.filter((asset) => {
    const relative = path.relative(home, asset.path),
      top = relative.split(path.sep)[0];
    return allowed.has(top!);
  });
}

function homeAsset(agent: string, file: string): CatalogAsset {
  const metadata = statSync(file),
    kind = assetKind(file),
    skill = kind === "skill" && path.basename(file) === "SKILL.md" ? inspectSkill(file) : null,
    assetPath = skill?.root ?? file;
  return {
    id: "",
    scope: "agent-home",
    workspace_id: null,
    agent,
    kind,
    name: skill?.name ?? (path.basename(file) || "asset"),
    path: assetPath,
    summary: `${agent} Home asset (read-only)`,
    size: skill?.size ?? metadata.size,
    modified_at: skill?.modified_at ?? fileTime(file),
    summary_key: "assets.summary.homeAsset",
    summary_params: { agent },
  };
}

function scanSkillLibrary(home: string): CatalogAsset[] {
  const root = path.join(home, "skills");
  if (!isDirectory(root)) return [];
  const output: CatalogAsset[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const directory = path.join(root, entry.name);
    if (!entry.isDirectory() || isReparseOrSymlink(directory, entry)) continue;
    try {
      const skill = inspectSkill(path.join(directory, "SKILL.md")),
        stable = createHash("sha256").update(pathIdentity(skill.root)).digest("hex");
      output.push({
        id: `agentkib-home:skill:${stable}`,
        scope: "agentkib-home",
        workspace_id: null,
        agent: null,
        kind: "skill",
        name: skill.name,
        path: skill.root,
        summary: "AgentKib Skill library",
        size: skill.size,
        modified_at: skill.modified_at,
        summary_key: "assets.summary.agentkibSkill",
        summary_params: {},
      });
    } catch {}
  }
  return output.sort((left, right) =>
    Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
  );
}

function isPrivate(file: string): boolean {
  const text = file.toLowerCase(),
    name = path.basename(file).toLowerCase();
  return (
    text.includes("credential") ||
    text.includes("telemetry") ||
    text.endsWith(".env") ||
    text.includes("session") ||
    text.endsWith("state.db") ||
    name.includes("token") ||
    name.includes("secret") ||
    name.endsWith(".pem") ||
    name.endsWith(".key")
  );
}

function assetKind(file: string): CatalogAsset["kind"] {
  const name = path.basename(file).toLowerCase();
  if (name === "skill.md" || hasComponent(file, "skills")) return "skill";
  if (name === "memory.md" || hasComponent(file, "memory")) return "memory";
  if (name === "hooks.json" || hasComponent(file, "hooks")) return "hook";
  if (["mcp.json", "mcp_config.json"].includes(name)) return "connection";
  if (["agents", "profiles", ".agent-presets"].some((part) => hasComponent(file, part)))
    return "agent";
  if (hasComponent(file, "workflows")) return "configuration";
  if (path.extname(file) === ".md") return "instruction";
  return "configuration";
}

function hasComponent(value: string, expected: string): boolean {
  return value.split(/[\\/]/).some((part) => part.toLowerCase() === expected.toLowerCase());
}

function isDirectory(value: string): boolean {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}
