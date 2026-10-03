param()

$ErrorActionPreference = "Stop"
$results = [System.Collections.Generic.List[object]]::new()

function Add-Result {
  param(
    [Parameter(Mandatory = $true)][string] $Check,
    [Parameter(Mandatory = $true)][ValidateSet("PASS", "WARN", "FAIL")][string] $Status,
    [Parameter(Mandatory = $true)][string] $Detail
  )
  $results.Add([PSCustomObject]@{
      Check = $Check
      Status = $Status
      Detail = $Detail
    })
}

function Get-CommandOutput {
  param(
    [Parameter(Mandatory = $true)][string] $Command,
    [string[]] $Arguments = @()
  )
  $resolved = Get-Command $Command -ErrorAction SilentlyContinue
  if (-not $resolved) {
    return $null
  }
  $output = & $resolved.Source @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    return $null
  }
  return ($output | Out-String).Trim()
}

$os = Get-CimInstance Win32_OperatingSystem
$architecture = $os.OSArchitecture
$buildNumber = 0
$hasBuildNumber = [int]::TryParse([string] $os.BuildNumber, [ref] $buildNumber)
$isWindows11 = $hasBuildNumber -and $os.ProductType -eq 1 -and $buildNumber -ge 22000
$isX64 = $architecture -match "64"
$osDetail = "$($os.Caption) $($os.Version) build $($os.BuildNumber) ($architecture)"

if ($isWindows11 -and $isX64) {
  Add-Result "Windows 11 x64" "PASS" $osDetail
} else {
  Add-Result "Windows 11 x64" "FAIL" "Windows 11 x64 is required; current system: $osDetail"
}

$gitVersion = Get-CommandOutput "git" @("--version")
if ($gitVersion) {
  Add-Result "Git" "PASS" $gitVersion
} else {
  Add-Result "Git" "FAIL" "Git was not found. Install Git for Windows and reopen the terminal."
}

$nodeVersion = Get-CommandOutput "node" @("--version")
if ($nodeVersion -and $nodeVersion -match "^v22\.") {
  Add-Result "Node.js 22" "PASS" $nodeVersion
} elseif ($nodeVersion) {
  Add-Result "Node.js 22" "FAIL" "Found $nodeVersion; this project and CI require Node.js 22."
} else {
  Add-Result "Node.js 22" "FAIL" "Node.js was not found. Install OpenJS.NodeJS.22 and reopen the terminal."
}

$pnpmVersion = Get-CommandOutput "pnpm" @("--version")
if ($pnpmVersion -eq "10.8.1") {
  Add-Result "pnpm 10.8.1" "PASS" $pnpmVersion
} elseif ($pnpmVersion) {
  Add-Result "pnpm 10.8.1" "FAIL" "Found $pnpmVersion; run: corepack prepare pnpm@10.8.1 --activate"
} else {
  Add-Result "pnpm 10.8.1" "FAIL" "pnpm was not found. Install Node.js 22 and enable Corepack."
}

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$buildToolsPath = $null
if (Test-Path -LiteralPath $vswhere) {
  $buildToolsPath = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
}
if ($buildToolsPath) {
  Add-Result "MSVC Build Tools" "PASS" $buildToolsPath
} else {
  Add-Result "MSVC Build Tools" "FAIL" "Install Visual Studio Build Tools 2022 with Desktop development with C++."
}

$sdkRoot = "${env:ProgramFiles(x86)}\Windows Kits\10\Lib"
$sdkVersion = $null
if (Test-Path -LiteralPath $sdkRoot) {
  $sdkVersion = Get-ChildItem -LiteralPath $sdkRoot -Directory |
    Sort-Object Name -Descending |
    Select-Object -First 1 -ExpandProperty Name
}
if ($sdkVersion) {
  Add-Result "Windows SDK" "PASS" $sdkVersion
} else {
  Add-Result "Windows SDK" "FAIL" "Windows SDK was not found. Add it with the Build Tools installer."
}

if ($gitVersion) {
  & cmd.exe /D /C "git ls-remote https://github.com/starroyhq/agentkib.git refs/heads/main >nul 2>&1"
  $gitConnectionExitCode = $LASTEXITCODE
  if ($gitConnectionExitCode -eq 0) {
    Add-Result "GitHub Git connection" "PASS" "The upstream repository is reachable."
  } else {
    Add-Result "GitHub Git connection" "FAIL" "Git cannot reach GitHub. Check Clash and the GitHub-specific Git proxy."
  }
}

$results | Format-Table -AutoSize -Wrap
$failures = @($results | Where-Object Status -eq "FAIL")
$warnings = @($results | Where-Object Status -eq "WARN")
Write-Output ""
Write-Output "Summary: $($results.Count - $failures.Count - $warnings.Count) passed, $($warnings.Count) warnings, $($failures.Count) failed."
if ($failures.Count -gt 0) {
  exit 1
}
