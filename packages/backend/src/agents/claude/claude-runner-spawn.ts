import { spawn, type SpawnOptions } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { restrictRemotePath } from "../../remote-tls";

export function spawnClaudeRunner(
  executable: string,
  args: (mcpConfigFile?: string) => string[],
  options: SpawnOptions,
  mcpConfig?: Record<string, unknown>,
) {
  if (!mcpConfig) return spawn(executable, args(), options);

  // The config contains loopback capabilities. Process arguments can be visible to other users.
  const directory = mkdtempSync(path.resolve(tmpdir(), "agentkib-claude-mcp-"));
  const file = path.join(directory, "mcp.json");
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    try {
      rmSync(directory, { recursive: true, force: true });
      cleaned = true;
    } catch {
      // A cleanup failure leaves only a private, per-process directory.
    }
  };
  try {
    restrictRemotePath(directory, true);
    writeFileSync(file, JSON.stringify(mcpConfig), { flag: "wx", mode: 0o600 });
    if (process.platform === "win32") restrictRemotePath(file);
    // `close` also covers a spawn that fails before emitting `exit`.
    return spawn(executable, args(file), options).once("exit", cleanup).once("close", cleanup);
  } catch (error) {
    cleanup();
    throw error;
  }
}
