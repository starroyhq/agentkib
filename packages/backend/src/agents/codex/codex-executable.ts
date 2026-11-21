import path from "node:path";
import { statSync } from "node:fs";
import { resolveCommand, resolveCommands } from "../../command-resolution";
import { pathIdentity } from "../../paths";

/**
 * Where the Codex desktop app keeps the CLI it runs, inside its bundle. ChatGPT.app 26.1106
 * ships `Contents/Resources/codex-cli/bin/codex`, a launcher for the `CodexCLI.app` beside
 * it; standalone Codex.app builds kept a single `Contents/Resources/codex`.
 */
const DESKTOP_CLIS = [
  "ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
  "Codex.app/Contents/Resources/codex-cli/bin/codex",
  "Codex.app/Contents/Resources/codex",
];

function executableFile(file: string): boolean {
  try {
    const info = statSync(file);
    return info.isFile() && (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Folders macOS installs apps into: the system one, then the user's own. */
export function applicationDirectories(environment: NodeJS.ProcessEnv): string[] {
  return [
    "/Applications",
    ...(environment.HOME ? [path.join(environment.HOME, "Applications")] : []),
  ];
}

/** The CLIs the Codex desktop app ships on this Mac; none elsewhere. */
export function codexDesktopExecutables(
  environment: NodeJS.ProcessEnv,
  directories = applicationDirectories(environment),
): string[] {
  if (process.platform !== "darwin") return [];
  return directories
    .flatMap((directory) => DESKTOP_CLIS.map((file) => path.join(directory, file)))
    .filter(executableFile);
}

/**
 * Every Codex CLI AgentKib may run, in the order it tries them: the one PATH finds, other
 * installs in the usual places, then the copies the desktop app ships. The first that can
 * write is used, so an old or missing CLI on PATH no longer leaves Codex sessions read-only
 * while the desktop app has a current one.
 */
export function codexExecutables(environment: NodeJS.ProcessEnv): string[] {
  const seen = new Set<string>();
  return [...resolveCommands("codex", environment), ...codexDesktopExecutables(environment)].filter(
    (file) => {
      const identity = pathIdentity(file);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    },
  );
}

/**
 * A Codex CLI for reads, which any version serves, without running anything: the one PATH
 * finds, else the desktop app's.
 */
export function codexExecutable(environment: NodeJS.ProcessEnv): string | null {
  return resolveCommand("codex", environment) ?? codexDesktopExecutables(environment)[0] ?? null;
}
