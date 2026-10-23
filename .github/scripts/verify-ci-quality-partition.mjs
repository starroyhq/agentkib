import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktopRoot = fileURLToPath(new URL("../../apps/desktop/", import.meta.url));
const require = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const { createVitest } = await import(pathToFileURL(require.resolve("vitest/node")).href);
const ctx = await createVitest({ root: desktopRoot, watch: false });

function files(specifications) {
  return new Set(specifications.map((specification) => specification.moduleId));
}

try {
  const all = await ctx.getRelevantTestSpecifications([]);
  const projectNames = ["desktop", "filesystem", "mcp-latency"];
  assert.deepEqual(
    [...new Set(all.map((specification) => specification.project.name))].sort(),
    projectNames,
  );
  assert.equal(files(all).size, all.length, "A test file must belong to exactly one project");

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
    }),
  );
} finally {
  await ctx.close();
}
