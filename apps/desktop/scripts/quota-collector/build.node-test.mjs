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
  swiftSdkRootFromConfiguration,
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
