import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnPowerShell, spawnPowerShellSync } from "./headless-powershell.mjs";

function setPowerShell(t, executable) {
  const previous = process.env.AGENTKIB_PWSH;
  if (executable === undefined) delete process.env.AGENTKIB_PWSH;
  else process.env.AGENTKIB_PWSH = executable;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENTKIB_PWSH;
    else process.env.AGENTKIB_PWSH = previous;
  });
}

function mockLaunch(t, method, implementation) {
  const mocked = t.mock.method(childProcess, method, implementation);
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  return mocked;
}

for (const [method, launch] of [
  ["spawn", spawnPowerShell],
  ["spawnSync", spawnPowerShellSync],
]) {
  test(`${method} hides PowerShell while preserving arguments, options and its return value`, (t) => {
    setPowerShell(t, "custom PowerShell executable");
    const args = Object.freeze(["-NoProfile", "-Command", "exit 0"]);
    const environment = Object.freeze({ FIXTURE_VARIABLE: "preserve" });
    const stdio = Object.freeze(["pipe", "pipe", "pipe"]);
    const options = Object.freeze({
      cwd: "fixture working directory",
      env: environment,
      stdio,
      timeout: 30_000,
      windowsHide: false,
    });
    const result = { fixture: method };
    const mocked = mockLaunch(t, method, (executable, actualArgs, actualOptions) => {
      assert.equal(executable, "custom PowerShell executable");
      assert.equal(actualArgs, args);
      assert.notEqual(actualOptions, options);
      assert.deepEqual(actualOptions, { ...options, windowsHide: true });
      assert.equal(actualOptions.env, environment);
      assert.equal(actualOptions.stdio, stdio);
      return result;
    });
    assert.equal(launch(args, options), result);
    assert.equal(mocked.mock.callCount(), 1);
    assert.equal(options.windowsHide, false);
  });

  test(`${method} defaults to pwsh and still hides the host without caller options`, (t) => {
    setPowerShell(t, undefined);
    const args = [];
    const mocked = mockLaunch(t, method, (executable, actualArgs, options) => {
      assert.equal(executable, "pwsh");
      assert.equal(actualArgs, args);
      assert.deepEqual(options, { windowsHide: true });
    });
    launch(args);
    assert.equal(mocked.mock.callCount(), 1);
  });
}

test("synchronous PowerShell launch preserves a real executable-not-found failure", (t) => {
  setPowerShell(t, path.join(tmpdir(), `agentkib-missing-powershell-${randomUUID()}`));
  const result = spawnPowerShellSync([], { timeout: 30_000 });
  assert.equal(result.status, null);
  assert.equal(result.error?.code, "ENOENT");
});

test(
  "asynchronous PowerShell launch preserves a real executable-not-found error",
  { timeout: 30_000 },
  async (t) => {
    setPowerShell(t, path.join(tmpdir(), `agentkib-missing-powershell-${randomUUID()}`));
    const child = spawnPowerShell([]);
    const [error] = await once(child, "error");
    assert.equal(error.code, "ENOENT");
    assert.notEqual(child.exitCode, 0);
  },
);

test(
  "Windows PowerShell receives STARTF_USESHOWWINDOW and SW_HIDE before host startup",
  { skip: process.platform !== "win32" ? "Requires Windows GetStartupInfoW" : false },
  () => {
    const source = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class HeadlessPowerShellStartup {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Info {
    public uint cb;
    public IntPtr lpReserved;
    public IntPtr lpDesktop;
    public IntPtr lpTitle;
    public uint dwX;
    public uint dwY;
    public uint dwXSize;
    public uint dwYSize;
    public uint dwXCountChars;
    public uint dwYCountChars;
    public uint dwFillAttribute;
    public uint dwFlags;
    public ushort wShowWindow;
    public ushort cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  public static extern void GetStartupInfoW(out Info info);
}
'@ -ErrorAction Stop | Out-Null
$info = New-Object HeadlessPowerShellStartup+Info
[HeadlessPowerShellStartup]::GetStartupInfoW([ref] $info)
[Console]::Out.WriteLine("$($info.dwFlags) $($info.wShowWindow)")
`;
    const result = spawnPowerShellSync(
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", source],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout.trim(), /^\d+ \d+$/);
    const [flags, showWindow] = result.stdout.trim().split(" ").map(Number);
    assert.equal(flags & 1, 1, "STARTF_USESHOWWINDOW must reach the PowerShell process");
    assert.equal(showWindow, 0, "SW_HIDE must bypass PowerShell's taskbar JumpList COM path");
  },
);
