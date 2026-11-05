import { createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const collectorDirectory = path.dirname(fileURLToPath(import.meta.url));
export const desktopDirectory = path.resolve(collectorDirectory, "../..");
export const resourceDirectory = path.join(desktopDirectory, "resources/quota");
export const lock = JSON.parse(await readFile(path.join(collectorDirectory, "lock.json"), "utf8"));

export function hostTarget() {
  const arch = { arm64: "aarch64", x64: "x86_64" }[process.arch];
  const platform = { darwin: "apple-darwin", linux: "unknown-linux-gnu", win32: "pc-windows-msvc" }[
    process.platform
  ];
  if (!arch || !platform)
    throw new Error(`Unsupported quota host ${process.platform}/${process.arch}`);
  return `${arch}-${platform}`;
}

export function run(program, args, options = {}) {
  const result = spawnSync(program, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${program} ${args[0] ?? ""} failed (${result.status ?? result.signal})`);
  return result;
}

export async function sha256(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

export async function sourceTreeHash(root) {
  const entries = [];
  async function visit(relative) {
    for (const item of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (!relative && [".build", "target", ".swiftpm", ".git"].includes(item.name)) continue;
      const file = relative ? `${relative}/${item.name}` : item.name;
      if (item.isDirectory()) await visit(file);
      else if (item.isFile()) entries.push(`F ${file}\0${await sha256(path.join(root, file))}\n`);
      else if (item.isSymbolicLink())
        entries.push(`L ${file}\0${await readlink(path.join(root, file))}\n`);
      else throw new Error(`Unexpected collector source type ${file}`);
    }
  }
  await visit("");
  return createHash("sha256").update(entries.sort().join("")).digest("hex");
}

export function binaryPath(target, root = resourceDirectory) {
  if (target.endsWith("windows-msvc"))
    return path.join(root, "resources/windows/agentkib-quota-sidecar.exe");
  if (target.includes("linux")) return path.join(root, "resources/linux/CodexBarCLI");
  return path.join(root, "binaries", `agentkib-quota-sidecar-${target}`);
}

export async function preparedManifest(target, root = resourceDirectory) {
  try {
    const manifest = JSON.parse(
      await readFile(path.join(root, `manifests/${target}.json`), "utf8"),
    );
    const spec = lock.upstreams[lock.targets[target]?.upstream];
    const platform = target.endsWith("windows-msvc")
      ? "win32"
      : target.includes("apple")
        ? "darwin"
        : "linux";
    if (
      !spec ||
      manifest.commit !== spec.commit ||
      manifest.patchSha256 !== spec.patchSha256 ||
      manifest.patchRevision !== lock.patchRevision ||
      manifest.version !== spec.version ||
      manifest.target !== target ||
      JSON.stringify(manifest.features) !== JSON.stringify(lock.features)
    )
      return undefined;
    if (
      typeof manifest.toolchain !== "string" ||
      !manifest.toolchain.includes(spec.toolchain[platform])
    )
      return undefined;
    for (const [relative, expected] of Object.entries(manifest.files)) {
      if (
        relative.split(/[\\/]/).includes("..") ||
        path.isAbsolute(relative) ||
        (await sha256(path.join(root, relative))) !== expected
      )
        return undefined;
    }
    if (!manifest.files[path.relative(root, binaryPath(target, root)).split(path.sep).join("/")])
      return undefined;
    return manifest;
  } catch {
    return undefined;
  }
}

export async function prepareSources(target) {
  const spec = lock.upstreams[lock.targets[target]?.upstream];
  if (!spec) throw new Error(`No collector source recipe for ${target}`);
  const cacheRoot =
    process.env.AGENTKIB_QUOTA_BUILD_CACHE ?? path.join(homedir(), ".cache/agentkib/quota-build");
  const archive = path.join(cacheRoot, `${spec.commit}.tar.gz`);
  const source = path.join(cacheRoot, `${spec.commit}-patch${lock.patchRevision}`);
  await mkdir(cacheRoot, { recursive: true });
  const matches = async (file, expected) => {
    try {
      return (await sha256(file)) === expected;
    } catch {
      return false;
    }
  };
  if (!(await matches(archive, spec.sourceSha256))) {
    const supplied = process.env.AGENTKIB_QUOTA_SOURCE_ARCHIVE;
    const temporary = `${archive}.download`;
    if (supplied) await copyFile(supplied, temporary);
    else
      run(process.platform === "win32" ? "curl.exe" : "curl", [
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "--max-time",
        "300",
        spec.sourceUrl,
        "--output",
        temporary,
      ]);
    if (!(await matches(temporary, spec.sourceSha256)))
      throw new Error("Quota collector source checksum mismatch");
    await copyFile(temporary, archive);
    await rm(temporary, { force: true });
  }
  const patch = path.join(collectorDirectory, spec.patch);
  if (!(await matches(patch, spec.patchSha256)))
    throw new Error("Quota collector patch checksum mismatch");
  try {
    await access(path.join(source, spec.dependencyLock));
  } catch {
    await mkdir(source, { recursive: true });
    run("tar", ["-xzf", archive, "--strip-components=1", "-C", source]);
  }
  if (!(await matches(path.join(source, spec.dependencyLock), spec.dependencyLockSha256)))
    throw new Error("Quota dependency lock mismatch; remove this build cache and retry");
  const alreadyPatched = (
    await Promise.all(
      Object.entries(spec.patchedFiles).map(([file, hash]) =>
        matches(path.join(source, file), hash),
      ),
    )
  ).every(Boolean);
  if (!alreadyPatched) {
    run("git", ["apply", "--check", patch], { cwd: source });
    run("git", ["apply", patch], { cwd: source });
  }
  for (const [file, hash] of Object.entries(spec.patchedFiles)) {
    if (!(await matches(path.join(source, file), hash)))
      throw new Error(`Unexpected patched source ${file}`);
  }
  if ((await sourceTreeHash(source)) !== spec.patchedTreeSha256)
    throw new Error(
      "Collector source tree changed outside the locked patch; remove this source cache and retry",
    );
  return { source, spec };
}

export async function prepareQuotaSidecar() {
  const target = process.env.AGENTKIB_QUOTA_TARGET ?? hostTarget();
  if (!lock.targets[target]) {
    if (target === "aarch64-pc-windows-msvc") {
      await rm(path.join(resourceDirectory, "resources/windows/agentkib-quota-sidecar.exe"), {
        force: true,
      });
      process.stdout.write("AgentKib quota collector: Windows ARM64 is unsupported.\n");
      return;
    }
    throw new Error(`Unsupported collector target ${target}`);
  }
  if ((await preparedManifest(target)) && !process.argv.includes("--rebuild")) {
    // GitHub artifacts preserve file bytes but reset Unix executable modes.
    if (!target.endsWith("windows-msvc")) await chmod(binaryPath(target), 0o755);
    process.stdout.write(`AgentKib quota collector: verified patched ${target}.\n`);
    return;
  }
  const platform = target.endsWith("windows-msvc")
    ? "win32"
    : target.includes("apple")
      ? "darwin"
      : "linux";
  if (platform !== process.platform)
    throw new Error(
      `Build ${target} on its native platform; an unpatched release binary cannot be substituted`,
    );
  if (platform === "linux" && target !== hostTarget())
    throw new Error(`Build ${target} on its native architecture`);
  const { source, spec } = await prepareSources(target);
  const compiler = platform === "win32" ? "rustc" : "swift";
  const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
  if (version.status !== 0 || !version.stdout.includes(spec.toolchain[platform])) {
    throw new Error(
      `Collector requires ${spec.toolchain[platform]}; found ${version.stdout?.trim() || "no toolchain"}`,
    );
  }
  let buildDirectory;
  const env = {
    ...process.env,
    CODEXBAR_USE_LOCAL_SWEETCOOKIEKIT: "0",
    MACOSX_DEPLOYMENT_TARGET: "14.0",
  };
  if (platform === "win32") {
    run(
      "cargo",
      [
        "build",
        "--locked",
        "--release",
        "--package",
        "codexbar",
        "--bin",
        "codexbar",
        "--target",
        target,
      ],
      { cwd: source, env },
    );
    buildDirectory = path.join(source, "target", target, "release");
  } else {
    const args = [
      "build",
      "-c",
      "release",
      "--product",
      "CodexBarCLI",
      "--disable-automatic-resolution",
    ];
    if (platform === "darwin")
      args.push("--arch", target.startsWith("aarch64") ? "arm64" : "x86_64");
    else {
      const linux = await prepareLinuxSdk(source, spec);
      env.CODEXBAR_SQLITE3_LIB_DIR = linux.sqliteLibrary;
      args.push(
        "--swift-sdk",
        spec.linux.sdk,
        "--triple",
        `${target.startsWith("aarch64") ? "aarch64" : "x86_64"}-swift-linux-musl`,
      );
    }
    run("swift", args, { cwd: source, env });
    const result = spawnSync("swift", [...args, "--show-bin-path"], {
      cwd: source,
      env,
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error("Unable to locate the Swift CLI build");
    buildDirectory = result.stdout.trim();
  }
  const destination = binaryPath(target);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(
    path.join(buildDirectory, platform === "win32" ? "codexbar.exe" : "CodexBarCLI"),
    destination,
  );
  if (platform !== "win32") await chmod(destination, 0o755);
  if (platform === "darwin") {
    const architecture = spawnSync("lipo", ["-archs", destination], { encoding: "utf8" });
    if (
      architecture.status !== 0 ||
      architecture.stdout.trim() !== (target.startsWith("aarch64") ? "arm64" : "x86_64")
    )
      throw new Error("Collector Mach-O architecture does not match its target");
  } else if (platform === "linux") {
    const format = spawnSync("file", [destination], { encoding: "utf8" });
    if (
      format.status !== 0 ||
      !format.stdout.includes(target.startsWith("aarch64") ? "aarch64" : "x86-64") ||
      !format.stdout.includes("statically linked")
    )
      throw new Error("Collector must be the target architecture's static musl binary");
  } else {
    const bytes = await readFile(destination);
    const header = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : -1;
    if (
      header < 0 ||
      header + 6 > bytes.length ||
      bytes.toString("ascii", header, header + 4) !== "PE\0\0" ||
      bytes.readUInt16LE(header + 4) !== 0x8664
    )
      throw new Error("Collector must be a Windows x64 PE binary");
  }
  const paths = [destination];
  if (platform !== "win32") {
    let bundle = path.join(buildDirectory, "CodexBar_CodexBarCore.bundle");
    try {
      await access(bundle);
    } catch {
      bundle = path.join(buildDirectory, "CodexBar_CodexBarCore.resources");
    }
    const bundleDestination = path.resolve(
      path.dirname(destination),
      platform === "darwin"
        ? "../resources/CodexBar_CodexBarCore.bundle"
        : "CodexBar_CodexBarCore.bundle",
    );
    await rm(bundleDestination, { recursive: true, force: true });
    await cp(bundle, bundleDestination, { recursive: true });
    paths.push(...(await filesIn(bundleDestination)));
    const notices = path.join(
      resourceDirectory,
      "resources/licenses/CodexBar-THIRD_PARTY_NOTICES.txt",
    );
    await mkdir(path.dirname(notices), { recursive: true });
    run("python3", ["Scripts/acknowledgements.py", "--text-output", notices], { cwd: source });
    paths.push(notices);
  }
  const versionFile = path.join(path.dirname(destination), "VERSION");
  await writeFile(versionFile, `${spec.version}+agentkib.${lock.patchRevision}\n`);
  paths.push(versionFile);
  const manifest = {
    schemaVersion: 1,
    target,
    version: spec.version,
    commit: spec.commit,
    patchRevision: lock.patchRevision,
    patchSha256: spec.patchSha256,
    features: lock.features,
    toolchain: version.stdout.trim(),
    files: Object.fromEntries(
      await Promise.all(
        paths.map(async (file) => [
          path.relative(resourceDirectory, file).split(path.sep).join("/"),
          await sha256(file),
        ]),
      ),
    ),
  };
  const manifests = path.join(resourceDirectory, "manifests");
  await mkdir(manifests, { recursive: true });
  await writeFile(path.join(manifests, `${target}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  if (!(await preparedManifest(target)))
    throw new Error("Prepared collector failed integrity verification");
  process.stdout.write(`AgentKib quota collector: built patched ${spec.version} for ${target}.\n`);
}

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesIn(file)));
    else if (entry.isFile()) files.push(file);
    else throw new Error(`Unexpected resource type ${file}`);
  }
  return files;
}

// Same SDK and SQLite recipe as upstream .github/workflows/release-cli.yml.
// Do not prune the SDK's other architecture: both local build targets may share it.
export function swiftSdkRootFromConfiguration(configuration) {
  const roots = configuration
    .split(/\r?\n/)
    .filter((line) => line.startsWith("sdkRootPath: "))
    .map((line) => line.slice("sdkRootPath: ".length));
  if (roots.length !== 1 || !path.posix.isAbsolute(roots[0]) || roots[0].includes("\0"))
    throw new Error("Swift SDK configuration must contain one absolute sdkRootPath");
  return roots[0];
}

async function prepareLinuxSdk(source, spec) {
  const settings = spec.linux;
  const sdkList = spawnSync("swift", ["sdk", "list"], { encoding: "utf8" });
  if (sdkList.status !== 0) throw new Error("Unable to list installed Swift SDKs");
  if (!sdkList.stdout?.split(/\r?\n/).includes(settings.sdk)) {
    run("bash", ["Scripts/install_swift_static_sdk.sh"], {
      cwd: source,
      env: {
        ...process.env,
        SWIFT_STATIC_LINUX_SDK_URL: settings.url,
        SWIFT_STATIC_LINUX_SDK_CHECKSUM: settings.sha256,
      },
    });
  }
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const triple = `${arch}-swift-linux-musl`;
  let sysroot;
  if (process.env.AGENTKIB_SWIFT_SDK_BUNDLE) {
    sysroot = path.join(
      process.env.AGENTKIB_SWIFT_SDK_BUNDLE,
      settings.sdk,
      "swift-linux-musl/musl-1.2.5.sdk",
      arch,
    );
  } else {
    // SwiftPM chooses its data directory per platform/XDG settings, not ~/.swiftpm.
    const configuration = spawnSync(
      "swift",
      ["sdk", "configure", "--show-configuration", settings.sdk, triple],
      { encoding: "utf8" },
    );
    if (configuration.status !== 0)
      throw new Error("Unable to read the installed Swift SDK configuration");
    sysroot = swiftSdkRootFromConfiguration(configuration.stdout);
  }
  await access(sysroot);
  const root = path.join(path.dirname(source), `sqlite-${settings.sqliteVersion}-${triple}`);
  await mkdir(root, { recursive: true });
  const archive = path.join(root, "sqlite.zip");
  run("curl", [
    "--fail",
    "--location",
    "--silent",
    "--show-error",
    "--max-time",
    "300",
    settings.sqliteUrl,
    "--output",
    archive,
  ]);
  if (
    createHash("sha3-256")
      .update(await readFile(archive))
      .digest("hex") !== settings.sqliteSha3
  )
    throw new Error("SQLite source checksum mismatch");
  run("unzip", ["-q", "-o", archive, "-d", root]);
  const amalgamation = path.join(root, `sqlite-amalgamation-${settings.sqliteVersion}`);
  await mkdir(path.join(sysroot, "usr/include"), { recursive: true });
  await copyFile(path.join(amalgamation, "sqlite3.h"), path.join(sysroot, "usr/include/sqlite3.h"));
  await mkdir(path.join(root, "lib"), { recursive: true });
  run("clang", [
    "-target",
    triple,
    `--sysroot=${sysroot}`,
    "-O2",
    "-DSQLITE_OMIT_LOAD_EXTENSION=1",
    "-c",
    path.join(amalgamation, "sqlite3.c"),
    "-o",
    path.join(root, "sqlite3.o"),
  ]);
  run("llvm-ar", ["crs", path.join(root, "lib/libsqlite3.a"), path.join(root, "sqlite3.o")]);
  return { sqliteLibrary: path.join(root, "lib") };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await prepareQuotaSidecar();
