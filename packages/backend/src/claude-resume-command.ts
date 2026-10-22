/** A copyable command is data: every host path and native ID is a literal shell argument. */
export function claudeResumeCommand(
  cwd: string,
  config: string | undefined,
  nativeId: string,
  platform: NodeJS.Platform = process.platform,
) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeId))
    throw new Error("unverified-session-identity");
  if (!cwd || cwd.includes("\0") || (config !== undefined && (!config || config.includes("\0"))))
    throw new Error("claude-context-unavailable");
  const shell = platform === "win32" ? "powershell" : "posix";
  const quote = (value: string) =>
    shell === "powershell"
      ? `'${value.replaceAll("'", "''")}'`
      : `'${value.replaceAll("'", "'\\''")}'`;
  // Even the default directory changes Claude's global-config lookup when explicitly set.
  const configAssignment =
    config === undefined
      ? ""
      : shell === "powershell"
        ? `$env:CLAUDE_CONFIG_DIR = ${quote(config)}; `
        : `CLAUDE_CONFIG_DIR=${quote(config)} `;
  const command =
    shell === "powershell"
      ? `try { Set-Location -LiteralPath ${quote(cwd)} -ErrorAction Stop; ${configAssignment}& claude --resume ${quote(nativeId)} } catch { Write-Error $_ }`
      : `cd -- ${quote(cwd)} && ${configAssignment}claude --resume ${quote(nativeId)}`;
  return { available: true as const, command, shell, runOn: "host" as const };
}
