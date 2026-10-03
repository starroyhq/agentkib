import { createHash } from "node:crypto";
import { lstatSync, readdirSync, statSync, readFileSync, type Stats } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { parse as parseToml } from "smol-toml";
import JSON5 from "json5";
import { AGENTS } from "./rpc";
import { ASSET_CANDIDATES } from "./asset-candidates";
import { canonicalProject, exists, isFile, readText, walk, withinLexical } from "./files";
import { canonicalize, isDirectory, pathIdentity } from "./paths";
import { loadManifest, manifestPath, type Manifest } from "./manifest";
import { catalogId } from "./workspace-store";
import {
  compareTimes,
  compareUtf8,
  utcNow,
  type CatalogAsset,
  type WorkspaceInspection,
} from "./workspaces";
import { timestamp } from "./timestamps";
interface Asset {
  agent: string;
  kind: string;
  path: string;
  exists: true;
  size: number;
  summary: string;
  summary_key?: string;
}
export function hash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function fileTime(value: string): string | null {
  try {
    const ns = statSync(value, { bigint: true }).mtimeNs;
    let seconds = ns / 1000000000n,
      nanos = ns % 1000000000n;
    if (nanos < 0) {
      seconds--;
      nanos += 1000000000n;
    }
    return timestamp(
      `${new Date(Number(seconds) * 1000).toISOString().slice(0, 19)}.${String(nanos).padStart(9, "0")}Z`,
    );
  } catch {
    return null;
  }
}
const skipped = new Set([".git", "node_modules", "target", "dist", "build", "__pycache__"]);
export function readableSkillPath(relative: string): boolean {
  const parts = relative.split(path.sep),
    base = path.basename(relative).toLowerCase(),
    text = relative.toLowerCase();
  if (
    /credential|telemetry|session/.test(text) ||
    text.endsWith(".env") ||
    text.endsWith("state.db") ||
    /token|secret/.test(base) ||
    /\.(pem|key)$/.test(base)
  )
    return false;
  if (relative === "SKILL.md") return true;
  return (
    ["references", "scripts", "assets"].includes(parts[0]!) &&
    parts.every((part) => part && !part.startsWith(".") && !skipped.has(part))
  );
}
export function inspectSkill(entrypoint: string) {
  if (path.basename(entrypoint) !== "SKILL.md")
    throw new Error("Skill entrypoint must be named SKILL.md");
  if (!lstatSync(entrypoint).isFile()) throw new Error("Skill entrypoint must be a regular file");
  const directory = path.dirname(entrypoint);
  if (lstatSync(directory).isSymbolicLink())
    throw new Error("Skill root must be a regular directory");
  const root = canonicalize(directory),
    rootDevice = statSync(root, { bigint: true }).dev;
  let name = path.basename(root).trim() ? path.basename(root) : "skill";
  try {
    const content = readText(path.join(root, "SKILL.md"));
    const match = /^---\r?\n/.exec(content);
    if (match) {
      const remaining = content.slice(match[0].length),
        end = remaining.indexOf("\n---");
      if (end >= 0) {
        const parsed = parseYaml(remaining.slice(0, end));
        const value = typeof parsed?.name === "string" ? parsed.name.trim() : "";
        if (/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value) && !value.includes("--"))
          name = value;
      }
    }
  } catch {}
  let size = 0,
    files = 0,
    entries = 1,
    modified_at: string | null = null;
  const stack = [
    { directory: root, iterator: readdirSync(root, { withFileTypes: true })[Symbol.iterator]() },
  ];
  while (stack.length && entries < 4096 && files < 512 && size < 32 * 1024 * 1024) {
    const frame = stack.at(-1)!,
      entry = frame.iterator.next();
    if (entry.done) {
      stack.pop();
      continue;
    }
    const item = entry.value;
    if (item.isSymbolicLink() || skipped.has(item.name)) continue;
    const value = path.join(frame.directory, item.name);
    entries++;
    let metadata;
    try {
      metadata = lstatSync(value, { bigint: true });
    } catch {
      continue;
    }
    if (metadata.dev !== rootDevice) continue;
    if (item.isDirectory()) {
      try {
        stack.push({
          directory: value,
          iterator: readdirSync(value, { withFileTypes: true })[Symbol.iterator](),
        });
      } catch {}
      continue;
    }
    if (!item.isFile() || !readableSkillPath(path.relative(root, value))) continue;
    files++;
    size = Math.min(32 * 1024 * 1024, size + Number(metadata.size));
    const at = fileTime(value);
    if (at && (!modified_at || compareTimes(at, modified_at) > 0)) modified_at = at;
  }
  return { name, root, entrypoint: path.join(root, "SKILL.md"), size, modified_at };
}
export function scanWorkspace(project: string) {
  const root = canonicalProject(project),
    assets: Asset[] = [],
    validation: { agent: string; warning: string }[] = [];
  // Shared asset locations belong to several agents. Reuse filesystem work only
  // within this scan so the next request still sees edits and removals.
  const metadataCache = new Map<string, Stats | undefined>(),
    directoryCache = new Map<string, string[]>(),
    skillSizeCache = new Map<string, number>(),
    validationCache = new Map<string, string | null>();
  const metadataAt = (value: string): Stats | undefined => {
    if (metadataCache.has(value)) return metadataCache.get(value);
    let metadata: Stats | undefined;
    try {
      metadata = statSync(value, { throwIfNoEntry: false });
    } catch {}
    metadataCache.set(value, metadata);
    return metadata;
  };
  const scannedRecord = (agent: string, kind: string, value: string, summary: string): Asset => {
    let size: number | undefined;
    if (kind === "skill") {
      size = skillSizeCache.get(value);
      if (size === undefined) {
        size = inspectSkill(value).size;
        skillSizeCache.set(value, size);
      }
    } else size = metadataAt(value)?.size;
    return record(agent, kind, value, summary, size);
  };
  for (const agent of AGENTS) {
    for (const [candidate, kind, summary] of ASSET_CANDIDATES[agent]!) {
      const absolute = path.join(root, candidate),
        metadata = metadataAt(absolute);
      if (!metadata) continue;
      if (metadata.isFile()) {
        assets.push(scannedRecord(agent, kind, absolute, summary));
        if (!validationCache.has(absolute)) validationCache.set(absolute, validateNative(absolute));
        const warning = validationCache.get(absolute);
        if (warning) validation.push({ agent, warning });
      } else if (metadata.isDirectory()) {
        let files = directoryCache.get(absolute);
        if (!files) {
          files = walk(absolute, 4);
          directoryCache.set(absolute, files);
        }
        for (const value of files) {
          const name = path.basename(value);
          if (
            kind === "skill"
              ? name === "SKILL.md"
              : /\.(toml|json|jsonc|md|mdc)$/.test(name) ||
                (agent === "opencode" &&
                  [".opencode/plugins", ".opencode/tools"].includes(candidate) &&
                  /\.(js|ts)$/.test(name))
          )
            assets.push(scannedRecord(agent, kind, value, summary));
        }
      }
    }
  }
  assets.sort((left, right) => compareUtf8(left.path, right.path));
  const dedup = assets
    .filter(
      (asset, index) =>
        !(
          index > 0 &&
          assets[index - 1]!.agent === asset.agent &&
          assets[index - 1]!.path === asset.path
        ),
    )
    .filter(
      (asset) =>
        !(
          asset.agent === "antigravity" &&
          withinLexical(asset.path, path.join(root, ".agent/rules")) &&
          isFile(
            path.join(
              root,
              ".agents/rules",
              path.relative(path.join(root, ".agent/rules"), asset.path),
            ),
          )
        ),
    );
  const agents = AGENTS.map((agent) => {
    const count = dedup.filter((asset) => asset.agent === agent).length;
    return {
      agent,
      detected: count > 0,
      asset_count: count,
      warnings: validation.filter((value) => value.agent === agent).map((value) => value.warning),
    };
  });
  const warnings = validation.map((value) => value.warning),
    manifest_exists = exists(manifestPath(root));
  if (manifest_exists) {
    try {
      loadManifest(root);
    } catch (error) {
      warnings.push((error as Error).message);
    }
  }
  return { root, manifest_exists, agents, assets: dedup, warnings };
}
function record(
  agent: string,
  kind: string,
  value: string,
  summary: string,
  knownSize?: number,
): Asset {
  const size = knownSize ?? (kind === "skill" ? inspectSkill(value).size : statSync(value).size),
    key = summaryKey(summary);
  return {
    agent,
    kind,
    path: value,
    exists: true,
    size,
    summary,
    ...(key ? { summary_key: key } : {}),
  };
}
function summaryKey(summary: string): string | null {
  for (const [name, key] of [
    ["Codex", "codexInstructions"],
    ["Claude Code", "claudeInstructions"],
    ["OpenCode", "openCodeInstructions"],
    ["OpenClaw", "openClawInstructions"],
    ["Hermes", "hermesInstructions"],
    ["Grok Build", "grokBuildInstructions"],
    ["DeepSeek Harness", "deepseekHarnessInstructions"],
    ["Cursor", "cursorInstructions"],
  ])
    if (summary.includes(name!) && summary.includes("instruction")) return `assets.summary.${key}`;
  if (summary.includes("Skill")) return "assets.summary.skillDirectory";
  if (summary.includes("MCP")) return "assets.summary.mcpConfig";
  return null;
}
function validateNative(value: string): string | null {
  const extension = path.extname(value),
    format = ({ ".jsonc": "JSONC", ".json": "JSON", ".toml": "TOML" } as Record<string, string>)[
      extension
    ];
  if (!format) return null;
  try {
    const content = readText(value);
    if (extension === ".toml") parseToml(content);
    else if (extension === ".jsonc") JSON5.parse(content);
    else JSON.parse(content);
    return null;
  } catch (error) {
    return `Configuration file is invalid: ${value} (${(error as Error).message})`;
  }
}
export function inspectWorkspace(id: string, value: string): WorkspaceInspection {
  const result: WorkspaceInspection = { summary: null, assets: [], error: null };
  try {
    if (!isDirectory(value)) throw new Error(`Workspace does not exist: ${value}`);
    const scan = scanWorkspace(value);
    let manifest: Manifest | null = null;
    try {
      manifest = loadManifest(value);
    } catch {}
    const skillNames = new Map<string, string>();
    for (const skill of manifest?.skills ?? []) {
      const source = path.join(value, skill.path);
      let root = source;
      try {
        root = inspectSkill(isDirectory(source) ? path.join(source, "SKILL.md") : source).root;
      } catch {}
      skillNames.set(pathIdentity(root), skill.name);
    }
    let warnings = scan.warnings.length;
    for (const adapter of Object.values(manifest?.adapters ?? {})) {
      if (!adapter) continue;
      for (const [target, expected] of Object.entries(adapter.generated_hashes)) {
        try {
          if (
            hash(readFileSync(path.isAbsolute(target) ? target : path.join(value, target))) !==
            expected
          )
            warnings++;
        } catch {
          warnings++;
        }
      }
    }
    const logical = new Set(
      scan.assets.map(
        (asset) =>
          `${asset.kind}|${asset.kind === "skill" ? "" : asset.agent}|${pathIdentity(asset.kind === "skill" ? path.dirname(asset.path) : asset.path)}`,
      ),
    );
    result.summary = {
      manifest_workspace_id: manifest?.workspace.id ?? null,
      status: !warnings && (!scan.manifest_exists || manifest) ? "healthy" : "attention",
      asset_count: logical.size,
      warning_count: warnings,
      scanned_at: utcNow(),
    };
    const add = (asset: CatalogAsset, keyPath = asset.path) => {
      asset.id = catalogId({ ...asset, path: keyPath });
      result.assets.push(asset);
    };
    for (const asset of scan.assets) {
      const skill = asset.kind === "skill" ? inspectSkill(asset.path) : null;
      const catalogPath = skill?.root ?? asset.path;
      const { exists: _exists, ...catalogAsset } = asset;
      add({
        ...catalogAsset,
        id: "",
        scope: "workspace",
        workspace_id: id,
        name:
          skillNames.get(pathIdentity(catalogPath)) ??
          skill?.name ??
          path.basename(asset.path) ??
          "asset",
        path: catalogPath,
        size: skill?.size ?? asset.size,
        modified_at: skill?.modified_at ?? fileTime(asset.path),
      });
    }
    if (manifest) {
      const common = {
        id: "",
        scope: "workspace",
        workspace_id: id,
        agent: null,
        modified_at: null,
      };
      const file = manifestPath(value);
      add({
        ...common,
        kind: "instruction",
        name: "Shared project instructions",
        path: file,
        summary: "AgentKib shared instructions",
        summary_key: "assets.summary.sharedInstructions",
        size: Buffer.byteLength(manifest.instructions.shared),
      });
      for (const skill of manifest.skills) {
        const source = path.join(value, skill.path);
        let scanned: ReturnType<typeof inspectSkill> | null = null;
        try {
          scanned = inspectSkill(isDirectory(source) ? path.join(source, "SKILL.md") : source);
        } catch {}
        add({
          ...common,
          kind: "skill",
          name: skill.name,
          path: scanned?.root ?? source,
          summary: "Shared Skill",
          summary_key: "assets.summary.sharedSkill",
          size: scanned?.size ?? 0,
          modified_at: scanned?.modified_at ?? null,
        });
      }
      for (const connection of manifest.connections)
        add(
          {
            ...common,
            kind: "connection",
            name: connection.name,
            path: file,
            summary: "Shared MCP Connection",
            summary_key: "assets.summary.sharedConnection",
            size: 0,
          },
          path.join(file, `connection-${connection.name}`),
        );
    }
  } catch (error) {
    result.error = (error as Error).message;
  }
  return result;
}
