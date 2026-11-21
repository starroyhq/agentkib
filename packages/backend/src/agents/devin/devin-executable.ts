import path from "node:path";
import { statSync } from "node:fs";
import { applicationDirectories } from "../../codex-executable";
import { resolveCommands } from "../../command-resolution";
import { userHome } from "../../mcp-config-read";
import { pathIdentity } from "../../paths";

/** Devin Desktop runs the CLI it bundles here; the app does not put it on PATH. */
const DESKTOP_CLI = "Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin";

function executableFile(file: string): boolean {
  try {
    const info = statSync(file);
    return info.isFile() && (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** The CLIs Devin Desktop ships on this Mac; none elsewhere. */
export function devinDesktopExecutables(
  environment: NodeJS.ProcessEnv,
  directories = applicationDirectories(environment),
): string[] {
  if (process.platform !== "darwin") return [];
  return directories.map((directory) => path.join(directory, DESKTOP_CLI)).filter(executableFile);
}

/**
 * Every Devin CLI AgentKib may run, in the order it tries them: the one PATH finds, the official
 * installer's `~/.local/bin` (often missing from an app's PATH), then the copy Devin Desktop
 * ships. Each runs with the login it stores itself; AgentKib never reads it.
 */
export function devinExecutables(environment: NodeJS.ProcessEnv): string[] {
  const seen = new Set<string>();
  return [
    ...resolveCommands("devin", environment, [path.join(userHome(environment), ".local", "bin")]),
    ...devinDesktopExecutables(environment),
  ].filter((file) => {
    const identity = pathIdentity(file);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function devinExecutable(environment: NodeJS.ProcessEnv): string | null {
  return devinExecutables(environment)[0] ?? null;
}
