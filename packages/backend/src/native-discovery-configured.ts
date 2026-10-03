import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import JSON5 from "json5";
import { normalizeDiscoveryCandidates } from "./discovery-scan-roots";
import { isReparseOrSymlink } from "./native-files";
import { fileTime } from "./asset-scanner";
import { userHome } from "./mcp-config-read";
import { jsonTimestamp } from "./session-history";
import { Sql } from "./sql";
import { isDirectory, isProbeWorkspace, pathIdentity } from "./paths";
import { GrokSessions } from "./grok-sessions";
import { CodexSessionOwnership } from "./codex-session-ownership";
import { OpenClawSessions } from "./openclaw-sessions";
import { HermesSessions } from "./hermes-sessions";
import { scanNativeHomeAssets } from "./native-home-assets";
import { resolveCommand } from "./command-resolution";
import { utcNow, type DiscoveryCandidate } from "./workspaces";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

interface ProviderResult {
  non_workspace_paths?: string[];
  candidates: DiscoveryCandidate[];
  errors: string[];
  status: string;
  reasons: string[];
  source_diagnostics?: Record<string, unknown>[];
}

/** Discovery adapters for providers whose workspace index is independent of conversation history. */
export function discoverConfiguredWorkspaces(environment: NodeJS.ProcessEnv) {
  const candidates: DiscoveryCandidate[] = [],
    non_workspace_paths: string[] = [],
    errors: string[] = [],
    source_diagnostics: Record<string, unknown>[] = [];
  const roots: {
    agent: string;
    source: string;
    path: string;
    read: (root: string) => ProviderResult;
  }[] = [
    {
      agent: "codex",
      source: "state-db",
      path: codexHome(environment),
      read: (home: string) => readCodex(home, environment),
    },
    {
      agent: "claude-code",
      source: "history-and-index",
      path: environment.CLAUDE_CONFIG_DIR ?? path.join(userHome(environment), ".claude"),
      read: (home: string) => readClaude(home),
    },
    {
      agent: "open-claw",
      source: "config-and-sessions",
      path: environment.OPENCLAW_STATE_DIR ?? path.join(userHome(environment), ".openclaw"),
      read: (home: string) => readOpenClaw(home, environment),
    },
    {
      agent: "hermes",
      source: "profiles-and-state",
      path: environment.HERMES_HOME ?? path.join(userHome(environment), ".hermes"),
      read: (_home: string) => readHermes(environment),
    },
    {
      agent: "grok-build",
      source: "sessions-and-archives",
      path: environment.GROK_HOME ?? path.join(userHome(environment), ".grok"),
      read: (_home: string) => readGrok(environment),
    },
    {
      agent: "opencode",
      source: "sqlite-and-legacy",
      path: openCodeDataHome(environment),
      read: (home: string) => readOpenCode(home),
    },
    {
      agent: "antigravity",
      source: "config-and-cli",
      path: path.join(userHome(environment), ".gemini"),
      read: (home: string) => readAntigravity(home),
    },
    {
      agent: "cursor",
      source: "workspace-storage",
      path: cursorStorage(environment),
      read: (root: string) => readCursor(root),
    },
    {
      agent: "deepseek-harness",
      source: "workspace-storage",
      path: path.join(deepseekHome(environment), "storages/workspace.json"),
      read: (file: string) => readDeepSeek(file),
    },
  ];

  for (const item of roots) {
    const started_at = utcNow();
    try {
      const result = item.read(item.path),
        finished_at = utcNow();
      candidates.push(...result.candidates);
      non_workspace_paths.push(...(result.non_workspace_paths ?? []));
      if (result.source_diagnostics) source_diagnostics.push(...result.source_diagnostics);
      else
        source_diagnostics.push({
          agent: item.agent,
          source: item.source,
          path: item.path,
          started_at,
          finished_at,
          candidate_count: result.candidates.length,
          included_count: null,
          skipped_count: null,
          status: result.status,
          reasons: result.reasons,
        });
      errors.push(
        ...result.errors.map((error) => `${item.agent} workspace discovery failed: ${error}`),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error),
        finished_at = utcNow();
      source_diagnostics.push({
        agent: item.agent,
        source: item.source,
        path: item.path,
        started_at,
        finished_at,
        candidate_count: null,
        included_count: null,
        skipped_count: null,
        status: detail.toLowerCase().includes("permission") ? "permission-denied" : "failed",
        reasons: [
          detail.toLowerCase().includes("permission") ? "permission-denied" : "source-read-failed",
        ],
      });
      errors.push(`${item.agent} workspace discovery failed: ${detail}`);
    }
  }
  return {
    non_workspace_paths,
    candidates: normalizeDiscoveryCandidates(candidates, environment),
    errors,
    source_diagnostics,
    home_assets: scanNativeHomeAssets(environment),
    installations: agentInstallations(environment),
  };
}

function agentInstallations(environment: NodeJS.ProcessEnv) {
  const home = userHome(environment),
    xdg =
      environment.XDG_CONFIG_HOME && path.isAbsolute(environment.XDG_CONFIG_HOME)
        ? environment.XDG_CONFIG_HOME
        : process.platform === "win32"
          ? (environment.APPDATA ?? path.join(home, "AppData/Roaming"))
          : path.join(home, ".config"),
    cursorHome = path.join(home, ".cursor"),
    cursorData = cursorDataHome(environment),
    opencodeConfig = environment.OPENCODE_CONFIG_DIR ?? path.join(xdg, "opencode"),
    opencodeData = openCodeDataHome(environment),
    homes: Record<string, string> = {
      codex: codexHome(environment),
      "claude-code": environment.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"),
      cursor: cursorHome,
      opencode: opencodeConfig,
      "open-claw": environment.OPENCLAW_STATE_DIR ?? path.join(home, ".openclaw"),
      hermes: environment.HERMES_HOME ?? path.join(home, ".hermes"),
      "grok-build": environment.GROK_HOME ?? path.join(home, ".grok"),
      antigravity: path.join(home, ".gemini"),
      "deepseek-harness": deepseekHome(environment),
    },
    commands: Record<string, string> = {
      codex: "codex",
      "claude-code": "claude",
      cursor: "cursor",
      opencode: "opencode",
      "open-claw": "openclaw",
      hermes: "hermes",
      "grok-build": "grok",
      antigravity: "agy",
      "deepseek-harness": "dsh",
    };
  return Object.entries(homes).map(([agent, agentHome]) => {
    const configured =
        isDirectory(agentHome) ||
        (agent === "cursor" && isDirectory(cursorData)) ||
        (agent === "opencode" && isDirectory(opencodeData)),
      warnings: string[] = [];
    if (agent === "deepseek-harness") {
      const file = path.join(agentHome, "storages/workspace.json");
      if (isFile(file))
        try {
          readDeepSeek(file);
        } catch (error) {
          warnings.push(error instanceof Error ? error.message : String(error));
        }
    }
    return {
      agent,
      installed:
        resolveCommand(commands[agent]!, environment) !== null || appInstalled(agent, environment),
      configured,
      version: null,
      home: agentHome,
      warnings,
    };
  });
}

function cursorDataHome(environment: NodeJS.ProcessEnv): string {
  const home = userHome(environment),
    config =
      environment.XDG_CONFIG_HOME && path.isAbsolute(environment.XDG_CONFIG_HOME)
        ? environment.XDG_CONFIG_HOME
        : path.join(home, ".config");
  return (
    environment.CURSOR_DATA_DIR ??
    (process.platform === "linux"
      ? path.join(config, "Cursor")
      : process.platform === "win32"
        ? path.join(environment.APPDATA ?? path.join(home, "AppData/Roaming"), "Cursor")
        : path.join(home, "Library/Application Support/Cursor"))
  );
}

function appInstalled(agent: string, environment: NodeJS.ProcessEnv): boolean {
  const home = userHome(environment);
  if (process.platform === "darwin") {
    const bundles: Record<string, string> = {
      codex: "Codex.app",
      cursor: "Cursor.app",
      opencode: "OpenCode.app",
      antigravity: "Antigravity.app",
    };
    const bundle = bundles[agent];
    return bundle
      ? [path.join("/Applications", bundle), path.join(home, "Applications", bundle)].some((root) =>
          isFile(path.join(root, "Contents/Info.plist")),
        )
      : false;
  }
  if (process.platform === "win32") {
    const local = environment.LOCALAPPDATA ?? path.join(home, "AppData/Local"),
      programFiles = environment.ProgramFiles ?? "C:\\Program Files",
      candidates =
        agent === "cursor"
          ? [
              path.join(local, "Programs/cursor/Cursor.exe"),
              path.join(local, "Programs/Cursor/Cursor.exe"),
              path.join(local, "Microsoft/WindowsApps/Cursor.exe"),
              path.join(programFiles, "Cursor/Cursor.exe"),
            ]
          : agent === "opencode"
            ? [
                path.join(local, "Programs/OpenCode/OpenCode.exe"),
                path.join(local, "OpenCode/OpenCode.exe"),
              ]
            : agent === "antigravity"
              ? [
                  path.join(local, "Programs/Antigravity/Antigravity.exe"),
                  path.join(local, "Programs/Antigravity/Antigravity IDE.exe"),
                  path.join(local, "Programs/Antigravity IDE/Antigravity IDE.exe"),
                  path.join(programFiles, "Antigravity/Antigravity.exe"),
                  path.join(programFiles, "Antigravity/Antigravity IDE.exe"),
                  path.join(programFiles, "Antigravity IDE/Antigravity IDE.exe"),
                ]
              : [];
    return candidates.some(isFile);
  }
  if (process.platform === "linux") return linuxDesktopAppInstalled(agent, environment);
  return false;
}

function linuxDesktopAppInstalled(agent: string, environment: NodeJS.ProcessEnv): boolean {
  const home = userHome(environment),
    dataHome =
      environment.XDG_DATA_HOME && path.isAbsolute(environment.XDG_DATA_HOME)
        ? environment.XDG_DATA_HOME
        : path.join(home, ".local/share"),
    dataDirectories = (environment.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share")
      .split(path.delimiter)
      .filter((value) => path.isAbsolute(value)),
    roots = [dataHome, ...dataDirectories].map((root) => path.join(root, "applications")),
    ids: Record<string, string[]> = {
      cursor: ["cursor", "cursor-url-handler"],
      opencode: ["ai.opencode.desktop", "opencode-desktop"],
      antigravity: ["antigravity", "com.google.antigravity"],
    },
    wanted = ids[agent];
  if (agent === "cursor") {
    const candidates = [
      "/usr/bin/cursor",
      "/usr/share/cursor/cursor",
      "/opt/Cursor/cursor",
      "/opt/cursor/cursor",
    ];
    if (candidates.some((file) => resolveCommand(file, environment))) return true;
    const applications = path.join(home, "Applications");
    try {
      if (
        readdirSync(applications, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.toLowerCase().includes("cursor"))
          .some(
            (entry) =>
              entry.name.endsWith(".AppImage") &&
              resolveCommand(path.join(applications, entry.name), environment),
          )
      )
        return true;
    } catch {}
  }
  if (!wanted) return false;
  for (const root of roots) {
    for (const file of desktopFiles(root, 2)) {
      const stem = path.basename(file, ".desktop").toLowerCase();
      if (!wanted.some((id) => stem === id || stem.startsWith(`${id}-`))) continue;
      const command = desktopCommand(file);
      if (
        command &&
        !["sh", "bash", "dash", "zsh", "fish", "flatpak", "snap"].includes(
          path.basename(command),
        ) &&
        resolveCommand(command, environment)
      )
        return true;
    }
  }
  return false;
}

function desktopFiles(directory: string, depth: number): string[] {
  if (depth <= 0) return [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return desktopFiles(file, depth - 1);
    return entry.isFile() && path.extname(entry.name) === ".desktop" ? [file] : [];
  });
}

function desktopCommand(file: string): string | null {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let section = false,
    exec: string | null = null,
    tryExec: string | null = null,
    hasTryExec = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line === "[Desktop Entry]";
      continue;
    }
    if (!section || line.startsWith("#")) continue;
    if (line.startsWith("TryExec=")) {
      hasTryExec = true;
      tryExec = firstDesktopToken(line.slice(8));
    } else if (line.startsWith("Exec=")) exec = firstDesktopToken(line.slice(5));
  }
  const selected = hasTryExec ? tryExec : exec;
  return selected && !selected.includes("%") ? selected : null;
}

function firstDesktopToken(value: string): string | null {
  const tokens = value.match(/(?:"(?:\\.|[^"\\])*"|\\S)+/g);
  if (!tokens?.length) return null;
  const token = tokens[0]!.replace(/^"|"$/g, "").replaceAll(/\\(.)/g, "$1");
  if (token !== "env") return token;
  return (
    tokens
      .slice(1)
      .map((item) => item.replace(/^"|"$/g, ""))
      .find((item) => !item.startsWith("-") && !/^[^/]+=/.test(item)) ?? null
  );
}

function cursorStorage(environment: NodeJS.ProcessEnv): string {
  const home = userHome(environment),
    configured = environment.XDG_CONFIG_HOME,
    config = configured && path.isAbsolute(configured) ? configured : path.join(home, ".config"),
    data =
      environment.CURSOR_DATA_DIR ??
      (process.platform === "linux"
        ? path.join(config, "Cursor")
        : process.platform === "win32"
          ? path.join(environment.APPDATA ?? path.join(home, "AppData/Roaming"), "Cursor")
          : path.join(home, "Library/Application Support/Cursor"));
  return path.join(data, "User/workspaceStorage");
}

function deepseekHome(environment: NodeJS.ProcessEnv): string {
  return environment.DSH_HOME ?? path.join(userHome(environment), ".dsh");
}

function codexHome(environment: NodeJS.ProcessEnv): string {
  return environment.CODEX_HOME ?? path.join(userHome(environment), ".codex");
}

function openCodeDataHome(environment: NodeJS.ProcessEnv): string {
  const home = userHome(environment),
    data =
      environment.XDG_DATA_HOME && path.isAbsolute(environment.XDG_DATA_HOME)
        ? environment.XDG_DATA_HOME
        : process.platform === "linux"
          ? path.join(home, ".local/share")
          : process.platform === "win32"
            ? (environment.LOCALAPPDATA ?? path.join(home, "AppData/Local"))
            : path.join(home, "Library/Application Support");
  return path.join(data, "opencode");
}

function readAntigravity(home: string): ProviderResult {
  const exists = isDirectory(home);
  return {
    candidates: [],
    errors: [],
    status: exists ? "empty" : "missing",
    reasons: exists ? [] : ["missing-directory"],
  };
}

function readOpenCode(dataHome: string): ProviderResult {
  const candidates: DiscoveryCandidate[] = [],
    errors: string[] = [],
    diagnostics: Record<string, unknown>[] = [],
    database = path.join(dataHome, "opencode.db"),
    sqliteStarted = utcNow();
  if (!isFile(database)) {
    diagnostics.push(
      diagnostic("sqlite", database, sqliteStarted, "missing", null, ["missing-file"]),
    );
  } else {
    try {
      const connection = new DatabaseSync(database, { readOnly: true });
      let values: DiscoveryCandidate[];
      try {
        const query = new Sql(connection),
          projects = new Set(
            query.rows("PRAGMA table_info(project)").map((row) => String(row.name)),
          ),
          sessions = new Set(
            query.rows("PRAGMA table_info(session)").map((row) => String(row.name)),
          );
        values = [];
        if (projects.has("worktree")) values.push(...openCodeRows(query, "project", "worktree", 0));
        if (sessions.has("directory"))
          values.push(...openCodeRows(query, "session", "directory", 1));
      } finally {
        connection.close();
      }
      const unique = mergeCandidates(values);
      candidates.push(...unique);
      diagnostics.push(
        diagnostic(
          "sqlite",
          database,
          sqliteStarted,
          unique.length ? "succeeded" : "empty",
          unique.length,
          [],
        ),
      );
    } catch (error) {
      errors.push(String(error));
      diagnostics.push(
        diagnostic("sqlite", database, sqliteStarted, "failed", null, ["source-read-failed"]),
      );
    }
  }

  const legacyRoot = path.join(dataHome, "storage/project"),
    legacyStarted = utcNow();
  if (!isDirectory(legacyRoot)) {
    diagnostics.push(
      diagnostic("legacy-json", legacyRoot, legacyStarted, "missing", null, ["missing-directory"]),
    );
  } else {
    try {
      const databasePaths = new Set(candidates.map((value) => pathIdentity(value.path))),
        legacy = readLegacyOpenCode(dataHome).filter(
          (value) => !databasePaths.has(pathIdentity(value.path)),
        );
      candidates.push(...legacy);
      diagnostics.push(
        diagnostic(
          "legacy-json",
          legacyRoot,
          legacyStarted,
          legacy.length ? "succeeded" : "empty",
          legacy.length,
          [],
        ),
      );
    } catch (error) {
      errors.push(String(error));
      diagnostics.push(
        diagnostic("legacy-json", legacyRoot, legacyStarted, "failed", null, [
          "source-read-failed",
        ]),
      );
    }
  }
  return {
    candidates,
    errors,
    status: errors.length ? "partial" : candidates.length ? "succeeded" : "empty",
    reasons: errors.length ? ["source-read-failed"] : [],
    source_diagnostics: diagnostics,
  };
}

function openCodeRows(sql: Sql, table: "project" | "session", column: string, sessions: 0 | 1) {
  const columns = new Set(sql.rows(`PRAGMA table_info(${table})`).map((row) => String(row.name))),
    timestampExpression =
      columns.has("time_updated") && columns.has("time_created")
        ? "MAX(COALESCE(time_updated, time_created))"
        : columns.has("time_updated")
          ? "MAX(time_updated)"
          : columns.has("time_created")
            ? "MAX(time_created)"
            : "NULL",
    rows = sql.rows(
      `SELECT ${column} AS workspace, ${sessions ? "COUNT(*)" : "0"} AS count, ${timestampExpression} AS updated FROM ${table} WHERE ${column} IS NOT NULL AND ${column} != '' GROUP BY ${column}`,
    );
  return rows.flatMap((row) =>
    typeof row.workspace === "string"
      ? [
          candidate(
            row.workspace,
            "opencode",
            "session-cwd",
            integerTimestamp(row.updated),
            false,
            count(row.count),
          ),
        ]
      : [],
  );
}

function readLegacyOpenCode(dataHome: string): DiscoveryCandidate[] {
  const root = path.join(dataHome, "storage/project"),
    sessionsRoot = path.join(dataHome, "storage/session"),
    output: DiscoveryCandidate[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name) !== ".json") continue;
    const file = path.join(root, entry.name);
    let value: Record<string, unknown> | null;
    try {
      value = asRecord(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      continue;
    }
    if (typeof value?.worktree !== "string") continue;
    const sessionDirectory =
        typeof value.id === "string" ? path.join(sessionsRoot, value.id) : null,
      sessionCount =
        sessionDirectory && isDirectory(sessionDirectory)
          ? readdirSync(sessionDirectory, { withFileTypes: true }).filter(
              (item) => item.isFile() && path.extname(item.name) === ".json",
            ).length
          : 0,
      updated = asRecord(value.time),
      at = jsonTimestamp(updated?.updated ?? updated?.created) ?? fileTime(file);
    output.push(candidate(value.worktree, "opencode", "session-cwd", at, false, sessionCount));
  }
  return output;
}

function mergeCandidates(values: DiscoveryCandidate[]): DiscoveryCandidate[] {
  const unique = new Map<string, DiscoveryCandidate>();
  for (const value of values) {
    const key = pathIdentity(value.path),
      previous = unique.get(key);
    if (!previous) unique.set(key, value);
    else {
      previous.session_count = Math.min(
        Number.MAX_SAFE_INTEGER,
        previous.session_count + value.session_count,
      );
      if (
        value.last_active_at &&
        (!previous.last_active_at || value.last_active_at > previous.last_active_at)
      )
        previous.last_active_at = value.last_active_at;
    }
  }
  return [...unique.values()];
}

function diagnostic(
  source: string,
  sourcePath: string,
  started_at: string,
  status: string,
  candidate_count: number | null,
  reasons: string[],
) {
  return {
    agent: "opencode",
    source,
    path: sourcePath,
    started_at,
    finished_at: utcNow(),
    candidate_count,
    included_count: null,
    skipped_count: null,
    status,
    reasons,
  };
}

function providerDiagnostic(
  agent: string,
  source: string,
  sourcePath: string,
  started_at: string,
  status: string,
  candidate_count: number | null,
  reasons: string[],
) {
  return {
    agent,
    source,
    path: sourcePath,
    started_at,
    finished_at: utcNow(),
    candidate_count,
    included_count: null,
    skipped_count: null,
    status,
    reasons,
  };
}

function isFile(value: string): boolean {
  try {
    return statSync(value).isFile();
  } catch {
    return false;
  }
}

function readClaude(home: string): ProviderResult {
  const activity = new Map<
      string,
      { ids: Set<string>; anonymous: number; last_active_at: string | null }
    >(),
    merge = (workspace: string, sessionId: string | null, at: string | null) => {
      if (isProbeWorkspace(workspace)) return;
      let value = activity.get(workspace);
      if (!value) {
        value = { ids: new Set(), anonymous: 0, last_active_at: null };
        activity.set(workspace, value);
      }
      if (sessionId === null) value.anonymous++;
      else value.ids.add(sessionId);
      if (at && (!value.last_active_at || at > value.last_active_at)) value.last_active_at = at;
    };
  try {
    for (const line of readFileSync(path.join(home, "history.jsonl"), "utf8").split(/\r?\n/)) {
      if (!line) continue;
      let row: Record<string, unknown> | null;
      try {
        row = asRecord(JSON.parse(line));
      } catch {
        continue;
      }
      if (typeof row?.project !== "string") continue;
      merge(row.project, sessionId(row), jsonTimestamp(row.timestamp));
    }
  } catch {}
  const projects = path.join(home, "projects");
  if (statRoot(projects))
    walkFiles(projects, 3, (file) => {
      if (path.basename(file) !== "sessions-index.json") return;
      const document = JSON.parse(readFileSync(file, "utf8")),
        rows = Array.isArray(document?.entries)
          ? document.entries
          : Array.isArray(document)
            ? document
            : [];
      for (const item of rows) {
        const row = asRecord(item);
        if (typeof row?.projectPath !== "string") continue;
        const modified = row.modified ?? row.modifiedAt ?? row.lastActivityAt;
        merge(row.projectPath, sessionId(row), jsonTimestamp(modified));
      }
    });
  const candidates = [...activity.entries()].map(([cwd, value]) =>
    candidate(
      cwd,
      "claude-code",
      "session-cwd",
      value.last_active_at,
      false,
      Math.min(Number.MAX_SAFE_INTEGER, value.ids.size + value.anonymous),
    ),
  );
  return {
    candidates,
    errors: [],
    status: candidates.length ? "succeeded" : "empty",
    reasons: [],
  };
}

function sessionId(value: Record<string, unknown>): string | null {
  for (const key of ["sessionId", "session_id", "id"])
    if (typeof value[key] === "string") return value[key] as string;
  return null;
}

function readGrok(environment: NodeJS.ProcessEnv): ProviderResult {
  const result = new GrokSessions(environment).list(null),
    candidates = result.sessions.flatMap(({ cwd, session }) =>
      cwd
        ? [
            {
              ...candidate(cwd, "grok-build", "session-cwd", session.updated_at, false, 1),
              session_cwds: [cwd],
            },
          ]
        : [],
    );
  return {
    candidates,
    errors: [],
    status: result.incomplete ? "partial" : candidates.length ? "succeeded" : "empty",
    reasons: result.incomplete ? ["source-read-failed"] : [],
  };
}

function readOpenClaw(home: string, environment: NodeJS.ProcessEnv): ProviderResult {
  const candidates: DiscoveryCandidate[] = [],
    errors: string[] = [],
    source_diagnostics: Record<string, unknown>[] = [],
    config = path.join(home, "openclaw.json");
  const configStarted = utcNow();
  try {
    const root = asRecord(JSON5.parse(readFileSync(config, "utf8")));
    if (!root) throw new Error("OpenClaw configuration must be an object");
    const agents = asRecord(root.agents),
      defaults = asRecord(agents?.defaults),
      add = (value: unknown) => {
        if (typeof value !== "string") return;
        const expanded =
          value === "~"
            ? userHome(environment)
            : value.startsWith("~/")
              ? path.join(userHome(environment), value.slice(2))
              : value;
        candidates.push(
          candidate(
            path.isAbsolute(expanded) ? expanded : path.resolve(home, expanded),
            "open-claw",
            "configured-workspace",
            null,
            true,
          ),
        );
      };
    add(defaults?.workspace);
    for (const key of ["list", "entries"])
      for (const item of Array.isArray(agents?.[key]) ? agents[key] : [])
        add(asRecord(item)?.workspace);
    const count = candidates.filter((value) => value.evidence === "configured-workspace").length;
    source_diagnostics.push(
      providerDiagnostic(
        "open-claw",
        "config",
        config,
        configStarted,
        count ? "succeeded" : "empty",
        count,
        [],
      ),
    );
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT",
      detail = missing ? null : String(error);
    if (detail) errors.push(detail);
    source_diagnostics.push(
      providerDiagnostic(
        "open-claw",
        "config",
        config,
        configStarted,
        missing ? "missing" : "failed",
        null,
        [missing ? "missing-file" : "source-read-failed"],
      ),
    );
  }
  const sessionsRoot = path.join(home, "agents"),
    sessionsStarted = utcNow();
  const result = new OpenClawSessions(environment).list(null);
  for (const { cwd, session } of result.sessions) {
    if (!cwd) continue;
    candidates.push({
      ...candidate(cwd, "open-claw", "session-cwd", session.updated_at, false, 1),
      session_cwds: [cwd],
    });
  }
  source_diagnostics.push(
    providerDiagnostic(
      "open-claw",
      "sessions-jsonl",
      sessionsRoot,
      sessionsStarted,
      result.incomplete
        ? "partial"
        : result.sessions.length
          ? "succeeded"
          : isDirectory(sessionsRoot)
            ? "empty"
            : "missing",
      result.incomplete ? null : result.sessions.length,
      result.incomplete
        ? ["source-read-failed"]
        : isDirectory(sessionsRoot)
          ? []
          : ["missing-directory"],
    ),
  );
  const incomplete = result.incomplete || errors.length > 0;
  return {
    candidates,
    errors,
    status: incomplete ? "partial" : candidates.length ? "succeeded" : "empty",
    reasons: incomplete ? ["source-read-failed"] : [],
    source_diagnostics,
  };
}

function readHermes(environment: NodeJS.ProcessEnv): ProviderResult {
  const result = new HermesSessions(environment).list(null),
    candidates = result.sessions.flatMap(({ cwd, session }) =>
      cwd
        ? [
            {
              ...candidate(cwd, "hermes", "session-cwd", session.updated_at, false, 1),
              session_cwds: [cwd],
            },
          ]
        : [],
    );
  return {
    candidates,
    errors: [],
    status: result.incomplete ? "partial" : candidates.length ? "succeeded" : "empty",
    reasons: result.incomplete ? ["source-read-failed"] : [],
  };
}

function walkFiles(root: string, maxDepth: number, visit: (file: string) => void): void {
  const base = statRoot(root);
  if (!base) return;
  const stack = [{ directory: root, depth: 0 }];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current.directory, { withFileTypes: true })) {
      const value = path.join(current.directory, entry.name),
        metadata = lstatSync(value, { bigint: true });
      if (isReparseOrSymlink(value, metadata) || metadata.dev !== base.device) continue;
      if (metadata.isFile()) visit(value);
      else if (metadata.isDirectory() && current.depth + 1 < maxDepth)
        stack.push({ directory: value, depth: current.depth + 1 });
    }
  }
}

function readCodex(home: string, environment: NodeJS.ProcessEnv): ProviderResult {
  let metadata;
  try {
    metadata = lstatSync(home);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { candidates: [], errors: [], status: "missing", reasons: ["missing-directory"] };
    throw error;
  }
  if (isReparseOrSymlink(home, metadata) || !metadata.isDirectory())
    return { candidates: [], errors: [], status: "empty", reasons: [] };
  const ownership = new CodexSessionOwnership(home, environment);
  const candidates: DiscoveryCandidate[] = [],
    nonWorkspacePaths: string[] = [];
  let incomplete = false;
  const files = readdirSync(home).filter(
    (name) => name.startsWith("state_") && name.endsWith(".sqlite"),
  );
  for (const file of files) {
    const database = new DatabaseSync(path.join(home, file), { readOnly: true });
    try {
      const sql = new Sql(database);
      const columns = new Set(
        sql.rows("PRAGMA table_info(threads)").map((row) => String(row.name)),
      );
      if (!columns.has("cwd") || !columns.has("id")) {
        incomplete = true;
        continue;
      }
      const timestamps = [
        "recency_at_ms",
        "updated_at_ms",
        "recency_at",
        "updated_at",
        "created_at_ms",
        "created_at",
      ].filter((name) => columns.has(name));
      const timestampExpression =
        timestamps.length > 1 ? `COALESCE(${timestamps.join(",")})` : (timestamps[0] ?? "NULL");
      for (const row of sql.rows(
        `SELECT id,cwd,${columns.has("project_id") ? "project_id" : "NULL"} AS project_id,${timestampExpression} AS updated FROM threads WHERE cwd IS NOT NULL AND cwd != ''`,
      )) {
        if (typeof row.cwd !== "string") throw new Error("Codex workspace path is invalid");
        if (ownership.collection(String(row.id), row.cwd, row.project_id))
          nonWorkspacePaths.push(row.cwd);
        else
          candidates.push(
            candidate(row.cwd, "codex", "session-cwd", integerTimestamp(row.updated), false, 1),
          );
      }
    } finally {
      database.close();
    }
  }
  // A cwd shared by a real project and a projectless thread is still a workspace.
  const projectPaths = new Set(candidates.map((candidate) => pathIdentity(candidate.path)));
  const non_workspace_paths = incomplete
    ? []
    : [...new Set(nonWorkspacePaths)].filter((value) => !projectPaths.has(pathIdentity(value)));
  return {
    candidates,
    non_workspace_paths,
    errors: [],
    status: incomplete ? "partial" : candidates.length ? "succeeded" : "empty",
    reasons: incomplete ? ["source-read-failed"] : [],
  };
}

function readCursor(storage: string) {
  const started = statRoot(storage),
    candidates: DiscoveryCandidate[] = [],
    errors: string[] = [];
  if (started === null)
    return {
      candidates,
      errors,
      status: "missing",
      reasons: ["missing-directory"],
    };
  const directories = readdirSync(storage, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => path.join(storage, entry.name));
  for (const directory of directories) {
    const file = path.join(directory, "workspace.json");
    try {
      const metadata = lstatSync(directory, { bigint: true });
      if (isReparseOrSymlink(directory, metadata) || metadata.dev !== started.device) continue;
      const fileMetadata = lstatSync(file, { bigint: true });
      if (isReparseOrSymlink(file, fileMetadata) || !fileMetadata.isFile()) continue;
      const parsed = asRecord(JSON.parse(readFileSync(file, "utf8"))),
        uri = parsed?.folder ?? parsed?.workspace,
        workspace = typeof uri === "string" ? fileUriPath(uri) : null;
      if (!workspace) continue;
      candidates.push(candidate(workspace, "cursor", "configured-workspace", fileTime(file)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(String(error));
    }
  }
  return {
    candidates,
    errors,
    status: errors.length ? "partial" : candidates.length ? "succeeded" : "empty",
    reasons: errors.length ? ["source-read-failed"] : [],
  };
}

function readDeepSeek(file: string) {
  let metadata;
  try {
    metadata = lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { candidates: [], errors: [], status: "missing", reasons: ["missing-file"] };
    throw error;
  }
  if (isReparseOrSymlink(file, metadata))
    return { candidates: [], errors: [], status: "missing", reasons: ["unsafe-source"] };
  if (!metadata.isFile())
    return { candidates: [], errors: [], status: "missing", reasons: ["missing-file"] };
  const document = asRecord(JSON.parse(readFileSync(file, "utf8"))),
    unit = asRecord(document?.unit),
    tables = asRecord(document?.tables),
    records = asRecord(tables?.workspaces);
  if (unit?.name !== "workspace" || unit.version !== 2)
    throw new Error("DeepSeek Harness workspace storage version is not supported");
  if (!records) throw new Error("DeepSeek Harness workspace storage has no workspaces table");
  const candidates = Object.values(records).flatMap((recordValue) => {
    const row = asRecord(recordValue);
    if (typeof row?.path !== "string") return [];
    const discovered = candidate(
        row.path,
        "deepseek-harness",
        "configured-workspace",
        jsonTimestamp(row.updatedAt),
        true,
      ),
      count = Array.isArray(row.sessionIds) ? row.sessionIds.length : 0;
    discovered.session_count = count;
    discovered.display_name = typeof row.title === "string" && row.title.trim() ? row.title : null;
    return [discovered];
  });
  return {
    candidates,
    errors: [],
    status: candidates.length ? "succeeded" : "empty",
    reasons: [],
  };
}

function candidate(
  value: string,
  agent: string,
  evidence: string,
  last_active_at: string | null,
  explicit = false,
  session_count = 0,
): DiscoveryCandidate {
  return {
    path: value,
    source_agent: agent,
    evidence,
    last_active_at,
    session_count,
    repository_group_id: null,
    explicit_workspace: explicit,
  } satisfies DiscoveryCandidate;
}

function count(value: unknown): number {
  if (typeof value === "bigint")
    return Number(
      value > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : value,
    );
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function integerTimestamp(value: unknown): string | null {
  if (typeof value === "bigint") {
    if (value <= 0n) return null;
    const milliseconds = value > 10_000_000_000n ? Number(value) : Number(value) * 1000,
      date = new Date(milliseconds);
    return Number.isFinite(date.valueOf()) ? date.toISOString().replace(".000Z", "Z") : null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value > 10_000_000_000 ? value : value * 1000);
  return Number.isFinite(date.valueOf()) ? date.toISOString().replace(".000Z", "Z") : null;
}

function fileUriPath(value: string): string | null {
  if (!value.startsWith("file://")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value.slice("file://".length));
  } catch {
    return null;
  }
  if (process.platform !== "win32") return decoded;
  let normalized = decoded.replaceAll("/", "\\");
  if (normalized.startsWith("localhost\\")) normalized = normalized.slice("localhost\\".length);
  if (normalized.startsWith("\\\\")) return normalized;
  if (/^\\[A-Za-z]:/.test(normalized)) return normalized.slice(1);
  if (/^[A-Za-z]:/.test(normalized)) return normalized;
  return `\\\\${normalized}`;
}

function statRoot(value: string): { device: bigint } | null {
  try {
    const metadata = lstatSync(value, { bigint: true });
    if (isReparseOrSymlink(value, metadata) || !metadata.isDirectory()) return null;
    return { device: metadata.dev };
  } catch {
    return null;
  }
}
