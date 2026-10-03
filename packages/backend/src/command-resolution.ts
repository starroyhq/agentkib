import path from "node:path";
import { readdirSync, statSync } from "node:fs";
import { pathIdentity } from "./paths";
import { compareUtf8 } from "./workspaces";

/** Common native command lookup; diagnostic-only registry roots must not change this order. */
export function commandDirectories(env: NodeJS.ProcessEnv = process.env): string[] {
  const directories: string[] = [];
  const environment = (name: string) =>
    process.platform === "win32"
      ? env[Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase()) ?? name]
      : env[name];
  const inherited = environment("PATH");
  if (inherited !== undefined) {
    if (process.platform !== "win32") directories.push(...inherited.split(":"));
    else {
      let quoted = false,
        value = "";
      for (const character of inherited) {
        if (character === '"') quoted = !quoted;
        else if (character === ";" && !quoted) {
          directories.push(value);
          value = "";
        } else value += character;
      }
      directories.push(value);
    }
  }
  const append = (name: string, suffix?: string) => {
    const value = environment(name);
    if (value !== undefined) directories.push(suffix ? path.join(value, suffix) : value);
  };
  const home = environment("HOME");
  if (process.platform === "win32") {
    append("APPDATA", "npm");
    append("LOCALAPPDATA", "pnpm");
    append("PNPM_HOME");
    for (const suffix of [
      "Programs",
      "Microsoft/WindowsApps",
      "Programs/cursor/resources/app/bin",
      "Programs/Cursor/resources/app/bin",
    ])
      append("LOCALAPPDATA", suffix);
  } else if (process.platform === "darwin") {
    directories.push("/usr/bin", "/usr/local/bin", "/opt/homebrew/bin");
    if (home !== undefined)
      for (const suffix of [
        ".local/bin",
        ".cargo/bin",
        ".bun/bin",
        ".npm-global/bin",
        "Library/pnpm",
      ])
        directories.push(path.join(home, suffix));
  } else if (process.platform === "linux") {
    directories.push("/usr/bin", "/usr/local/bin");
    if (home !== undefined) {
      const configured = environment("XDG_DATA_HOME"),
        data =
          configured && path.isAbsolute(configured) ? configured : path.join(home, ".local/share");
      for (const suffix of [".local/bin", ".cargo/bin", ".bun/bin", ".npm-global/bin"])
        directories.push(path.join(home, suffix));
      directories.push(
        path.join(data, "pnpm"),
        path.join(home, ".asdf/shims"),
        path.join(data, "mise/shims"),
      );
      try {
        const root = path.join(home, ".nvm/versions/node");
        directories.push(
          ...readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
            .map((entry) => path.join(root, entry.name, "bin"))
            .sort(compareUtf8),
        );
      } catch {}
    }
    append("PNPM_HOME");
    append("NVM_BIN");
    append("ASDF_DATA_DIR", "shims");
    append("MISE_DATA_DIR", "shims");
    append("npm_config_prefix", "bin");
    directories.push("/snap/bin");
  }
  const seen = new Set<string>();
  return directories.filter((directory) => {
    const identity = pathIdentity(directory);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}
export function resolveCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string | null {
  const extensions: string[] = [];
  if (process.platform === "win32") {
    const configured =
      env[Object.keys(env).find((key) => key.toUpperCase() === "PATHEXT") ?? "PATHEXT"];
    extensions.push(
      ...(configured ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => (value.startsWith(".") ? value : "." + value)),
    );
    for (const required of [".COM", ".EXE", ".BAT", ".CMD"])
      if (!extensions.some((value) => value.toUpperCase() === required)) extensions.push(required);
  }
  const candidates = (file: string) =>
    !extensions.length || path.extname(file)
      ? [file]
      : extensions.map((extension) => file + extension);
  const roots =
    path.isAbsolute(command) ||
    command.includes(path.sep) ||
    (process.platform === "win32" && command.includes("/"))
      ? [path.resolve(cwd, command)]
      : commandDirectories(env).map((directory) => path.resolve(cwd, directory, command));
  for (const root of roots)
    for (const candidate of candidates(root)) {
      try {
        const metadata = statSync(candidate);
        if (metadata.isFile() && (process.platform === "win32" || (metadata.mode & 0o111) !== 0))
          return candidate;
      } catch {}
    }
  return null;
}

/** Enumerate installations without changing the default runtime lookup order. */
export function resolveCommands(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  additionalDirectories: string[] = [],
): string[] {
  const primary = resolveCommand(command, env);
  const candidates =
    path.isAbsolute(command) || command.includes(path.sep)
      ? [primary]
      : [
          primary,
          ...[...commandDirectories(env), ...additionalDirectories].map((directory) =>
            resolveCommand(path.resolve(directory, command), env),
          ),
        ];
  const seen = new Set<string>();
  return candidates.filter((candidate): candidate is string => {
    if (!candidate) return false;
    const identity = pathIdentity(candidate);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}
