import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  binaryPath,
  collectorDirectory,
  desktopDirectory,
  lock,
  preparedManifest,
  sha256,
  sourceTreeHash,
  swiftSdkPathsFromConfiguration,
  swiftSdkRootFromConfiguration,
  writeSingleTargetSwiftSdk,
} from "./build.mjs";

test("upstream lock pins exact commits, source archives, dependency locks, patches and native source markers", async () => {
  for (const spec of Object.values(lock.upstreams)) {
    assert.match(spec.commit, /^[a-f\d]{40}$/);
    assert(spec.sourceUrl.endsWith(spec.commit));
    for (const hash of [
      spec.sourceSha256,
      spec.dependencyLockSha256,
      spec.patchSha256,
      spec.patchedTreeSha256,
    ])
      assert.match(hash, /^[a-f\d]{64}$/);
    const patch = path.join(collectorDirectory, spec.patch);
    assert.equal(await sha256(patch), spec.patchSha256);
    const content = await readFile(patch, "utf8");
    assert.match(content, /no[-_]local[-_]costs/);
    assert.match(content, /agentkib-native-only/);
    assert.match(content, /agentkibNativeOnly/);
    assert.match(content, /include[_A-Z]?[Ll]ocal[_A-Z]?[Cc]osts/);
    assert(Object.keys(spec.patchedFiles).some((file) => /Tests|tests|source.rs/.test(file)));
  }
});

test("only a pinned manifest with matching actual files permits staging", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agentkib-collector-manifest-"));
  try {
    const target = "aarch64-apple-darwin";
    const spec = lock.upstreams.codexbar;
    const binary = binaryPath(target, directory);
    await mkdir(path.dirname(binary), { recursive: true });
    await mkdir(path.join(directory, "manifests"));
    await writeFile(binary, "synthetic patched binary");
    assert.equal(await preparedManifest(target, directory), undefined);
    const manifest = {
      schemaVersion: 1,
      target,
      version: spec.version,
      commit: spec.commit,
      patchRevision: lock.patchRevision,
      patchSha256: spec.patchSha256,
      features: lock.features,
      toolchain: spec.toolchain.darwin,
      files: { [path.relative(directory, binary).split(path.sep).join("/")]: await sha256(binary) },
    };
    const file = path.join(directory, `manifests/${target}.json`);
    await writeFile(file, JSON.stringify(manifest));
    assert(await preparedManifest(target, directory));
    await writeFile(binary, "old or corrupt binary");
    assert.equal(await preparedManifest(target, directory), undefined);
    await writeFile(binary, "synthetic patched binary");
    await writeFile(file, JSON.stringify({ ...manifest, commit: "old" }));
    assert.equal(await preparedManifest(target, directory), undefined);
    await writeFile(file, JSON.stringify({ ...manifest, toolchain: "old compiler" }));
    assert.equal(await preparedManifest(target, directory), undefined);
    await writeFile(
      file,
      JSON.stringify({
        ...manifest,
        files: { ...manifest.files, "resources/../../outside": "invalid" },
      }),
    );
    assert.equal(await preparedManifest(target, directory), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Swift SDK roots come from the configured target instead of an assumed installation directory", () => {
  for (const architecture of ["x86_64", "aarch64"]) {
    const root = `/home/runner/.local/share/org.swift.swiftpm/swift-sdks/swift-6.3.3-RELEASE_static-linux-0.1.0.artifactbundle/swift-6.3.3-RELEASE_static-linux-0.1.0/swift-linux-musl/musl-1.2.5.sdk/${architecture}`;
    const configuration = [
      `sdkRootPath: ${root}`,
      `swiftResourcesPath: ${root}/usr/lib/swift_static`,
      `swiftStaticResourcesPath: ${root}/usr/lib/swift_static`,
      "includeSearchPaths: not set",
      "librarySearchPaths: not set",
      "toolsetPaths: []",
    ];
    assert.equal(swiftSdkRootFromConfiguration(configuration.join("\n")), root);
    assert.equal(swiftSdkRootFromConfiguration(configuration.join("\r\n")), root);
  }
  assert.equal(
    swiftSdkRootFromConfiguration("sdkRootPath: /custom SDK/musl/x86_64\n"),
    "/custom SDK/musl/x86_64",
  );
  for (const output of [
    "",
    "sdkRootPath: not set\n",
    "sdkRootPath: relative/path\n",
    "sdkRootPath: /one\nsdkRootPath: /two\n",
    "sdkRootPath: /invalid\0path\n",
  ])
    assert.throws(() => swiftSdkRootFromConfiguration(output), /one absolute sdkRootPath/);
});

test("isolated SDK metadata exposes only its target and preserves configured absolute paths", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agentkib-single-target-sdk-"));
  try {
    const sdk = lock.upstreams.codexbar.linux.sdk;
    for (const arch of ["x86_64", "aarch64"]) {
      const triple = `${arch}-swift-linux-musl`;
      const sysroot = `/installed SDK/musl/${arch}`;
      const paths = swiftSdkPathsFromConfiguration(
        [
          `sdkRootPath: ${sysroot}`,
          `swiftResourcesPath: ${sysroot}/usr/lib/swift_static`,
          `swiftStaticResourcesPath: ${sysroot}/usr/lib/swift_static`,
          "includeSearchPaths: not set",
          "librarySearchPaths: not set",
          'toolsetPaths: ["/installed SDK/toolset.json"]',
        ].join("\n"),
      );
      const root = await writeSingleTargetSwiftSdk(path.join(directory, arch), sdk, triple, paths);
      const bundle = path.join(root, `${sdk}.artifactbundle`);
      const info = JSON.parse(await readFile(path.join(bundle, "info.json"), "utf8"));
      const metadata = JSON.parse(await readFile(path.join(bundle, "sdk/swift-sdk.json"), "utf8"));
      assert.deepEqual(info.artifacts[sdk].variants, [{ path: "sdk" }]);
      assert.deepEqual(Object.keys(metadata.targetTriples), [triple]);
      assert.deepEqual(metadata.targetTriples[triple], paths);
      assert.equal(metadata.targetTriples[triple].sdkRootPath, sysroot);
      assert.deepEqual(metadata.targetTriples[triple].toolsetPaths, [
        "/installed SDK/toolset.json",
      ]);
    }
    for (const invalid of [
      'toolsetPaths: "not-an-array"',
      'toolsetPaths: ["relative/toolset.json"]',
      'toolsetPaths: ["/one"]\ntoolsetPaths: ["/two"]',
      "swiftResourcesPath: relative/resources",
    ])
      assert.throws(() => swiftSdkPathsFromConfiguration(`sdkRootPath: /sdk\n${invalid}\n`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("source patches retain locked LF bytes when the host enables autocrlf", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agentkib-patch-eol-"));
  try {
    const source = path.join(directory, "source");
    await mkdir(source);
    const file = path.join(source, "source.rs");
    const patch = path.join(directory, "change.patch");
    const config = path.join(directory, "gitconfig");
    await writeFile(file, "let value = 1;\n");
    await writeFile(config, "[core]\n\tautocrlf = true\n");
    await writeFile(
      patch,
      "--- a/source.rs\n+++ b/source.rs\n@@ -1 +1 @@\n-let value = 1;\n+let value = 2;\n",
    );
    const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" };
    const setting = spawnSync("git", ["config", "--get", "core.autocrlf"], {
      cwd: source,
      env,
      encoding: "utf8",
    });
    assert.equal(setting.status, 0, setting.stderr);
    assert.equal(setting.stdout.trim(), "true");
    const code = `import { applySourcePatch } from ${JSON.stringify(new URL("./build.mjs", import.meta.url).href)}; applySourcePatch(process.argv[1], process.argv[2]);`;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", code, source, patch],
      { cwd: source, env, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(file, "utf8"), "let value = 2;\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unlocked source edits invalidate provenance while compiler caches do not", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agentkib-collector-tree-"));
  try {
    await writeFile(path.join(directory, "source.swift"), "let count = 1\n");
    const original = await sourceTreeHash(directory);
    await mkdir(path.join(directory, ".build"));
    await writeFile(path.join(directory, ".build/compiled"), "compiler output");
    assert.equal(await sourceTreeHash(directory), original);
    await writeFile(path.join(directory, "source.swift"), "let count = 2\n");
    assert.notEqual(await sourceTreeHash(directory), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stage fails explicitly for an unprepared target and never substitutes an official binary", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(desktopDirectory, "scripts/stage-electron-quota.mjs")],
    {
      encoding: "utf8",
      env: { ...process.env, AGENTKIB_QUOTA_TARGET: "unprepared-test-target" },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No verified patched collector/);
});
