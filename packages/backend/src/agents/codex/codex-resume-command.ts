/** Copyable host commands use literal shell arguments, never interpolated session metadata. */
export function codexResumeCommand(
  cwd: string,
  home: string,
  nativeId: string,
  platform: NodeJS.Platform = process.platform,
) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeId))
    throw new Error("unverified-session-identity");
  if ([cwd, home].some((value) => !value || value.includes("\0")))
    throw new Error("codex-context-unavailable");
  const shell = platform === "win32" ? "powershell" : "posix";
  const quote = (value: string) =>
    shell === "powershell"
      ? `'${value.replaceAll("'", "''")}'`
      : `'${value.replaceAll("'", "'\\''")}'`;
  const command =
    shell === "powershell"
      ? `try { Set-Location -LiteralPath ${quote(cwd)} -ErrorAction Stop; $env:CODEX_HOME = ${quote(home)}; & codex resume ${quote(nativeId)} } catch { Write-Error $_ }`
      : `cd -- ${quote(cwd)} && CODEX_HOME=${quote(home)} codex resume ${quote(nativeId)}`;
  return { available: true as const, command, shell, runOn: "host" as const };
}
