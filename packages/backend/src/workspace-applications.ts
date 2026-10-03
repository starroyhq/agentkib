import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCommand, commandDirectories } from "./command-resolution";
import { canonicalize } from "./paths";
import { Commands } from "./commands";
import { readPreferences, writePreference } from "./preferences";

export type WorkspaceApplicationCategory = "editor" | "terminal" | "file-manager";
export interface WorkspaceApplication {
  id: string;
  name: string;
  category: WorkspaceApplicationCategory;
  preferred: boolean;
}
interface ApplicationSpec {
  id: string;
  name: string;
  category: WorkspaceApplicationCategory;
  commands?: string[];
  desktopIds?: string[];
  macNames?: string[];
  bundleIds?: string[];
}
interface DetectedApplication extends Omit<WorkspaceApplication, "preferred"> {
  launcher: { program: string; args: string[]; cwd?: string };
}

const macSpecs: ApplicationSpec[] = [
  {
    id: "finder",
    name: "Finder",
    category: "file-manager",
    macNames: ["Finder.app"],
    bundleIds: ["com.apple.finder"],
  },
  {
    id: "terminal",
    name: "Terminal",
    category: "terminal",
    macNames: ["Terminal.app"],
    bundleIds: ["com.apple.Terminal"],
  },
  {
    id: "iterm2",
    name: "iTerm2",
    category: "terminal",
    macNames: ["iTerm.app"],
    bundleIds: ["com.googlecode.iterm2"],
  },
  {
    id: "vscode",
    name: "Visual Studio Code",
    category: "editor",
    macNames: ["Visual Studio Code.app"],
    bundleIds: ["com.microsoft.VSCode"],
  },
  {
    id: "cursor",
    name: "Cursor",
    category: "editor",
    macNames: ["Cursor.app"],
    bundleIds: ["com.todesktop.230313mzl4w4u92"],
  },
  {
    id: "xcode",
    name: "Xcode",
    category: "editor",
    macNames: ["Xcode.app"],
    bundleIds: ["com.apple.dt.Xcode"],
  },
  {
    id: "android-studio",
    name: "Android Studio",
    category: "editor",
    macNames: ["Android Studio.app"],
    bundleIds: ["com.google.android.studio"],
  },
  {
    id: "intellij-idea",
    name: "IntelliJ IDEA",
    category: "editor",
    macNames: ["IntelliJ IDEA.app", "IntelliJ IDEA CE.app"],
    bundleIds: ["com.jetbrains.intellij", "com.jetbrains.intellij.ce"],
  },
  {
    id: "pycharm",
    name: "PyCharm",
    category: "editor",
    macNames: ["PyCharm.app", "PyCharm CE.app"],
    bundleIds: ["com.jetbrains.pycharm", "com.jetbrains.pycharm.ce"],
  },
  {
    id: "webstorm",
    name: "WebStorm",
    category: "editor",
    macNames: ["WebStorm.app"],
    bundleIds: ["com.jetbrains.WebStorm"],
  },
  {
    id: "goland",
    name: "GoLand",
    category: "editor",
    macNames: ["GoLand.app"],
    bundleIds: ["com.jetbrains.goland"],
  },
  {
    id: "rider",
    name: "Rider",
    category: "editor",
    macNames: ["Rider.app"],
    bundleIds: ["com.jetbrains.rider"],
  },
];
const windowsSpecs: ApplicationSpec[] = [
  { id: "vscode", name: "Visual Studio Code", category: "editor", commands: ["code.exe"] },
  { id: "cursor", name: "Cursor", category: "editor", commands: ["cursor.exe"] },
  {
    id: "android-studio",
    name: "Android Studio",
    category: "editor",
    commands: ["studio64.exe", "studio.exe"],
  },
  { id: "intellij-idea", name: "IntelliJ IDEA", category: "editor", commands: ["idea64.exe"] },
  { id: "pycharm", name: "PyCharm", category: "editor", commands: ["pycharm64.exe"] },
  { id: "webstorm", name: "WebStorm", category: "editor", commands: ["webstorm64.exe"] },
  { id: "goland", name: "GoLand", category: "editor", commands: ["goland64.exe"] },
  { id: "rider", name: "Rider", category: "editor", commands: ["rider64.exe"] },
];
const linuxSpecs: ApplicationSpec[] = [
  {
    id: "vscode",
    name: "Visual Studio Code",
    category: "editor",
    commands: ["code"],
    desktopIds: ["code", "visual-studio-code"],
  },
  {
    id: "cursor",
    name: "Cursor",
    category: "editor",
    commands: ["cursor"],
    desktopIds: ["cursor", "cursor-url-handler"],
  },
  {
    id: "android-studio",
    name: "Android Studio",
    category: "editor",
    commands: ["studio", "android-studio"],
    desktopIds: ["android-studio"],
  },
  {
    id: "intellij-idea",
    name: "IntelliJ IDEA",
    category: "editor",
    commands: ["idea", "intellij-idea"],
    desktopIds: ["jetbrains-idea", "intellij-idea", "idea"],
  },
  {
    id: "pycharm",
    name: "PyCharm",
    category: "editor",
    commands: ["pycharm", "pycharm-community"],
    desktopIds: ["jetbrains-pycharm", "pycharm", "pycharm-community"],
  },
  {
    id: "webstorm",
    name: "WebStorm",
    category: "editor",
    commands: ["webstorm"],
    desktopIds: ["jetbrains-webstorm", "webstorm"],
  },
  {
    id: "goland",
    name: "GoLand",
    category: "editor",
    commands: ["goland"],
    desktopIds: ["jetbrains-goland", "goland"],
  },
  {
    id: "rider",
    name: "Rider",
    category: "editor",
    commands: ["rider"],
    desktopIds: ["jetbrains-rider", "rider"],
  },
];

export class WorkspaceApplications {
  constructor(
    readonly dataDir: string,
    readonly commands: Commands,
    readonly environment: NodeJS.ProcessEnv,
    readonly workspacePath: (workspaceId: string) => string,
  ) {}

  async list(workspaceId: string): Promise<WorkspaceApplication[]> {
    this.workspacePath(workspaceId);
    const detected = await detectApplications(this.commands, this.environment);
    const preferences = readPreferences(this.dataDir).workspace_openers as
      | { global_recent?: unknown; by_workspace?: Record<string, unknown> }
      | undefined;
    const preferred =
      (typeof preferences?.by_workspace?.[workspaceId] === "string" &&
      detected.some((application) => application.id === preferences.by_workspace![workspaceId])
        ? preferences.by_workspace[workspaceId]
        : undefined) ??
      (typeof preferences?.global_recent === "string" &&
      detected.some((application) => application.id === preferences.global_recent)
        ? preferences.global_recent
        : undefined) ??
      detected.find((application) => application.category === "file-manager")?.id;
    return detected.map(({ launcher: _launcher, ...application }) => ({
      ...application,
      preferred: application.id === preferred,
    }));
  }

  async open(workspaceId: string, openerId?: string): Promise<void> {
    const workspace = canonicalize(this.workspacePath(workspaceId));
    if (!statSync(workspace).isDirectory()) throw new Error("workspace is not a directory");
    const detected = await detectApplications(this.commands, this.environment);
    const preferences = readPreferences(this.dataDir).workspace_openers as
      | { global_recent?: unknown; by_workspace?: Record<string, unknown> }
      | undefined;
    const installed = (value: unknown) =>
      typeof value === "string" && detected.some((application) => application.id === value);
    const selected =
      openerId ??
      (installed(preferences?.by_workspace?.[workspaceId])
        ? preferences?.by_workspace?.[workspaceId]
        : installed(preferences?.global_recent)
          ? preferences?.global_recent
          : detected.find((application) => application.category === "file-manager")?.id);
    const application = detected.find((candidate) => candidate.id === selected);
    if (!application)
      throw new Error(
        selected
          ? `Workspace opener is not installed: ${selected}`
          : "No workspace opener is available",
      );
    await launchDetached(application.launcher, workspace);
    if (openerId) {
      const current = readPreferences(this.dataDir).workspace_openers as
        | { global_recent?: unknown; by_workspace?: Record<string, unknown> }
        | undefined;
      writePreference(this.dataDir, "workspace_openers", {
        global_recent: selected,
        by_workspace: { ...(current?.by_workspace ?? {}), [workspaceId]: selected },
      });
    }
  }
}

async function detectApplications(
  commands: Commands,
  environment: NodeJS.ProcessEnv,
): Promise<DetectedApplication[]> {
  const platform = process.platform;
  let applications: DetectedApplication[];
  if (platform === "darwin") applications = await macApplications(commands, environment);
  else if (platform === "win32") applications = await windowsApplications(commands, environment);
  else if (platform === "linux") applications = await linuxApplications(environment);
  else applications = [];
  const seen = new Set<string>();
  return applications.filter((application) => {
    if (seen.has(application.id)) return false;
    seen.add(application.id);
    return true;
  });
}

async function macApplications(
  commands: Commands,
  environment: NodeJS.ProcessEnv,
): Promise<DetectedApplication[]> {
  const home = environment.HOME ?? os.homedir();
  const roots = [
    "/Applications",
    "/System/Applications",
    "/System/Applications/Utilities",
    "/System/Library/CoreServices",
    path.join(home, "Applications"),
  ];
  const output: DetectedApplication[] = [];
  for (const spec of macSpecs) {
    let found: string | undefined;
    for (const appName of spec.macNames ?? []) {
      for (const root of roots) {
        const application = path.join(root, appName);
        if (!existsSync(path.join(application, "Contents", "Info.plist"))) continue;
        try {
          const executables = readdirSync(path.join(application, "Contents", "MacOS"));
          if (
            !executables.some((name) =>
              existsSync(path.join(application, "Contents", "MacOS", name)),
            )
          )
            continue;
          const result = await commands.run(
            "/usr/libexec/PlistBuddy",
            ["-c", "Print :CFBundleIdentifier", path.join(application, "Contents", "Info.plist")],
            { timeout: 3000, limit: 4096, allowFailure: true },
          );
          const bundleId = result.bytes.toString("utf8").trim();
          if (result.success && spec.bundleIds?.includes(bundleId)) found = application;
        } catch {}
        if (found) break;
      }
      if (found) break;
    }
    if (found)
      output.push({
        id: spec.id,
        name: spec.name,
        category: spec.category,
        launcher: { program: "/usr/bin/open", args: ["-a", found] },
      });
  }
  return output;
}

async function windowsApplications(
  commands: Commands,
  environment: NodeJS.ProcessEnv,
): Promise<DetectedApplication[]> {
  const output: DetectedApplication[] = [];
  const explorer = resolveCommand("explorer.exe", environment);
  if (explorer)
    output.push({
      id: "explorer",
      name: "File Explorer",
      category: "file-manager",
      launcher: { program: explorer, args: [] },
    });
  const terminal = resolveCommand("wt.exe", environment);
  if (terminal)
    output.push({
      id: "windows-terminal",
      name: "Windows Terminal",
      category: "terminal",
      launcher: { program: terminal, args: ["-d"] },
    });
  const directories = windowsApplicationDirectories(environment);
  for (const spec of windowsSpecs) {
    let found: string | undefined;
    for (const executableName of spec.commands ?? []) {
      found =
        resolveCommand(executableName, environment) ??
        resolveInDirectories(executableName, directories);
      if (!found) found = await windowsAppPath(executableName, commands, environment);
      if (found) break;
    }
    if (found)
      output.push({
        id: spec.id,
        name: spec.name,
        category: spec.category,
        launcher: { program: found, args: [] },
      });
  }
  return output;
}

function windowsApplicationDirectories(environment: NodeJS.ProcessEnv): string[] {
  const roots = [
    envValue(environment, "LOCALAPPDATA"),
    envValue(environment, "ProgramFiles"),
    envValue(environment, "ProgramFiles(x86)"),
  ].filter((value): value is string => !!value);
  const directories = commandDirectories(environment);
  for (const root of roots) {
    directories.push(
      path.join(root, "Programs", "Microsoft VS Code", "bin"),
      path.join(root, "Programs", "Microsoft VS Code"),
      path.join(root, "Programs", "Cursor", "resources", "app", "bin"),
      path.join(root, "Programs", "Cursor"),
      path.join(root, "JetBrains", "Toolbox", "scripts"),
    );
    collectDirectories(path.join(root, "JetBrains", "Toolbox", "apps"), 5, directories);
  }
  return [...new Set(directories)];
}

function collectDirectories(root: string, depth: number, output: string[]): void {
  if (!depth) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  if (path.basename(root).toLowerCase() === "bin") output.push(root);
  for (const entry of entries)
    if (entry.isDirectory() && !entry.isSymbolicLink())
      collectDirectories(path.join(root, entry.name), depth - 1, output);
}

async function windowsAppPath(
  executable: string,
  commands: Commands,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const roots = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths",
  ];
  for (const root of roots) {
    const result = await commands
      .run("reg.exe", ["query", `${root}\\${executable}`, "/ve"], {
        env: environment,
        timeout: 1500,
        limit: 8192,
        allowFailure: true,
      })
      .catch(() => undefined);
    const line = result?.bytes
      .toString("utf8")
      .split(/\r?\n/)
      .find((value) => /REG_(?:EXPAND_)?SZ\s+/i.test(value));
    const raw = line
      ?.replace(/^.*?REG_(?:EXPAND_)?SZ\s+/i, "")
      .trim()
      .replace(/^"|"$/g, "");
    if (result?.success && raw) {
      const expanded = raw.replace(
        /%([^%]+)%/g,
        (match, key: string) => envValue(environment, key) ?? match,
      );
      if (isExecutable(expanded)) return expanded;
    }
  }
  return undefined;
}

async function linuxApplications(environment: NodeJS.ProcessEnv): Promise<DetectedApplication[]> {
  const output: DetectedApplication[] = [];
  const fileManager = resolveCommand("xdg-open", environment);
  if (fileManager)
    output.push({
      id: "files",
      name: "Files",
      category: "file-manager",
      launcher: { program: fileManager, args: [] },
    });
  const directories = commandDirectories(environment);
  for (const spec of linuxSpecs) {
    let executable = spec.commands?.map((name) => resolveCommand(name, environment)).find(Boolean);
    if (!executable)
      executable = desktopExecutables(spec.desktopIds ?? [], directories, environment)[0];
    if (executable)
      output.push({
        id: spec.id,
        name: spec.name,
        category: spec.category,
        launcher: { program: executable, args: [] },
      });
  }
  const terminal = [
    "xdg-terminal-exec",
    "x-terminal-emulator",
    "gnome-terminal",
    "konsole",
    "kitty",
    "alacritty",
  ]
    .map((name) => resolveCommand(name, environment))
    .find(Boolean);
  if (terminal)
    output.push({
      id: "terminal",
      name: "Terminal",
      category: "terminal",
      launcher: { program: terminal, args: [], cwd: "workspace" },
    });
  return output;
}

function desktopExecutables(
  ids: string[],
  searchDirectories: string[],
  environment: NodeJS.ProcessEnv,
): string[] {
  const home = environment.HOME ?? os.homedir();
  const dataHome = envValue(environment, "XDG_DATA_HOME") || path.join(home, ".local", "share");
  const roots = [
    dataHome,
    ...(envValue(environment, "XDG_DATA_DIRS") || "/usr/local/share:/usr/share").split(":"),
  ].map((root) => path.join(root, "applications"));
  const normalized = ids.map((id) => id.replace(/\.desktop$/i, "").toLowerCase());
  const output: string[] = [];
  for (const root of roots)
    for (const file of desktopFiles(root, 2)) {
      const stem = path.basename(file, ".desktop").toLowerCase();
      if (!normalized.some((id) => stem === id || stem.startsWith(`${id}-`))) continue;
      let content: string;
      try {
        content = requireReadFile(file);
      } catch {
        continue;
      }
      let section = false,
        exec: string | undefined,
        tryExec: string | undefined,
        hasTryExec = false;
      for (const line of content.split(/\r?\n/)) {
        const value = line.trim();
        if (value.startsWith("[") && value.endsWith("]")) {
          section = value === "[Desktop Entry]";
          continue;
        }
        if (!section || value.startsWith("#")) continue;
        if (value.startsWith("TryExec=")) {
          hasTryExec = true;
          tryExec = firstExec(value.slice(8));
        } else if (value.startsWith("Exec=")) exec = firstExec(value.slice(5));
      }
      const command = hasTryExec ? tryExec : exec;
      if (
        command &&
        !["sh", "bash", "dash", "zsh", "fish", "flatpak", "snap"].includes(path.basename(command))
      ) {
        const resolved = resolveCommandIn(command, searchDirectories, environment);
        if (resolved) output.push(resolved);
      }
    }
  return [...new Set(output)];
}

function desktopFiles(root: string, depth: number): string[] {
  if (!depth) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (entry.isSymbolicLink()) return [];
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) return desktopFiles(child, depth - 1);
    return entry.isFile() && entry.name.endsWith(".desktop") ? [child] : [];
  });
}

function firstExec(value: string): string | undefined {
  const tokens = value.match(/(?:[^\s"\\]|\\.|"(?:[^"\\]|\\.)*")+/g);
  if (!tokens) return undefined;
  const unquote = (token: string) => token.replace(/^"|"$/g, "").replace(/\\(.)/g, "$1");
  const parts = tokens.map(unquote);
  let index = parts[0] === "env" ? 1 : 0;
  while (parts[index]?.startsWith("-") || /^[^/]+=/.test(parts[index] ?? "")) index++;
  const command = parts[index];
  return command && !command.includes("%") ? command : undefined;
}

function resolveInDirectories(command: string, directories: string[]): string | undefined {
  for (const directory of directories) {
    const candidate = path.join(directory, command);
    if (isExecutable(candidate)) return candidate;
    if (process.platform === "win32")
      for (const extension of [".COM", ".EXE", ".BAT", ".CMD"])
        if (isExecutable(candidate + extension)) return candidate + extension;
  }
  return undefined;
}

function resolveCommandIn(
  command: string,
  directories: string[],
  environment: NodeJS.ProcessEnv,
): string | undefined {
  return path.isAbsolute(command)
    ? isExecutable(command)
      ? command
      : undefined
    : (resolveInDirectories(command, directories) ??
        resolveCommand(command, environment) ??
        undefined);
}

function isExecutable(file: string): boolean {
  try {
    const metadata = statSync(file);
    return metadata.isFile() && (process.platform === "win32" || (metadata.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

function envValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const key =
    process.platform === "win32"
      ? Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
      : name;
  return key ? environment[key] : undefined;
}

function requireReadFile(file: string): string {
  return readFileSync(file, "utf8");
}

async function launchDetached(
  launcher: DetectedApplication["launcher"],
  workspace: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const args = [...launcher.args];
    if (launcher.cwd === "workspace") {
      const child = spawn(launcher.program, args, {
        cwd: workspace,
        detached: process.platform !== "win32",
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    } else {
      const child = spawn(launcher.program, [...args, workspace], {
        detached: process.platform !== "win32",
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    }
  });
}
