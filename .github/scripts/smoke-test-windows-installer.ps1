param(
  [Parameter(Mandatory = $true)]
  [string] $SearchRoot,
  [switch] $SkipLaunch,
  [switch] $SkipQuota,
  [string] $DiagnosticsDirectory = "artifacts/windows-installer-diagnostics"
)

$ErrorActionPreference = "Stop"
$diagnostics = [ordered]@{
  startedAt = [DateTime]::UtcNow.ToString("o")
  outcome = "running"
  snapshots = @()
}

function Save-UninstallSnapshot {
  param([string] $Stage)
  $snapshot = [ordered]@{ stage = $Stage; at = [DateTime]::UtcNow.ToString("o") }
  try {
    if ($installationRoot -and (Test-Path -LiteralPath $installationRoot)) {
      $snapshot.files = @(Get-ChildItem -LiteralPath $installationRoot -File -Recurse |
        Select-Object -First 100 -Property FullName, Length, LastWriteTimeUtc)
      $snapshot.fileLimit = 100
    }
  } catch { $snapshot.fileCollectionFailed = $true }
  try {
    # Do not collect command lines or unrelated process information.
    $snapshot.processes = @(Get-CimInstance Win32_Process | Where-Object {
      ($installationRoot -and $_.ExecutablePath -and
        $_.ExecutablePath.StartsWith($installationRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) -or
      ($uninstall -and ($_.ProcessId -eq $uninstall.Id -or $_.ParentProcessId -eq $uninstall.Id))
    } | Select-Object -First 50 -Property ProcessId, ParentProcessId, Name, ExecutablePath)
  } catch { $snapshot.processCollectionFailed = $true }
  try {
    $snapshot.registry = @(@(
      "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
      "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
      "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
    ) | ForEach-Object { Get-ItemProperty -Path $_ -ErrorAction SilentlyContinue } |
      Where-Object { $_.DisplayName -eq "AgentKib" } |
      Select-Object -First 20 -Property DisplayName, DisplayVersion, InstallLocation)
  } catch { $snapshot.registryCollectionFailed = $true }
  $diagnostics.snapshots += $snapshot
}

try {
$installer = Get-ChildItem -LiteralPath $SearchRoot -Filter "AgentKib_*_windows-*.exe" -File |
  Select-Object -First 1
if (-not $installer) {
  throw "No NSIS installer was found under $SearchRoot"
}

$temporaryRoot = if ($env:RUNNER_TEMP) {
  $env:RUNNER_TEMP
} else {
  [System.IO.Path]::GetTempPath()
}
$installLocation = Join-Path $temporaryRoot "agentkib-installer-smoke-$PID"
if (Test-Path -LiteralPath $installLocation) {
  throw "Smoke-test installation path already exists: $installLocation"
}

function Install-AgentKib {
  $arguments = @("/S", "/D=$installLocation")
  $process = Start-Process -FilePath $installer.FullName -ArgumentList $arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "AgentKib installer failed with exit code $($process.ExitCode)"
  }
}

function Find-AgentKibExecutable {
  $programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
  $candidateRoots = @(
    $installLocation,
    (Join-Path $env:ProgramFiles "AgentKib")
  )
  if ($programFilesX86) {
    $candidateRoots += (Join-Path $programFilesX86 "AgentKib")
  }

  # A 32-bit NSIS installer running under the Windows ARM64 system profile can
  # redirect System32\config\systemprofile to SysWOW64\config\systemprofile.
  $localAppDataRoots = @($env:LOCALAPPDATA)
  $redirectedLocalAppData = $env:LOCALAPPDATA -replace '(?i)\\System32\\config\\systemprofile\\', '\SysWOW64\config\systemprofile\'
  if ($redirectedLocalAppData -and $redirectedLocalAppData -ne $env:LOCALAPPDATA) {
    $localAppDataRoots += $redirectedLocalAppData
  }
  foreach ($localAppDataRoot in ($localAppDataRoots | Select-Object -Unique)) {
    if ($localAppDataRoot) {
      $candidateRoots += Join-Path $localAppDataRoot "Programs\AgentKib"
      $candidateRoots += Join-Path $localAppDataRoot "AgentKib"
    }
  }

  $uninstallRoots = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )
  foreach ($uninstallRoot in $uninstallRoots) {
    $registryLocations = Get-ItemProperty -Path $uninstallRoot -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -eq "AgentKib" -and $_.InstallLocation } |
      Select-Object -ExpandProperty InstallLocation
    foreach ($registryLocation in $registryLocations) {
      $normalizedLocation = $registryLocation.Trim().Trim('"')
      $candidateRoots += $normalizedLocation
      $candidateRoots += $normalizedLocation -replace '(?i)\\System32\\config\\systemprofile\\', '\SysWOW64\config\systemprofile\'
    }
  }

  foreach ($root in ($candidateRoots | Select-Object -Unique)) {
    if ($root -and (Test-Path -LiteralPath $root)) {
      $found = Get-ChildItem -LiteralPath $root -Filter "AgentKib.exe" -File -Recurse |
        Select-Object -First 1
      if ($found) {
        return $found
      }
    }
  }
  return $null
}

function Stop-AgentKibProcesses {
  $stopDeadline = (Get-Date).AddSeconds(15)
  do {
    $runningProcesses = @(Get-Process -Name "AgentKib" -ErrorAction SilentlyContinue)
    if ($runningProcesses.Count -eq 0) {
      return
    }
    $runningProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $stopDeadline)

  $remainingProcessIds = @(Get-Process -Name "AgentKib" -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Id)
  throw "AgentKib processes remained after termination: $($remainingProcessIds -join ', ')"
}

Install-AgentKib
$executable = Find-AgentKibExecutable
if (-not $executable) {
  throw "Installed AgentKib executable was not found under $installLocation"
}
if (-not $SkipQuota) {
  $quotaSidecar = @(
    (Join-Path $installLocation "resources\bin\agentkib-quota-sidecar.exe"),
    (Join-Path $installLocation "resources\windows\agentkib-quota-sidecar.exe"),
    (Join-Path $installLocation "windows\agentkib-quota-sidecar.exe")
  ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $quotaSidecar) {
    throw "The bundled Windows quota collector was not found under $installLocation"
  }
}

if (-not $SkipLaunch) {
  $app = Start-Process -FilePath $executable.FullName -PassThru
  Start-Sleep -Seconds 8
  if ($app.HasExited) {
    throw "Installed AgentKib exited during startup with code $($app.ExitCode)"
  }
  Stop-AgentKibProcesses
}

$dataDirectory = Join-Path $env:LOCALAPPDATA "ai.agentkib"
$sentinel = Join-Path $dataDirectory "ci-upgrade-sentinel"
New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null
Set-Content -LiteralPath $sentinel -Value "preserve"

Install-AgentKib
if (-not (Test-Path -LiteralPath $sentinel)) {
  throw "User data was removed by an overwrite installation"
}
Stop-AgentKibProcesses

$installationRoot = Split-Path -Parent $executable.FullName
$diagnostics.installationRoot = $installationRoot
$diagnostics.executable = $executable.FullName
$uninstaller = Get-ChildItem -LiteralPath $installationRoot -Filter "Uninstall*.exe" -File |
  Select-Object -First 1
if (-not $uninstaller) {
  throw "AgentKib uninstaller was not found"
}
$diagnostics.uninstaller = $uninstaller.FullName
Save-UninstallSnapshot "before-uninstall"
$diagnostics.uninstallStartedAt = [DateTime]::UtcNow.ToString("o")
$uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -Wait -PassThru
$diagnostics.uninstallPid = $uninstall.Id
$diagnostics.uninstallExitCode = $uninstall.ExitCode
$diagnostics.uninstallReturnedAt = [DateTime]::UtcNow.ToString("o")
if ($uninstall.ExitCode -ne 0) {
  throw "AgentKib uninstaller failed with exit code $($uninstall.ExitCode)"
}
# NSIS performs the final removal from a detached cleanup process after the
# launcher exits. Keep the bounded wait; a timeout requires diagnostics rather
# than assuming antivirus scanning or increasing the timeout again.
$uninstallDeadline = (Get-Date).AddMinutes(2)
while ((Test-Path -LiteralPath $executable.FullName) -and (Get-Date) -lt $uninstallDeadline) {
  Start-Sleep -Milliseconds 500
}
if (Test-Path -LiteralPath $executable.FullName) {
  throw "AgentKib.exe remained after uninstall"
}
if (-not (Test-Path -LiteralPath $sentinel)) {
  throw "Uninstall unexpectedly removed user data"
}
Remove-Item -LiteralPath $sentinel -Force
Write-Output "AgentKib installer smoke test passed."
$diagnostics.outcome = "passed"
} catch {
  $diagnostics.outcome = "failed"
  # Preserve the original error in the job log, without copying arbitrary error
  # text (which may contain environment details) into the artifact.
  throw
} finally {
  try {
    Save-UninstallSnapshot "finished"
    $diagnostics.finishedAt = [DateTime]::UtcNow.ToString("o")
    New-Item -ItemType Directory -Force -Path $DiagnosticsDirectory | Out-Null
    $diagnostics | ConvertTo-Json -Depth 6 |
      Set-Content -LiteralPath (Join-Path $DiagnosticsDirectory "summary.json") -Encoding utf8
  } catch {
    Write-Warning "Could not write installer diagnostics; the original smoke-test result is unchanged."
  }
}
