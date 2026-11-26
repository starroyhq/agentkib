param(
  [Parameter(Mandatory = $true)] [string] $Package,
  [Parameter(Mandatory = $true)] [string] $UpgradePackage,
  [Parameter(Mandatory = $true)] [string] $CliBin
)

$ErrorActionPreference = "Stop"
if ($env:GITHUB_ACTIONS -cne "true" -or $env:RUNNER_ENVIRONMENT -cne "github-hosted") {
  throw "Use a disposable GitHub-hosted Windows runner for the installed MSIX smoke."
}
Import-Module Appx -UseWindowsPowerShell -WarningAction SilentlyContinue

$name = "AgentKib.StoreSmoke"
$publisher = "CN=AgentKib Store Smoke"
$applicationId = "AgentKib"
$data = Join-Path $env:LOCALAPPDATA "ai.agentkib"
$electronProfileRoot = Join-Path $env:APPDATA "ai.agentkib"
$npmBin = Join-Path $env:APPDATA "npm"
$registryFixture = "HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\pycharm64.exe"
$registryProbe = "HKCU:\Software\AgentKibStoreSmoke"
$fileProbe = Join-Path $env:USERPROFILE "AgentKibStoreSmoke.txt"
$shimFiles = @((Join-Path $npmBin "claude.cmd"), (Join-Path $npmBin "codex.cmd"))
if (Get-AppxPackage -Name $name) { throw "The test package is already installed." }
foreach ($existing in @($data, $electronProfileRoot, $registryFixture, $registryProbe, $fileProbe) + $shimFiles) {
  if (Test-Path -LiteralPath $existing) { throw "The runner already contains an MSIX smoke fixture path." }
}

function Get-TestManifestVersion([string] $File) {
  $archive = [IO.Compression.ZipFile]::OpenRead($File)
  try {
    $entry = $archive.GetEntry("AppxManifest.xml")
    if (-not $entry) { throw "Missing package manifest." }
    $reader = [IO.StreamReader]::new($entry.Open())
    try { [xml] $manifest = $reader.ReadToEnd() } finally { $reader.Dispose() }
    $identity = $manifest.Package.Identity
    $application = $manifest.Package.Applications.Application | Where-Object Id -CEQ $applicationId
    $runtime = $manifest.Package.Applications.Application | Where-Object Id -CEQ "AgentKibRuntime"
    $uap10 = "http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
    if (
      $identity.Name -cne $name -or $identity.Publisher -cne $publisher -or
      $identity.ProcessorArchitecture -cne "x64" -or -not $application -or -not $runtime -or
      $application.GetAttribute("RuntimeBehavior", $uap10) -cne "win32App" -or
      $application.GetAttribute("TrustLevel", $uap10) -cne "mediumIL" -or
      $runtime.GetAttribute("RuntimeBehavior", $uap10) -cne "win32App" -or
      $runtime.GetAttribute("TrustLevel", $uap10) -cne "mediumIL" -or
      $runtime.VisualElements.AppListEntry -cne "none"
    ) { throw "The package lacks the test-only identity or expected full-trust manifest." }
    $nativePrefix = "app/resources/app.asar.unpacked/dist-electron/native/koffi/build/koffi/"
    if (-not ($archive.Entries | Where-Object {
      $_.FullName.Replace('\', '/').StartsWith($nativePrefix, [StringComparison]::OrdinalIgnoreCase) -and $_.Name -eq "koffi.node"
    } | Select-Object -First 1)) {
      $archive.Entries | Where-Object { $_.FullName -match "koffi\.node$" } |
        ForEach-Object { Write-Host "Other native Koffi entry: $($_.FullName)" }
      throw "The MSIX has no physical Windows x64 Koffi library."
    }
    return [version] $identity.Version
  } finally {
    $archive.Dispose()
  }
}

function Wait-For([string] $Description, [scriptblock] $Condition, [int] $Seconds = 60) {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  do {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 250
  } while ($timer.Elapsed.TotalSeconds -lt $Seconds)
  throw "Timed out waiting for $Description."
}

# Start by the registered AUMID and verify that Windows gave the process the package identity.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class AgentKibStoreSmokeActivation
{
    [ComImport, Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IApplicationActivationManager
    {
        [PreserveSig]
        int ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            uint options,
            out uint processId);
    }

    [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    private class ApplicationActivationManager {}

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint code);

    public static uint CloseAndWait(Process process)
    {
        // Hold a native handle before exiting so Windows retains the exit result.
        IntPtr handle = OpenProcess(0x100000 | 0x1000, false, (uint)process.Id);
        if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            process.Refresh();
            if (!process.CloseMainWindow())
                throw new InvalidOperationException("The installed desktop did not accept the window close.");
            uint wait = WaitForSingleObject(handle, 30000);
            if (wait == 258) throw new TimeoutException("The installed desktop did not exit after closing its window.");
            if (wait != 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            uint code;
            if (!GetExitCodeProcess(handle, out code)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return code;
        } finally {
            CloseHandle(handle);
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder name);

    public static uint Open(string aumid)
    {
        var manager = (IApplicationActivationManager)new ApplicationActivationManager();
        try {
            uint pid;
            // AO_NOERRORUI avoids opening an interactive failure dialog.
            Marshal.ThrowExceptionForHR(manager.ActivateApplication(aumid, "", 2, out pid));
            return pid;
        } finally {
            Marshal.ReleaseComObject(manager);
        }
    }

    public static string PackageFullName(uint pid)
    {
        IntPtr process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) return null;
        try {
            uint length = 0;
            if (GetPackageFullName(process, ref length, null) != 122) return null;
            var name = new StringBuilder((int)length);
            int result = GetPackageFullName(process, ref length, name);
            if (result != 0) throw new Win32Exception(result);
            return name.ToString();
        } finally {
            CloseHandle(process);
        }
    }
}
'@

function Install-TestPackage([string] $SignedPackage, [version] $Version) {
  Add-AppxPackage -Path $SignedPackage
  $installed = Get-AppxPackage -Name $name
  if (@($installed).Count -ne 1 -or [version] $installed.Version -ne $Version) {
    throw "Windows did not register the requested test version."
  }
  return $installed
}

function Start-TestDesktop($Installed) {
  $appProcessId = [AgentKibStoreSmokeActivation]::Open($Installed.PackageFamilyName + "!" + $applicationId)
  if ([AgentKibStoreSmokeActivation]::PackageFullName($appProcessId) -cne $Installed.PackageFullName) {
    throw "The Electron process does not have the installed package identity."
  }
  $process = Get-Process -Id $appProcessId
  Wait-For "the AgentKib window and Electron renderer" {
    $process.Refresh()
    if ($process.HasExited) { throw "The installed desktop exited before becoming ready." }
    if ($process.MainWindowTitle -eq "AgentKib startup error") { throw "The desktop showed a startup error." }
    $process.MainWindowHandle -ne 0 -and
      $process.MainWindowTitle -eq "AgentKib" -and
      [bool] (Get-CimInstance Win32_Process -Filter "ParentProcessId = $appProcessId AND Name = 'AgentKib.exe'" |
        Where-Object { $_.CommandLine -match "(?:^|\s)--type=renderer(?:\s|$)" })
  }
  return $process
}

function Stop-TestDesktop([Diagnostics.Process] $Process, [int] $RuntimeProcessId) {
  $exitCode = [AgentKibStoreSmokeActivation]::CloseAndWait($Process)
  if ($exitCode -ne 0) { throw "The installed desktop quit with exit code $exitCode." }
  Wait-For "the shared runtime to stop" { -not (Get-Process -Id $RuntimeProcessId -ErrorAction SilentlyContinue) } 45
}

$Package = (Resolve-Path -LiteralPath $Package).Path
$UpgradePackage = (Resolve-Path -LiteralPath $UpgradePackage).Path
$CliBin = (Resolve-Path -LiteralPath $CliBin).Path
foreach ($entry in @("claude.cmd", "codex.cmd")) {
  if (-not (Test-Path -LiteralPath (Join-Path $CliBin $entry) -PathType Leaf)) {
    throw "The official CLI installation is missing $entry."
  }
}
$baseVersion = Get-TestManifestVersion $Package
$nextVersion = Get-TestManifestVersion $UpgradePackage
if ($nextVersion -le $baseVersion) { throw "The second MSIX must have a higher version." }

$kits = Join-Path ([Environment]::GetEnvironmentVariable("ProgramFiles(x86)")) "Windows Kits\10\bin"
$signtool = Get-ChildItem -LiteralPath $kits -Directory |
  Where-Object { $_.Name -match "^10\.\d+\.\d+\.\d+$" } |
  Sort-Object { [version] $_.Name } -Descending |
  ForEach-Object { Join-Path $_.FullName "x64\signtool.exe" } |
  Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
  Select-Object -First 1
if (-not $signtool) { throw "No Windows SDK x64 SignTool found." }

$scratch = Join-Path $env:RUNNER_TEMP ("agentkib-msix-smoke-" + [guid]::NewGuid().ToString("N"))
$workspace = Join-Path $scratch "workspace"
$probe = Join-Path $scratch "runtime.mjs"
$certificate = $null
try {
  New-Item -ItemType Directory -Path $workspace, $data, $npmBin -Force | Out-Null
  # Use the real AppData paths and shared named pipe. Set only normal preferences.
  @{
    close_behavior = "quit"
    quota_auto_refresh_enabled = $false
    local_auto_refresh_enabled = $false
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $data "preferences.json") -Encoding utf8

  $versions = @{}
  foreach ($key in @(
    "npm:@openai/codex", "github:openai/codex", "homebrew-cask:codex",
    "npm:@anthropic-ai/claude-code", "homebrew-cask:claude-code", "cursor:installer",
    "npm:opencode-ai", "github:anomalyco/opencode", "homebrew-formula:opencode",
    "npm:openclaw", "github:openclaw/openclaw", "github:NousResearch/hermes-agent",
    "npm:@xai-official/grok", "github:xai-org/grok-build", "homebrew-cask:devin-cli"
  )) {
    $versions[$key] = @{ version = "1.0.0"; checked_at = [DateTime]::UtcNow.ToString("o") }
  }
  $cache = Join-Path $data "tool-cache"
  New-Item -ItemType Directory -Path $cache | Out-Null
  @{ versions = $versions } | ConvertTo-Json -Depth 4 |
    Set-Content -LiteralPath (Join-Path $cache "agent-tools.json") -Encoding utf8

  # Use the normal npm discovery path and forward to the pinned, no-login CLI binaries.
  $claudeShim = @'
@echo off
if not "%~1"=="--version" exit /b 1
reg.exe add "HKCU\Software\AgentKibStoreSmoke" /v Claude /t REG_SZ /d visible /f >nul
if errorlevel 1 exit /b 1
>"%USERPROFILE%\AgentKibStoreSmoke.txt" echo visible
if errorlevel 1 exit /b 1
call "__CLI_BIN__\claude.cmd" --version
'@
  $codexShim = @'
@echo off
if not "%~1"=="--version" exit /b 1
call "__CLI_BIN__\codex.cmd" --version
'@
  $claudeShim.Replace("__CLI_BIN__", $CliBin) | Set-Content -LiteralPath $shimFiles[0] -Encoding ascii
  $codexShim.Replace("__CLI_BIN__", $CliBin) | Set-Content -LiteralPath $shimFiles[1] -Encoding ascii

  New-Item -Path $registryFixture -Force | Out-Null
  Set-Item -LiteralPath $registryFixture -Value (Join-Path $env:WINDIR "System32\whoami.exe")

  @'
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { connect } from "node:tls";

const [data, version, workspace, mode, protocolVersion] = process.argv.slice(2);
const root = path.join(realpathSync(data), "local-runtime");
const key = readFileSync(path.join(root, "runtime-v1.key"));
const namespace = createHash("sha256").update(root.toLowerCase()).digest("hex");
const deadline = setTimeout(() => {
  console.error("The external packaged-runtime probe timed out.");
  process.exit(1);
}, 30_000);
const socket = connect({
  path: "\\\\.\\pipe\\agentkib-runtime-v1-" + namespace,
  minVersion: "TLSv1.2",
  maxVersion: "TLSv1.2",
  ciphers: "ECDHE-PSK-CHACHA20-POLY1305:PSK-AES256-GCM-SHA384:PSK-AES128-GCM-SHA256",
  rejectUnauthorized: false,
  pskCallback: () => ({ psk: key, identity: "agentkib-local-runtime-v1" }),
});
socket.on("error", () => console.error("Could not connect to the expected named pipe."));
const lines = createInterface({ input: socket });
const replies = lines[Symbol.asyncIterator]();
let nextId = 0;
async function rpc(method, params = {}) {
  const id = ++nextId;
  socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  while (true) {
    const line = await replies.next();
    if (line.done) throw new Error("Installed runtime disconnected: " + method);
    const reply = JSON.parse(line.value);
    if (reply.id !== id) continue;
    if (reply.error) throw new Error("Installed runtime RPC failed: " + method + " (" + reply.error.code + ")");
    return reply.result;
  }
}
try {
  assert.equal((await rpc("localRuntime.identity")).version, version);
  const handshake = await rpc("agentkib.handshake", {
    protocolVersion: Number(protocolVersion),
    client: { name: "windows-store-smoke", version },
  });
  assert.equal(handshake.runtime.version, version);
  assert.ok(Number.isSafeInteger(handshake.pid) && handshake.pid > 0);
  const runtime = await rpc("runtime.info");
  assert.equal(runtime.data_dir.toLowerCase(), realpathSync(data).toLowerCase());
  assert.equal(runtime.close_behavior, "quit");
  assert.equal((await rpc("localRuntime.presence")).peers, 1);

  if (mode === "first") {
    const context = await rpc("backend.nativeContext");
    const plan = await rpc("backend.planWorkspace", { operation: "add", path: workspace, context });
    const [scan] = await rpc("backend.inspectWorkspaces", { workspaces: [{ id: plan.id, path: plan.path }] });
    assert.equal(scan.id, plan.id);
    const added = await rpc("workspace.add", { path: workspace, _plan: plan, _inspection: scan.inspection });
    const openers = await rpc("workspace.openers", { workspaceId: added.id });
    assert.ok(openers.some((item) => item.id === "pycharm"), "Packaged runtime could not read native App Paths.");
    const { tools } = await rpc("agents.toolsStatus");
    for (const [agent, expected] of [["claude-code", "2.1.331"], ["codex", "0.167.0"]]) {
      assert.ok(tools.some((tool) => tool.agent === agent && tool.installations.some(
        (installation) => installation.runnable && installation.version === expected,
      )), "Packaged runtime did not run the official " + agent + " version probe.");
    }
    await rpc("settings.setSidebarWidthPreference", { preference: 379 });
  }
  const projects = await rpc("workspaces.list");
  assert.ok(projects.some((item) => item.path.toLowerCase() === realpathSync(workspace).toLowerCase()));
  assert.equal((await rpc("runtime.info")).sidebar_width_preference, 379);
  console.log(handshake.pid);
} catch (error) {
  // RPC errors and assertion headings suffice without printing the endpoint, key or reply data.
  if (error.code && error.code !== "ERR_ASSERTION") console.error("Runtime probe failed: " + error.code);
  else console.error(error.message.split("\n")[0]);
  process.exitCode = 1;
} finally {
  lines.close();
  socket.destroy();
  clearTimeout(deadline);
}
'@ | Set-Content -LiteralPath $probe -Encoding utf8

  $contract = Get-Content -LiteralPath (Join-Path $PSScriptRoot "../../packages/runtime-protocol/src/generated/remote-contract.ts") -Raw
  if ($contract -notmatch "export const PROTOCOL_VERSION = (\d+) as const") { throw "Missing runtime protocol version." }
  $protocolVersion = $Matches[1]

  $certificateOptions = @{
    Type = "Custom"
    Subject = $publisher
    KeyUsage = "DigitalSignature"
    CertStoreLocation = "Cert:\CurrentUser\My"
    TextExtension = @("2.5.29.37={text}1.3.6.1.5.5.7.3.3")
    NotAfter = (Get-Date).AddDays(1)
  }
  $certificate = New-SelfSignedCertificate @certificateOptions
  $certificateFile = Join-Path $scratch "smoke.cer"
  Export-Certificate -Cert $certificate -FilePath $certificateFile | Out-Null
  Import-Certificate -FilePath $certificateFile -CertStoreLocation "Cert:\LocalMachine\TrustedPeople" | Out-Null
  $baseCopy = Join-Path $scratch "base.msix"
  $nextCopy = Join-Path $scratch "upgrade.msix"
  Copy-Item -LiteralPath $Package -Destination $baseCopy
  Copy-Item -LiteralPath $UpgradePackage -Destination $nextCopy
  foreach ($copy in @($baseCopy, $nextCopy)) {
    & $signtool sign /fd SHA256 /sha1 $certificate.Thumbprint $copy
    if ($LASTEXITCODE -ne 0) { throw "Could not sign the test-only MSIX copy." }
    & $signtool verify /pa $copy
    if ($LASTEXITCODE -ne 0) { throw "Could not verify the test-only MSIX signature." }
  }

  function Confirm-PersistentData {
    $preferences = Get-Content -LiteralPath (Join-Path $data "preferences.json") -Raw | ConvertFrom-Json
    if ($preferences.sidebar_width_preference -ne 379 -or
      -not (Test-Path -LiteralPath (Join-Path $data "agentkib.db") -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $electronProfileRoot "electron") -PathType Container)) {
      throw "The native user profile does not contain the AgentKib data."
    }
  }

  function Confirm-InstalledVersion($Installed, [version] $Version, [string] $Mode) {
    $process = Start-TestDesktop $Installed
    try {
      Wait-For "the native runtime key and lease files" {
        $process.Refresh()
        if ($process.HasExited -or $process.MainWindowTitle -eq "AgentKib startup error") {
          throw "The installed desktop failed before the shared runtime became ready."
        }
        (Test-Path -LiteralPath (Join-Path $data "local-runtime\runtime-v1.key") -PathType Leaf) -and
          (Test-Path -LiteralPath (Join-Path $data "local-runtime\runtime-v1.lock") -PathType Leaf)
      }
    } catch {
      $packageData = Join-Path $env:LOCALAPPDATA ("Packages\" + $Installed.PackageFamilyName)
      foreach ($location in @(
        @{ name = "native"; directory = $data },
        @{ name = "LocalCache"; directory = (Join-Path $packageData "LocalCache\Local\ai.agentkib") },
        @{ name = "LocalState"; directory = (Join-Path $packageData "LocalState\ai.agentkib") }
      )) {
        $db = Test-Path -LiteralPath (Join-Path $location.directory "agentkib.db") -PathType Leaf
        $launch = Test-Path -LiteralPath (Join-Path $location.directory "local-runtime\runtime-v1-launch.lock") -PathType Leaf
        $lock = Test-Path -LiteralPath (Join-Path $location.directory "local-runtime\runtime-v1.lock") -PathType Leaf
        $key = Test-Path -LiteralPath (Join-Path $location.directory "local-runtime\runtime-v1.key") -PathType Leaf
        Write-Host "Runtime files ($($location.name)): database=$db launch=$launch lease=$lock key=$key"
      }
      Write-Host "Roaming profile exists: $(Test-Path -LiteralPath (Join-Path $electronProfileRoot 'electron') -PathType Container)"
      $owned = @(Get-CimInstance Win32_Process -Filter "Name = 'AgentKib.exe'")
      Write-Host "AgentKib processes: $($owned.Count); shared runtime processes: $(@($owned | Where-Object CommandLine -Match '(?:^|\s)--agentkib-store-runtime(?:\s|$)').Count)"
      throw
    }
    $runtimeVersion = "$($Version.Major).$($Version.Minor).$($Version.Build)"
    $runtimeProcessId = & node $probe $data $runtimeVersion $workspace $Mode $protocolVersion
    if ($LASTEXITCODE -ne 0 -or "$runtimeProcessId" -notmatch "^\d+$") {
      throw "Could not verify the installed backend from outside the package."
    }
    if ([AgentKibStoreSmokeActivation]::PackageFullName([int] $runtimeProcessId) -cne $Installed.PackageFullName) {
      throw "The observed backend does not have the installed package identity."
    }
    Confirm-PersistentData
    Write-Host "Verified app window, native data and authenticated runtime for $Mode."
    Stop-TestDesktop $process ([int] $runtimeProcessId)
  }

  $base = Install-TestPackage $baseCopy $baseVersion
  Confirm-InstalledVersion $base $baseVersion "first"
  if ((Get-ItemProperty -LiteralPath $registryProbe -Name Claude).Claude -ne "visible") {
    throw "The packaged child write was not visible in the native registry."
  }
  if ((Get-Content -LiteralPath $fileProbe).Trim() -ne "visible") {
    throw "The packaged child write was not visible in the native user profile."
  }
  Write-Host "Verified renderer, default AppData, authenticated named pipe, native registry, user profile writes, and official Claude and Codex version probes."

  $next = Install-TestPackage $nextCopy $nextVersion
  if ($next.PackageFamilyName -cne $base.PackageFamilyName) { throw "Upgrade changed the package family." }
  Confirm-InstalledVersion $next $nextVersion "upgrade"
  Write-Host "Verified in-place upgrade retains the workspace and preferences."

  Remove-AppxPackage -Package $next.PackageFullName
  if (Get-AppxPackage -Name $name) { throw "The test package is still registered after uninstall." }
  Confirm-PersistentData
  $reinstalled = Install-TestPackage $nextCopy $nextVersion
  Confirm-InstalledVersion $reinstalled $nextVersion "reinstall"
  Write-Host "Verified uninstall and reinstall preserve native user data."
} finally {
  $installed = Get-AppxPackage -Name $name
  try {
    foreach ($candidate in Get-Process -Name AgentKib -ErrorAction SilentlyContinue) {
      if ($installed -and
        [AgentKibStoreSmokeActivation]::PackageFullName($candidate.Id) -ceq $installed.PackageFullName) {
        Stop-Process -InputObject $candidate -Force -ErrorAction SilentlyContinue
        [void] $candidate.WaitForExit(5000)
      }
    }
    if ($installed) { Remove-AppxPackage -Package $installed.PackageFullName }
  } finally {
    if ($certificate) {
      Remove-Item -LiteralPath "Cert:\LocalMachine\TrustedPeople\$($certificate.Thumbprint)" -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -ErrorAction SilentlyContinue
    }
    foreach ($owned in @($scratch, $data, $electronProfileRoot, $registryFixture, $registryProbe, $fileProbe) + $shimFiles) {
      if (Test-Path -LiteralPath $owned) { Remove-Item -LiteralPath $owned -Recurse -Force -ErrorAction SilentlyContinue }
    }
  }
}
