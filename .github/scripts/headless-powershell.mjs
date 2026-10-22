import { spawn, spawnSync } from "node:child_process";

// SW_HIDE skips PowerShell's taskbar JumpList COM path and its startup heap
// corruption: https://github.com/PowerShell/PowerShell/pull/28186
export function spawnPowerShell(args, options = {}) {
  return spawn(process.env.AGENTKIB_PWSH || "pwsh", args, { ...options, windowsHide: true });
}

export function spawnPowerShellSync(args, options = {}) {
  return spawnSync(process.env.AGENTKIB_PWSH || "pwsh", args, { ...options, windowsHide: true });
}
