import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { spawnPowerShell } from "./headless-powershell.mjs";

const runFile = promisify(execFile);
// Use the same PowerShell edition as the control harness and Actions shell.
// Windows PowerShell 5.1 cannot load inherited PowerShell 7 security modules.
const powershell = process.env.AGENTKIB_PWSH || "pwsh";
const repository = process.env.AGENTKIB_SOURCE_ROOT
  ? path.resolve(process.env.AGENTKIB_SOURCE_ROOT)
  : fileURLToPath(new URL("../../", import.meta.url));
const desktop = path.join(repository, "apps/desktop");
const includePath = path.join(desktop, "scripts/windows-installer.nsh");
const desktopRequire = createRequire(path.join(desktop, "package.json"));
const builderRequire = createRequire(desktopRequire.resolve("electron-builder"));
const { LangConfigurator, createAddLangsMacro } = builderRequire(
  "app-builder-lib/out/targets/nsis/nsisLang.js",
);
const { NsisScriptGenerator } = builderRequire(
  "app-builder-lib/out/targets/nsis/nsisScriptGenerator.js",
);
const { bundledLanguages, lcid } = builderRequire("app-builder-lib/out/util/langs.js");
const languageScript = new NsisScriptGenerator();
createAddLangsMacro(languageScript, new LangConfigurator({}));
const languages = [...languageScript.build().matchAll(/!insertmacro MUI_LANGUAGE "([^"]+)"/g)].map(
  (match) => match[1],
);
const templates = path.join(
  path.dirname(builderRequire.resolve("app-builder-lib/package.json")),
  "templates/nsis",
);
function normalizeLineEndings(source) {
  return source.replaceAll("\r\n", "\n");
}

const policy = normalizeLineEndings(await readFile(includePath, "utf8"));
const upstream = normalizeLineEndings(
  await readFile(path.join(templates, "uninstaller.nsh"), "utf8"),
);

function upgradeBlock(source) {
  const normalized = normalizeLineEndings(source);
  const lines = normalized.slice(normalized.indexOf("${if} ${isUpdated}")).split("\n");
  let depth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*\$\{if\}/i.test(lines[index])) depth += 1;
    if (/^\s*\$\{endif\}/i.test(lines[index])) depth -= 1;
    if (depth === 0) {
      return lines
        .slice(0, index + 1)
        .map((line) => line.replace(/#.*$/, "").trim())
        .filter(Boolean)
        .join("\n");
    }
  }
  throw new Error("No complete atomic upgrade block was found");
}

function assertTrackedInclude(configuration) {
  // Git's Windows checkout uses CRLF. The packaging contract is independent of
  // checkout line endings, but the include must still be in the NSIS section.
  assert.match(
    normalizeLineEndings(configuration),
    /^nsis:\n(?: {2}[^\n]*\n)* {2}include: scripts\/windows-installer\.nsh(?:\n|$)/m,
  );
}

test("tracked include policy accepts LF and CRLF without accepting other paths", () => {
  for (const ending of ["\n", "\r\n"]) {
    const configuration = [
      "nsis:",
      "  oneClick: false",
      "  include: scripts/windows-installer.nsh",
      "",
    ].join(ending);
    assertTrackedInclude(configuration);
    assert.throws(() =>
      assertTrackedInclude(configuration.replace("windows-installer.nsh", "different.nsh")),
    );
    assert.throws(() =>
      assertTrackedInclude(
        configuration.replace("windows-installer.nsh", "windows-installer.nsh.bak"),
      ),
    );
    assert.throws(() => assertTrackedInclude(configuration.replace("nsis:", "extraResources:")));
  }
});

test("atomic upgrade comparison accepts mixed checkout line endings and rejects changed rollback", () => {
  const expected = upgradeBlock(upstream);
  for (const policyEnding of ["\n", "\r\n"]) {
    for (const upstreamEnding of ["\n", "\r\n"]) {
      assert.equal(
        upgradeBlock(policy.replaceAll("\n", policyEnding)),
        upgradeBlock(upstream.replaceAll("\n", upstreamEnding)),
      );
    }
  }
  assert.notEqual(
    upgradeBlock(policy.replace("Call un.restoreFiles", "Call un.atomicRMDir")),
    expected,
  );
});

test("packaging uses the tracked include and retains the upstream atomic upgrade rollback", async () => {
  const configuration = await readFile(path.join(desktop, "electron-builder.yml"), "utf8");
  assertTrackedInclude(configuration);
  assert.equal(upgradeBlock(policy), upgradeBlock(upstream));
  assert.match(
    policy.slice(policy.lastIndexOf("${if} ${isUpdated}")),
    /\$\{if\} \$\{isUpdated\}\s+SetOutPath \$TEMP\s+RMDir \/r \$INSTDIR\s+\$\{else\}\s+Call un\.agentkibRemoveInstallation\s+\$\{endif\}/,
  );
  assert.doesNotMatch(policy, /\/REBOOTOK|taskkill|Stop-Process|\$APPDATA|\$LOCALAPPDATA/i);
});

test("a sparse release helper resolves the selected source through AGENTKIB_SOURCE_ROOT", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "agentkib-sparse-nsis-helper-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const helpers = path.join(directory, ".github/scripts");
  await mkdir(helpers, { recursive: true });
  const copied = path.join(helpers, "windows-installer-policy.test.mjs");
  await copyFile(fileURLToPath(import.meta.url), copied);
  await copyFile(
    fileURLToPath(new URL("./headless-powershell.mjs", import.meta.url)),
    path.join(helpers, "headless-powershell.mjs"),
  );
  const environment = { ...process.env, AGENTKIB_SOURCE_ROOT: repository };
  // This is a new runner, not a child participating in the parent's test IPC.
  delete environment.NODE_TEST_CONTEXT;
  const { stdout } = await runFile(
    process.execPath,
    ["--test", "--test-reporter=tap", "--test-name-pattern=packaging uses", copied],
    { cwd: directory, env: environment },
  );
  assert.match(stdout, /packaging uses the tracked include/);
});

test("the uninstall failure has all four application languages", () => {
  for (const locale of [1033, 2052, 1028, 1041]) {
    assert.match(
      policy,
      new RegExp(`LangString agentkibUninstallFilesRemain ${locale} "[^"\\n]+"`),
    );
  }
  const provided = new Set(
    [
      ...policy.matchAll(
        /(?:LangString agentkibUninstallFilesRemain|!insertmacro agentkibUninstallFallback) (\d+)/g,
      ),
    ].map((match) => Number(match[1])),
  );
  assert.deepEqual(provided, new Set(bundledLanguages.map((language) => lcid[language])));
  assert.equal(languages.length, bundledLanguages.length);
});

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function findCompiler() {
  if (process.env.AGENTKIB_NSIS_COMPILER) {
    assert.equal(await exists(process.env.AGENTKIB_NSIS_COMPILER), true);
    return { path: process.env.AGENTKIB_NSIS_COMPILER, env: process.env };
  }
  const caches = [
    process.env.ELECTRON_BUILDER_CACHE,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "electron-builder/Cache"),
  ].filter(Boolean);
  for (const cache of caches) {
    const nsisCache = path.join(cache, "nsis");
    if (!(await exists(nsisCache))) continue;
    for (const entry of await readdir(nsisCache)) {
      const compiler = path.join(nsisCache, entry, "Bin/makensis.exe");
      if (await exists(compiler)) {
        return { path: compiler, env: { ...process.env, NSISDIR: path.join(nsisCache, entry) } };
      }
    }
  }
  return undefined;
}

const compiler = await findCompiler();
const canExecuteNsis = process.platform === "win32" && compiler;

test(
  "required NSIS validation has a Windows compiler and runtime",
  { skip: process.env.AGENTKIB_REQUIRE_NSIS_TESTS !== "1" },
  () => {
    assert.ok(
      canExecuteNsis,
      "Run on Windows after packaging, or set AGENTKIB_NSIS_COMPILER and its NSISDIR",
    );
  },
);

function nsisString(value) {
  return value.replaceAll("$", () => "$$").replaceAll('"', '$\\"');
}

function nsisCompilerString(value) {
  // OutFile and !include take compiler paths, not runtime NSIS strings.
  return value.replaceAll('"', '$\\"');
}

test("NSIS fixture paths preserve literal dollar signs and quotes", () => {
  assert.equal(
    nsisString(String.raw`D:\fixture $TEMP\quoted"name`),
    String.raw`D:\fixture $$TEMP\quoted$\"name`,
  );
  assert.equal(
    nsisCompilerString(String.raw`D:\fixture $TEMP\output.exe`),
    String.raw`D:\fixture $TEMP\output.exe`,
  );
});

async function compileFixture(t, { updated = false, inPlace = false, baseline = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "agentkib uninstall $ policy "));
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup) await close();
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const installation = path.join(directory, "installed application");
  const creator = path.join(directory, "create-uninstaller.exe");
  const registeredUninstaller = path.join(installation, "Uninstall AgentKib.exe");
  const uninstaller = path.join(
    inPlace ? installation : directory,
    inPlace ? "Uninstall AgentKib.exe" : "uninstall.exe",
  );
  const completed = path.join(directory, "uninstall-completed");
  const registration = path.join(directory, "uninstall-registration");
  const sentinel = path.join(directory, "user-data-sentinel");
  await mkdir(installation);
  const executable = path.join(installation, "AgentKib.exe");
  await writeFile(path.join(installation, "before.txt"), "original installation file");
  await writeFile(executable, "synthetic executable held by a Windows file handle");
  await writeFile(sentinel, "preserve user data");
  const atomicFunctions = upstream.match(
    /Function un\.atomicRMDir[\s\S]*?Function un\.restoreFiles[\s\S]*?FunctionEnd/,
  )?.[0];
  assert.ok(atomicFunctions);
  const source = path.join(directory, "fixture.nsi");
  const defaultRemovalStart = upstream.indexOf(
    "${if} ${isUpdated}",
    upstream.indexOf("# delete the installed files"),
  );
  const defaultRemoval = upstream.slice(
    defaultRemovalStart,
    upstream.indexOf("  !endif", defaultRemovalStart),
  );
  assert.match(defaultRemoval, /SetOutPath \$TEMP\s+#.*\n\s*RMDir \/r \$INSTDIR/);
  const loadLanguages = languages
    .map((language) => `LoadLanguageFile "\${NSISDIR}\\Contrib\\Language files\\${language}.nlf"`)
    .join("\n");
  await writeFile(
    source,
    String.raw`Unicode true
!include "LogicLib.nsh"
!define BUILD_UNINSTALLER
!define PRODUCT_FILENAME "AgentKib"
!define isUpdated '${updated ? "1 == 1" : "0 == 1"}'
${baseline ? "" : `!include "${nsisCompilerString(includePath)}"`}
!define UNINSTALL_FILENAME "Uninstall AgentKib.exe"
Name "AgentKib uninstall policy fixture"
OutFile "${nsisCompilerString(creator)}"
InstallDir "${nsisString(installation)}"
RequestExecutionLevel user
SilentInstall silent
${loadLanguages}
Section
  WriteUninstaller "${nsisString(uninstaller)}"
  ${inPlace ? "" : `WriteUninstaller "${nsisString(registeredUninstaller)}"`}
SectionEnd
${atomicFunctions}
Section "Uninstall"
  InitPluginsDir
  ${baseline ? defaultRemoval : "!insertmacro customRemoveFiles"}
  StrCpy $0 "${nsisString(registration)}"
  Delete "$0"
  FileOpen $0 "${nsisString(completed)}" w
  FileWrite $0 "completed"
  FileClose $0
SectionEnd
`,
  );
  await runFile(
    compiler.path,
    [
      process.platform === "win32" ? "/WX" : "-WX",
      process.platform === "win32" ? "/V2" : "-V2",
      source,
    ],
    {
      cwd: directory,
      env: compiler.env,
    },
  );
  assert.equal(await exists(creator), true);
  return {
    directory,
    installation,
    executable,
    registeredUninstaller,
    registration,
    completed,
    sentinel,
    cleanup,
    async initialize() {
      await runFile(creator, ["/S"], { cwd: directory });
      assert.equal(await exists(uninstaller), true);
      assert.equal(await exists(registeredUninstaller), true);
      // Model the code after customRemoveFiles without touching a real registry.
      await writeFile(registration, registeredUninstaller);
    },
    async uninstall() {
      // NSIS's _?= must be last, with its path extending unquoted to the end.
      // Quote argv[0] explicitly while preserving that last argument verbatim.
      return new Promise((resolve, reject) => {
        const child = spawn(uninstaller, ["/S", `_?=${installation}`], {
          cwd: directory,
          argv0: `"${uninstaller}"`,
          windowsVerbatimArguments: true,
          windowsHide: true,
          stdio: "ignore",
        });
        child.once("error", reject);
        child.once("close", (code, signal) => {
          if (signal || code === null) reject(new Error(`NSIS fixture terminated with ${signal}`));
          else resolve(code);
        });
      });
    },
    async uninstallFromRegisteredEntry() {
      // Exercise the restored entry's normal self-copying launcher, as Windows
      // Installed Apps would. The completion marker observes its real child.
      await runFile(registeredUninstaller, ["/S"], { cwd: directory });
      const deadline = Date.now() + 10_000;
      while (!(await exists(completed))) {
        assert.ok(Date.now() < deadline, "The restored uninstall entry did not complete");
        await delay(25);
      }
    },
  };
}

test(
  "the product include compiles with the upstream upgrade functions",
  { skip: !compiler },
  async (t) => {
    await compileFixture(t);
    await compileFixture(t, { updated: true });
    await compileFixture(t, { updated: true, inPlace: true, baseline: true });
  },
);

async function lockFile(app, durationMs) {
  const ready = path.join(app.directory, "lock-ready");
  const release = path.join(app.directory, "release-lock");
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const command = `
$ErrorActionPreference = 'Stop'
$stream = [IO.File]::Open(${quote(app.executable)}, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
try {
  [IO.File]::WriteAllText(${quote(ready)}, 'ready')
  $deadline = [DateTime]::UtcNow.AddMilliseconds(${durationMs})
  while (-not (Test-Path -LiteralPath ${quote(release)}) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 25
  }
} finally { $stream.Dispose() }
`;
  const child = spawnPowerShell(
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(command, "utf16le").toString("base64"),
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  app.cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  });
  const deadline = Date.now() + 5_000;
  while (!(await exists(ready))) {
    assert.equal(
      child.exitCode,
      null,
      "Windows file-lock fixture exited before acquiring its handle",
    );
    assert.ok(Date.now() < deadline, "Windows file-lock fixture did not become ready");
    await delay(25);
  }
  return async () => {
    await writeFile(release, "release");
    await closed;
  };
}

async function denyDirectoryListing(app) {
  const savedAcl = path.join(app.directory, "installation-acl.sddl");
  const runAclScript = (source) =>
    runFile(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(source, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        env: {
          ...process.env,
          AGENTKIB_NSIS_ACL_ROOT: app.installation,
          AGENTKIB_NSIS_ACL_FILE: app.registeredUninstaller,
          AGENTKIB_NSIS_ACL_BACKUP: savedAcl,
        },
      },
    );
  let restored = false;
  const restore = async () => {
    if (restored) return;
    if ((await exists(savedAcl)) && (await exists(app.installation))) {
      await runAclScript(`
$ErrorActionPreference = 'Stop'
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetSecurityDescriptorSddlForm([IO.File]::ReadAllText($env:AGENTKIB_NSIS_ACL_BACKUP))
Set-Acl -LiteralPath $env:AGENTKIB_NSIS_ACL_ROOT -AclObject $acl
`);
    }
    restored = true;
  };
  // Register restoration before applying a rule, including when setup fails.
  app.cleanup.push(restore);
  const { stdout } = await runAclScript(`
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:AGENTKIB_NSIS_ACL_ROOT
[IO.File]::WriteAllText($env:AGENTKIB_NSIS_ACL_BACKUP, $acl.Sddl)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$rule = New-Object Security.AccessControl.FileSystemAccessRule(
  $identity, [Security.AccessControl.FileSystemRights]::ListDirectory,
  [Security.AccessControl.InheritanceFlags]::None,
  [Security.AccessControl.PropagationFlags]::None,
  [Security.AccessControl.AccessControlType]::Deny)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:AGENTKIB_NSIS_ACL_ROOT -AclObject $acl
$denied = $false
try { $null = [IO.Directory]::GetFileSystemEntries($env:AGENTKIB_NSIS_ACL_ROOT) }
catch [UnauthorizedAccessException] { $denied = $true }
if (-not $denied) { throw 'The private installation directory can still be listed' }
if ([IO.File]::ReadAllBytes($env:AGENTKIB_NSIS_ACL_FILE).Length -eq 0) {
  throw 'The non-inherited listing rule prevented direct file access'
}
[Console]::WriteLine('listing-denied; direct-file-readable')
`);
  assert.match(stdout, /listing-denied; direct-file-readable/);
  return restore;
}

test(
  "NSIS retries a temporary Windows file lock and preserves user data",
  { skip: !canExecuteNsis },
  async (t) => {
    const app = await compileFixture(t);
    await app.initialize();
    const release = await lockFile(app, 15_000);
    const uninstalled = app.uninstall();
    const deadline = Date.now() + 5_000;
    // Releasing on a timer alone could miss the failure on a slow Windows host.
    while (await exists(path.join(app.installation, "before.txt"))) {
      assert.ok(Date.now() < deadline, "NSIS did not begin its first removal attempt");
      await delay(25);
    }
    await release();
    assert.equal(await uninstalled, 0);
    assert.equal(await exists(app.installation), false);
    assert.equal(await exists(app.completed), true);
    assert.equal(await readFile(app.sentinel, "utf8"), "preserve user data");
  },
);

test(
  "NSIS preserves a retryable registered uninstaller after a persistent Windows file lock",
  { skip: !canExecuteNsis },
  async (t) => {
    const app = await compileFixture(t);
    await app.initialize();
    const originalUninstaller = await readFile(app.registeredUninstaller);
    const release = await lockFile(app, 20_000);
    const started = performance.now();
    assert.equal(await app.uninstall(), 2);
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 4_500 && elapsed < 6_500, `Removal took ${elapsed} ms`);
    assert.equal(await exists(app.executable), true);
    assert.equal(await exists(app.completed), false);
    assert.equal(await readFile(app.registration, "utf8"), app.registeredUninstaller);
    assert.deepEqual(await readFile(app.registeredUninstaller), originalUninstaller);
    assert.equal(await readFile(app.sentinel, "utf8"), "preserve user data");
    await release();
    await app.uninstallFromRegisteredEntry();
    assert.equal(await exists(app.installation), false);
    assert.equal(await exists(app.registration), false);
    assert.equal(await readFile(app.sentinel, "utf8"), "preserve user data");
  },
);

test(
  "NSIS aborts before deleting files if the registered uninstaller cannot be backed up",
  { skip: !canExecuteNsis },
  async (t) => {
    const app = await compileFixture(t);
    await app.initialize();
    await rm(app.registeredUninstaller);
    assert.equal(await app.uninstall(), 2);
    assert.equal(await exists(app.completed), false);
    assert.equal(await exists(app.registration), true);
    assert.equal(await exists(app.executable), true);
    assert.equal(
      await readFile(path.join(app.installation, "before.txt"), "utf8"),
      "original installation file",
    );
    assert.equal(await readFile(app.sentinel, "utf8"), "preserve user data");
  },
);

test(
  "NSIS rejects a directory-listing denial and leaves the registered entry retryable",
  { skip: !canExecuteNsis },
  async (t) => {
    const app = await compileFixture(t);
    await app.initialize();
    const originalUninstaller = await readFile(app.registeredUninstaller);
    const restore = await denyDirectoryListing(app);
    try {
      assert.equal(await app.uninstall(), 2);
      assert.equal(await exists(app.completed), false);
      assert.equal(await readFile(app.registration, "utf8"), app.registeredUninstaller);
      assert.equal(await exists(app.executable), true);
      assert.deepEqual(await readFile(app.registeredUninstaller), originalUninstaller);
      assert.equal(await readFile(app.sentinel, "utf8"), "preserve user data");
    } finally {
      await restore();
    }
    await app.uninstallFromRegisteredEntry();
    assert.equal(await exists(app.installation), false);
    assert.equal(await exists(app.registration), false);
    assert.equal(await readFile(app.sentinel, "utf8"), "preserve user data");
  },
);

test(
  "NSIS completes an atomic upgrade and preserves user data",
  { skip: !canExecuteNsis },
  async (t) => {
    const app = await compileFixture(t, { updated: true });
    await app.initialize();
    assert.equal(await app.uninstall(), 0);
    assert.equal(await exists(app.installation), false);
    assert.equal(await exists(app.completed), true);
    assert.equal(await readFile(app.sentinel, "utf8"), "preserve user data");
  },
);

test(
  "NSIS preserves the upstream result when an upgrade uninstaller runs in place",
  { skip: !canExecuteNsis },
  async (t) => {
    const baseline = await compileFixture(t, { updated: true, inPlace: true, baseline: true });
    const current = await compileFixture(t, { updated: true, inPlace: true });
    await baseline.initialize();
    await current.initialize();
    const expected = await baseline.uninstall();
    assert.equal(await current.uninstall(), expected);
    for (const filename of ["AgentKib.exe", "before.txt", "Uninstall AgentKib.exe"]) {
      assert.equal(
        await exists(path.join(current.installation, filename)),
        await exists(path.join(baseline.installation, filename)),
        `${filename} differs from the upstream in-place result`,
      );
    }
    assert.equal(await exists(current.completed), await exists(baseline.completed));
    assert.equal(await readFile(current.sentinel, "utf8"), "preserve user data");
  },
);

test(
  "NSIS retains installation files when an atomic upgrade cannot move the executable",
  { skip: !canExecuteNsis },
  async (t) => {
    const app = await compileFixture(t, { updated: true });
    await app.initialize();
    await lockFile(app, 15_000);
    assert.notEqual(await app.uninstall(), 0);
    assert.equal(await exists(app.executable), true);
    assert.equal(
      await readFile(path.join(app.installation, "before.txt"), "utf8"),
      "original installation file",
    );
    assert.equal(await exists(app.completed), false);
    assert.equal(await readFile(app.sentinel, "utf8"), "preserve user data");
  },
);
