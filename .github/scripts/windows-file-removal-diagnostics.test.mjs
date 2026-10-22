import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnPowerShell, spawnPowerShellSync } from "./headless-powershell.mjs";

const helper = fileURLToPath(new URL("./windows-file-removal-diagnostics.ps1", import.meta.url));
const runtime = spawnPowerShellSync(
  ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"],
  {
    encoding: "utf8",
    timeout: 15_000,
  },
);
const runtimeAvailable = runtime.status === 0;
const skip = runtimeAvailable
  ? false
  : "PowerShell is unavailable; set AGENTKIB_PWSH to run portable tests";
if (process.platform === "win32") {
  assert.equal(runtimeAvailable, true, "Windows CI must execute the PowerShell diagnostic tests");
}

function runPowerShell(source, environment = {}) {
  const result = spawnPowerShellSync(["-NoProfile", "-NonInteractive", "-Command", source], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, AGENTKIB_DIAGNOSTIC_HELPER: helper, ...environment },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "", "Collection must not print arbitrary exception information");
  return JSON.parse(result.stdout.trim());
}

const mockedNative = `
$ErrorActionPreference = "Stop"
. $env:AGENTKIB_DIAGNOSTIC_HELPER
$script:calls = @()
$script:listCalls = 0
$script:overrides = @{}
function Test-AgentKibFileRemovalWindows { return $true }
function Invoke-AgentKibFileRemovalNative {
  param([string] $Operation, [hashtable] $Arguments)
  $script:calls += @{ operation = $Operation; arguments = $Arguments }
  if ($script:overrides.ContainsKey($Operation)) {
    return (& $script:overrides[$Operation] $Arguments)
  }
  switch ($Operation) {
    "attributes" { return @{ errorCode = 0; attributes = 32 } }
    "deleteAccess" { return @{ succeeded = $false; errorCode = 32; closeErrorCode = 0 } }
    "startSession" { return @{ errorCode = 0; handle = 123 } }
    "registerResource" { return @{ errorCode = 0 } }
    "getList" {
      $script:listCalls++
      if ($script:listCalls -eq 1) { return @{ errorCode = 234; needed = 1; owners = @() } }
      return @{ errorCode = 0; needed = 1; owners = @(
        @{ processId = 789; applicationName = "File locker"; commandLine = "not allowed"; environment = "not allowed" }
      ) }
    }
    "endSession" { return @{ errorCode = 0 } }
  }
}
`;

function runMocked(source) {
  return runPowerShell(`${mockedNative}\n${source}`);
}

const initializationPhases = [
  "entered",
  "parse",
  "load",
  "compile",
  "reinitialize",
  "marshal",
  "complete",
];

function summarizeInitializationProgress(source) {
  const lines = source.trim().split(/\r?\n/);
  if (lines.length > initializationPhases.length) return "phase progress unavailable";
  const progress = [];
  let previous = 0;
  for (const [index, line] of lines.entries()) {
    const match = /^(\w+)=(\d{1,9})$/.exec(line);
    if (!match || match[1] !== initializationPhases[index] || Number(match[2]) < previous) {
      return "phase progress unavailable";
    }
    previous = Number(match[2]);
    progress.push(`${match[1]}=${previous}ms`);
  }
  return progress.join(" -> ");
}

test("initialization progress emits only ordered phase names and numeric elapsed times", () => {
  assert.equal(
    summarizeInitializationProgress("entered=0\r\nparse=1\r\nload=4\r\ncompile=5\r\n"),
    "entered=0ms -> parse=1ms -> load=4ms -> compile=5ms",
  );
  for (const source of [
    "",
    "entered=0\nsecret exception text",
    "entered=0\nparse=1\nload=0",
    "entered=0\nparse=-1",
    "unknown=0",
    "entered=0\nparse=1\nload=2\ncompile=3\nreinitialize=4\nmarshal=5\ncomplete=6\nentered=7",
  ]) {
    assert.equal(summarizeInitializationProgress(source), "phase progress unavailable");
  }
});

test(
  "PowerShell parses and compiles the native declarations without loading or invoking Win32 APIs",
  { skip },
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "agentkib-diagnostic-initialization-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const progressFile = path.join(directory, "progress");
    let result;
    try {
      result = runPowerShell(
        `
$ErrorActionPreference = "Stop"
$clock = [Diagnostics.Stopwatch]::StartNew()
function Write-InitializationProgress([string] $phase) {
  [IO.File]::AppendAllText($env:AGENTKIB_DIAGNOSTIC_PROGRESS,
    $phase + '=' + $clock.ElapsedMilliseconds + [Environment]::NewLine)
}
Write-InitializationProgress 'entered'
$tokens = $null
$parseErrors = $null
Write-InitializationProgress 'parse'
$null = [Management.Automation.Language.Parser]::ParseFile($env:AGENTKIB_DIAGNOSTIC_HELPER, [ref] $tokens, [ref] $parseErrors)
if ($parseErrors.Count -ne 0) { throw "Diagnostic script did not parse" }
Write-InitializationProgress 'load'
. $env:AGENTKIB_DIAGNOSTIC_HELPER
$before = $null -ne ("AgentKib.FileRemovalDiagnosticNative" -as [type])
Write-InitializationProgress 'compile'
Initialize-AgentKibFileRemovalNative
Write-InitializationProgress 'reinitialize'
Initialize-AgentKibFileRemovalNative
Write-InitializationProgress 'marshal'
$uniqueProcessSize = [Runtime.InteropServices.Marshal]::SizeOf([type] [AgentKib.RemovalUniqueProcess])
$processInfoSize = [Runtime.InteropServices.Marshal]::SizeOf([type] [AgentKib.RemovalProcessInfo])
Write-InitializationProgress 'complete'
@{ before = $before; after = $null -ne ("AgentKib.FileRemovalDiagnosticNative" -as [type]);
  uniqueProcessSize = $uniqueProcessSize; processInfoSize = $processInfoSize } | ConvertTo-Json -Compress
`,
        { AGENTKIB_DIAGNOSTIC_PROGRESS: progressFile },
      );
    } finally {
      // Never print raw trace content: even a failed or replaced fixture may
      // contain arbitrary exception text. Only fixed stages and numbers escape.
      const progress = await readFile(progressFile, "utf8").catch(() => "");
      t.diagnostic(summarizeInitializationProgress(progress));
    }
    assert.equal(result.before, false);
    assert.equal(result.after, true);
    assert.equal(result.uniqueProcessSize, 12);
    assert.equal(result.processInfoSize, 668);
  },
);

test(
  "reports only the requested resource and the allowed Restart Manager owner fields",
  { skip },
  () => {
    const output = runMocked(`
$result = Get-AgentKibFileRemovalDiagnostic -Path 'C:\\test path\\AgentKib.exe'
@{ result = $result; calls = $script:calls } | ConvertTo-Json -Depth 8 -Compress
`);
    const result = output.result;
    assert.equal(result.path, "C:\\test path\\AgentKib.exe");
    assert.equal(result.exists, true);
    assert.equal(result.attributes, 32);
    assert.equal(result.attributesErrorCode, 0);
    assert.deepEqual(result.deleteAccessProbe, {
      attempted: true,
      succeeded: false,
      win32ErrorCode: 32,
      closeHandleErrorCode: 0,
      collectionFailed: false,
    });
    assert.equal(
      result.collectionFailed,
      false,
      "A sharing violation is evidence, not failed collection",
    );
    assert.deepEqual(result.restartManager.owners, [
      { processId: 789, applicationName: "File locker" },
    ]);
    assert.equal(result.restartManager.listAttempts, 2);
    assert.deepEqual(
      output.calls.filter((call) => call.operation === "registerResource"),
      [{ operation: "registerResource", arguments: { handle: 123, path: result.path } }],
    );
    assert.deepEqual(
      output.calls
        .filter((call) => call.operation === "getList")
        .map((call) => call.arguments.capacity),
      [0, 1],
    );
    assert.deepEqual(output.calls.at(-1), { operation: "endSession", arguments: { handle: 123 } });
    assert.doesNotMatch(JSON.stringify(output), /not allowed|commandLine|environment/);
  },
);

test("bounds a changing owner list and always closes its Restart Manager session", { skip }, () => {
  const output = runMocked(`
$script:overrides.getList = { param($arguments)
  return @{ errorCode = 234; needed = $arguments.capacity + 1; owners = @() }
}
$result = Get-AgentKibFileRemovalDiagnostic -Path 'C:\\AgentKib.exe'
@{ result = $result; calls = $script:calls } | ConvertTo-Json -Depth 8 -Compress
`);
  assert.equal(output.result.restartManager.listAttempts, 3);
  assert.equal(output.result.restartManager.listErrorCode, 234);
  assert.equal(output.result.restartManager.collectionFailed, true);
  assert.equal(output.result.collectionFailed, true);
  assert.deepEqual(output.result.restartManager.owners, []);
  assert.equal(output.calls.at(-1).operation, "endSession");
});

test(
  "refuses an oversized owner allocation without pretending the owner list is complete",
  { skip },
  () => {
    const output = runMocked(`
$script:overrides.getList = { return @{ errorCode = 234; needed = 257; owners = @() } }
Get-AgentKibFileRemovalDiagnostic -Path 'C:\\AgentKib.exe' | ConvertTo-Json -Depth 8 -Compress
`);
    assert.equal(output.restartManager.listAttempts, 1);
    assert.equal(output.restartManager.listErrorCode, 234);
    assert.equal(output.restartManager.collectionFailed, true);
    assert.equal(output.restartManager.endErrorCode, 0);
  },
);

test(
  "retains numeric API failures and releases started sessions without emitting exception details",
  { skip },
  () => {
    const outputs = runMocked(`
$outputs = @()
foreach ($operation in @('startSession', 'registerResource', 'getList', 'endSession')) {
  $script:calls = @()
  $script:listCalls = 0
  $script:overrides = @{}
  $script:overrides[$operation] = { return @{ errorCode = 5; needed = 0; owners = @() } }
  $result = Get-AgentKibFileRemovalDiagnostic -Path 'C:\\AgentKib.exe'
  $outputs += @{ operation = $operation; result = $result; calls = $script:calls }
}
$outputs | ConvertTo-Json -Depth 8 -Compress
`);
    for (const { operation, result, calls } of outputs) {
      const property = {
        startSession: "startErrorCode",
        registerResource: "registerErrorCode",
        getList: "listErrorCode",
        endSession: "endErrorCode",
      }[operation];
      assert.equal(result.restartManager[property], 5, operation);
      assert.equal(result.restartManager.collectionFailed, true, operation);
      assert.equal(result.collectionFailed, true, operation);
      assert.equal(
        calls.filter((call) => call.operation === "endSession").length,
        operation === "startSession" ? 0 : 1,
      );
    }
  },
);

test(
  "collection exceptions retain other evidence and scrub arbitrary exception text",
  { skip },
  () => {
    const outputs = runMocked(`
$outputs = @()
foreach ($operation in @('attributes', 'deleteAccess', 'startSession', 'registerResource', 'getList', 'endSession')) {
  $script:calls = @()
  $script:listCalls = 0
  $script:overrides = @{}
  $script:overrides[$operation] = { throw 'sensitive arbitrary exception text' }
  $result = Get-AgentKibFileRemovalDiagnostic -Path 'C:\\AgentKib.exe'
  $outputs += @{ operation = $operation; result = $result; calls = $script:calls }
}
$outputs | ConvertTo-Json -Depth 8 -Compress
`);
    for (const { operation, result, calls } of outputs) {
      assert.equal(result.collectionFailed, true, operation);
      if (operation !== "attributes") assert.equal(result.exists, true, operation);
      if (!["attributes", "deleteAccess", "startSession"].includes(operation)) {
        assert.equal(calls.at(-1).operation, "endSession", operation);
      }
    }
    assert.doesNotMatch(JSON.stringify(outputs), /sensitive|exception text/);
  },
);

test(
  "distinguishes missing paths from unreadable attributes and records close failures",
  { skip },
  () => {
    const outputs = runMocked(`
$outputs = @()
foreach ($code in @(2, 3, 5)) {
  $script:listCalls = 0
  $script:attributeCode = $code
  $script:overrides.attributes = { return @{ errorCode = $script:attributeCode; attributes = [uint32]::MaxValue } }
  $outputs += Get-AgentKibFileRemovalDiagnostic -Path 'C:\\AgentKib.exe'
}
$script:overrides.deleteAccess = { return @{ succeeded = $true; errorCode = 0; closeErrorCode = 6 } }
$outputs += Get-AgentKibFileRemovalDiagnostic -Path 'C:\\AgentKib.exe'
$outputs | ConvertTo-Json -Depth 8 -Compress
`);
    assert.deepEqual(
      outputs.slice(0, 3).map((result) => result.exists),
      [false, false, null],
    );
    assert.deepEqual(
      outputs.slice(0, 3).map((result) => result.attributesErrorCode),
      [2, 3, 5],
    );
    assert.equal(outputs[2].collectionFailed, true);
    assert.equal(outputs[3].deleteAccessProbe.closeHandleErrorCode, 6);
    assert.equal(outputs[3].deleteAccessProbe.collectionFailed, true);
  },
);

test(
  "unsupported platforms return an explicit incomplete result without loading native APIs",
  { skip },
  () => {
    const result = runPowerShell(`
$ErrorActionPreference = "Stop"
. $env:AGENTKIB_DIAGNOSTIC_HELPER
function Test-AgentKibFileRemovalWindows { return $false }
$result = Get-AgentKibFileRemovalDiagnostic -Path '/tmp/AgentKib.exe'
@{ result = $result; nativeInitialized = $null -ne ("AgentKib.FileRemovalDiagnosticNative" -as [type]) } | ConvertTo-Json -Depth 8 -Compress
`);
    assert.equal(result.result.unsupportedPlatform, true);
    assert.equal(result.result.collectionFailed, true);
    assert.equal(result.result.exists, null);
    assert.equal(result.result.deleteAccessProbe.attempted, false);
    assert.equal(result.result.restartManager.attempted, false);
    assert.equal(result.nativeInitialized, false);
  },
);

test(
  "Windows native probes preserve bytes/attributes, report missing paths and identify a real sharing lock",
  {
    skip: process.platform !== "win32" ? "Requires Windows CreateFileW and Restart Manager" : false,
  },
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "agentkib-file-removal-"));
    t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const executable = path.join(directory, "AgentKib test 文件.exe");
    const sentinel = path.join(directory, "user-data-sentinel");
    await writeFile(executable, "do not change the executable bytes");
    await writeFile(sentinel, "preserve user data");
    const call = (target) =>
      runPowerShell(
        `
$ErrorActionPreference = "Stop"
. $env:AGENTKIB_DIAGNOSTIC_HELPER
Get-AgentKibFileRemovalDiagnostic -Path $env:AGENTKIB_DIAGNOSTIC_PATH | ConvertTo-Json -Depth 8 -Compress
`,
        { AGENTKIB_DIAGNOSTIC_PATH: target },
      );
    const unlocked = call(executable);
    assert.equal(unlocked.exists, true);
    assert.equal(unlocked.deleteAccessProbe.succeeded, true);
    assert.equal(unlocked.deleteAccessProbe.win32ErrorCode, 0);
    assert.equal(unlocked.deleteAccessProbe.closeHandleErrorCode, 0);
    const readOnly = runPowerShell(
      `
$ErrorActionPreference = "Stop"
. $env:AGENTKIB_DIAGNOSTIC_HELPER
$original = [IO.File]::GetAttributes($env:AGENTKIB_DIAGNOSTIC_PATH)
try {
  $expected = $original -bor [IO.FileAttributes]::ReadOnly
  [IO.File]::SetAttributes($env:AGENTKIB_DIAGNOSTIC_PATH, $expected)
  $diagnostic = Get-AgentKibFileRemovalDiagnostic -Path $env:AGENTKIB_DIAGNOSTIC_PATH
  @{ diagnostic = $diagnostic; expected = [int] $expected;
    after = [int] [IO.File]::GetAttributes($env:AGENTKIB_DIAGNOSTIC_PATH) } | ConvertTo-Json -Depth 8 -Compress
} finally { [IO.File]::SetAttributes($env:AGENTKIB_DIAGNOSTIC_PATH, $original) }
`,
      { AGENTKIB_DIAGNOSTIC_PATH: executable },
    );
    assert.equal(readOnly.diagnostic.attributes, readOnly.expected);
    assert.equal(
      readOnly.after,
      readOnly.expected,
      "Diagnostics must not clear a read-only attribute",
    );
    assert.equal(readOnly.diagnostic.attributes & 1, 1);
    const missing = call(path.join(directory, "missing.exe"));
    assert.equal(missing.exists, false);
    assert.equal(missing.attributesErrorCode, 2);
    assert.equal(missing.deleteAccessProbe.win32ErrorCode, 2);

    const locker = spawnPowerShell(
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `
$ErrorActionPreference = "Stop"
$stream = [IO.File]::Open($env:AGENTKIB_DIAGNOSTIC_PATH, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  [Console]::Out.WriteLine("LOCK_READY")
  [Console]::Out.Flush()
  $null = [Console]::In.ReadLine()
} finally { $stream.Dispose() }
`,
      ],
      {
        env: { ...process.env, AGENTKIB_DIAGNOSTIC_PATH: executable },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const exited = once(locker, "exit");
    try {
      const ready = await Promise.race([
        once(locker.stdout, "data").then(([data]) => data.toString()),
        exited.then(() => {
          throw new Error("File-lock fixture exited before readiness");
        }),
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("File-lock fixture did not become ready")),
            15_000,
          );
          timer.unref();
        }),
      ]);
      assert.match(ready, /LOCK_READY/);
      const locked = call(executable);
      assert.equal(locked.exists, true);
      assert.equal(locked.attributes, unlocked.attributes);
      assert.equal(locked.deleteAccessProbe.succeeded, false);
      assert.equal(locked.deleteAccessProbe.win32ErrorCode, 32);
      assert.equal(locked.restartManager.startErrorCode, 0);
      assert.equal(locked.restartManager.registerErrorCode, 0);
      assert.equal(locked.restartManager.listErrorCode, 0);
      assert.equal(locked.restartManager.endErrorCode, 0);
      assert.ok(
        locked.restartManager.owners.some(
          (owner) => owner.processId === locker.pid && owner.applicationName,
        ),
      );
      assert.equal(await readFile(executable, "utf8"), "do not change the executable bytes");
      assert.equal(await readFile(sentinel, "utf8"), "preserve user data");
    } finally {
      locker.stdin.end("\n");
      const cleanup = setTimeout(() => locker.kill(), 5_000);
      cleanup.unref();
      await exited;
      clearTimeout(cleanup);
    }
    assert.equal(
      call(executable).deleteAccessProbe.succeeded,
      true,
      "The diagnostic must leave no open probe handle",
    );
  },
);
