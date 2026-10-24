import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktopRoot = fileURLToPath(new URL("../../apps/desktop/", import.meta.url));
const require = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const { createVitest } = await import(pathToFileURL(require.resolve("vitest/node")).href);
const ctx = await createVitest({ root: desktopRoot, watch: false });

function files(specifications) {
  return new Set(
    specifications.map((specification) => specification.moduleId.replaceAll("\\", "/")),
  );
}

function assertHistorySourceIsolation(context, specifications) {
  const source = specifications.filter((specification) =>
    specification.moduleId.endsWith("/test/history-search-source.test.ts"),
  );
  const mcp = specifications.filter((specification) =>
    specification.moduleId.endsWith("/test/mcp-management.test.ts"),
  );
  assert.equal(source.length, 1, "History source coverage must remain exactly once");
  assert.equal(source[0].project.name, "filesystem", "History source must avoid competing workers");
  assert.equal(mcp.length, 1, "MCP management coverage must remain exactly once");
  assert.equal(mcp[0].project.name, "desktop");
  assert.ok(
    source[0].project.config.sequence.groupOrder > mcp[0].project.config.sequence.groupOrder,
    "History source must start after the parallel MCP group completes",
  );
  for (const name of ["filesystem", "mcp-latency"]) {
    const project = context.projects.find((candidate) => candidate.name === name);
    assert.ok(project, `Missing safety project: ${name}`);
    assert.equal(project.config.fileParallelism, false, `${name} must keep serial file execution`);
    assert.equal(project.config.maxWorkers, 1, `${name} must resolve to a single worker`);
  }
}

try {
  const all = await ctx.getRelevantTestSpecifications([]);
  const projectNames = ["desktop", "filesystem", "mcp-latency"];
  assert.deepEqual(
    [...new Set(all.map((specification) => specification.project.name))].sort(),
    projectNames,
  );
  assert.equal(files(all).size, all.length, "A test file must belong to exactly one project");
  assertHistorySourceIsolation(ctx, all);

  const ordinary = all.filter((specification) => specification.project.name === "desktop");
  const safety = all.filter((specification) => specification.project.name !== "desktop");
  const desktop = ctx.projects.find((project) => project.name === "desktop");
  for (const name of ["filesystem", "mcp-latency"]) {
    const project = ctx.projects.find((candidate) => candidate.name === name);
    assert.ok(project, `Missing safety project: ${name}`);
    assert.equal(project.config.fileParallelism, false, `${name} must keep serial file execution`);
    assert.ok(
      project.config.sequence.groupOrder > desktop.config.sequence.groupOrder,
      `${name} must retain its separate execution group`,
    );
  }
  const filesystem = ctx.projects.find((project) => project.name === "filesystem");
  const mcpLatency = ctx.projects.find((project) => project.name === "mcp-latency");
  assert.ok(filesystem.config.sequence.groupOrder < mcpLatency.config.sequence.groupOrder);

  // Vitest 5's static `list` command does not apply --shard. Use the same
  // resolved sequencer that its execution pool calls, without running tests.
  const shards = [];
  for (const index of [1, 2]) {
    ctx.config.shard = { index, count: 2 };
    shards.push(await new ctx.config.sequence.sequencer(ctx).shard(ordinary));
  }
  const [first, second] = shards.map(files);
  assert.ok(first.size > 0 && second.size > 0, "Both ordinary desktop shards must contain tests");
  assert.equal(
    [...first].filter((file) => second.has(file)).length,
    0,
    "Desktop shards must not overlap",
  );
  const ordinaryFiles = files(ordinary);
  const combinedShards = new Set([...first, ...second]);
  assert.equal(
    combinedShards.size,
    ordinaryFiles.size,
    "Desktop shards must cover the ordinary group",
  );
  assert.equal([...ordinaryFiles].filter((file) => !combinedShards.has(file)).length, 0);

  const selected = [...shards.flat(), ...safety];
  const selectedFiles = files(selected);
  assert.equal(selectedFiles.size, selected.length, "CI groups must execute each test file once");
  assert.equal(selected.length, all.length, "CI groups must preserve the full desktop suite");
  assert.equal([...files(all)].filter((file) => !selectedFiles.has(file)).length, 0);

  const packageJson = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const stability = packageJson.scripts["test:backend:stability"];
  const command =
    "node .github/scripts/smoke-test-backend-native.mjs && pnpm --filter @agentkib/desktop exec vitest run ";
  assert.ok(stability.startsWith(command), "Backend stability must retain the native smoke gate");
  const filters = stability.slice(command.length).trim().split(/\s+/);
  assert.ok(filters.every((file) => /^(?:electron|test)\/[\w/.-]+\.test\.tsx?$/.test(file)));
  assert.equal(new Set(filters).size, filters.length, "Stability filters must not repeat files");
  const windows = await createVitest({
    root: desktopRoot,
    watch: false,
    maxWorkers: 2,
    testTimeout: 15_000,
  });
  let stabilityFiles;
  try {
    const specifications = await windows.getRelevantTestSpecifications(filters);
    assert.equal(
      specifications.length,
      filters.length,
      "Every stability file must remain selected",
    );
    assert.equal(files(specifications).size, filters.length, "Stability coverage must stay unique");
    const expectedFiles = filters.map((file) =>
      fileURLToPath(new URL(`../../apps/desktop/${file}`, import.meta.url)).replaceAll("\\", "/"),
    );
    assert.deepEqual([...files(specifications)].sort(), expectedFiles.sort());
    assertHistorySourceIsolation(windows, specifications);
    assert.equal(
      windows.projects.find((project) => project.name === "desktop").config.maxWorkers,
      2,
    );
    for (const project of windows.projects) {
      assert.equal(project.config.testTimeout, 15_000, "Windows must retain its original budget");
    }
    stabilityFiles = specifications.length;
  } finally {
    await windows.close();
  }
  console.log(
    JSON.stringify({
      totalFiles: all.length,
      desktopShards: shards.map((shard) => shard.length),
      safetyProjects: Object.fromEntries(
        ["filesystem", "mcp-latency"].map((name) => [
          name,
          safety.filter((specification) => specification.project.name === name).length,
        ]),
      ),
      exactlyOnce: true,
      backendStabilityFiles: stabilityFiles,
      windowsSerialHistorySource: true,
    }),
  );
} finally {
  await ctx.close();
}
