import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import * as sqlite from "node:sqlite";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), "../../..");
const scenario = { workspaces: 24, threads: 5_000, previewBytes: 6_000, repeatRefreshes: 8 };
const timestamp = "2026-11-01T00:00:00.000Z";

if (process.argv[2] === "--worker") {
  await runWorker(JSON.parse(readFileSync(0, "utf8")));
} else if (process.argv[2] === "--help") {
  console.info(
    "Usage: node apps/desktop/scripts/benchmark-codex-catalog-io.mjs [--baseline-root /path/to/frozen/source]\n" +
      "Measures managed Codex catalog reads using the same isolated synthetic data in each source tree.",
  );
} else {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--baseline-root" && args[1]));
  const sources = [
    ...(args.length ? [{ label: "baseline", source: path.resolve(args[1]) }] : []),
    { label: "candidate", source: repository },
  ];
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-codex-catalog-")));
  try {
    const fixture = createFixture(root);
    const results = [];
    for (const { label, source } of sources) {
      const bundle = await buildWorker(source);
      const result = JSON.parse(
        execFileSync(process.execPath, [script, "--worker"], {
          input: JSON.stringify({ bundle, label, fixture }),
          encoding: "utf8",
          timeout: 120_000,
        }),
      );
      results.push({ label, source, ...result });
    }
    const baseline = results[0];
    for (const result of results.slice(1)) {
      assert.deepEqual(
        result.projectionHashes,
        baseline.projectionHashes,
        "Catalog output changed",
      );
    }
    console.info(
      JSON.stringify(
        {
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          scenario: { ...scenario, databaseBytes: statSync(fixture.database).size },
          projectionsMatch: results.length > 1 ? true : null,
          results,
          diskSampling:
            "macOS physical disk counters exclude reads served by the OS cache; null indicates unavailable counters.",
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function nativeId(index) {
  const id = `aabbccdd-eeee-4fff-8aaa-${index.toString(16).padStart(12, "0")}`;
  return index % 7 === 0 ? id.toUpperCase() : id;
}

function createFixture(root) {
  const home = path.join(root, "codex"),
    database = path.join(home, "state_5.sqlite");
  mkdirSync(path.join(home, "sessions"), { recursive: true });
  const workspaces = Array.from({ length: scenario.workspaces }, (_, index) => {
    const workspace = path.join(root, `workspace-${index}`);
    mkdirSync(workspace);
    return workspace;
  });
  const db = new sqlite.DatabaseSync(database);
  const preview = "x".repeat(scenario.previewBytes);
  try {
    db.exec(`CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT NOT NULL,
      title TEXT, source TEXT, thread_source TEXT, updated_at_ms INTEGER, preview TEXT
    ); BEGIN;`);
    const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, 'exec', 'user', ?, ?)");
    for (let index = 0; index < scenario.threads; index++) {
      const id = nativeId(index);
      const cwd = workspaces[index % workspaces.length];
      const rollout = path.join(home, "sessions", `rollout-${id}.jsonl`);
      insert.run(id, rollout, cwd, `Thread ${index}`, Date.parse(timestamp) + index, preview);
      if (index < workspaces.length) {
        writeFileSync(
          rollout,
          JSON.stringify({
            type: "session_meta",
            payload: { id, cwd, source: "exec", thread_source: "user" },
          }) + "\n",
        );
      }
    }
    db.exec("COMMIT;");
  } finally {
    db.close();
  }
  writeFileSync(
    path.join(home, ".codex-global-state.json"),
    JSON.stringify({
      "projectless-thread-ids": [nativeId(0), nativeId(1)],
    }),
  );
  return { root, home, database, workspaces };
}

async function buildWorker(source) {
  const { build } = await import("vite");
  const entry = path.join(source, ".codex-catalog-io-benchmark-entry.ts");
  const manifest = JSON.parse(
    readFileSync(path.join(source, "packages/backend/package.json"), "utf8"),
  );
  const dependencies = Object.entries(manifest.dependencies)
    .filter(([, version]) => !version.startsWith("workspace:"))
    .map(([name]) => name);
  const exports = {
    "managed-session-catalog": "managedCatalogProjection, readManagedCatalog",
    "managed-ledger": "retainManagedLedgerReaders, saveManagedRecord",
    "session-readers": "SessionReaders",
    store: "BackendStore",
  };
  const output = await build({
    configFile: false,
    root: source,
    logLevel: "error",
    define: { "import.meta.url": "require('node:url').pathToFileURL(__filename).href" },
    resolve: {
      alias: {
        "@agentkib/runtime-protocol": path.join(source, "packages/runtime-protocol/src/index.ts"),
      },
    },
    plugins: [
      {
        name: "codex-catalog-io-benchmark-entry",
        resolveId: (id) => (id === entry ? entry : undefined),
        load: (id) =>
          id === entry
            ? Object.entries(exports)
                .map(
                  ([file, names]) =>
                    `export { ${names} } from ${JSON.stringify(path.join(source, `packages/backend/src/${file}.ts`))};`,
                )
                .join("\n")
            : undefined,
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: { entry, formats: ["cjs"], fileName: () => "codex-catalog-io.cjs" },
      rolldownOptions: {
        external: (id) =>
          id.startsWith("node:") ||
          builtinModules.includes(id) ||
          dependencies.some((name) => id === name || id.startsWith(`${name}/`)),
      },
    },
  });
  const chunks = (Array.isArray(output) ? output : [output]).flatMap((result) => result.output);
  assert.equal(chunks.length, 1, "Expected one in-memory bundle");
  assert.equal(chunks[0].type, "chunk");
  return chunks[0].code;
}

function queryCategory(sql) {
  if (/^PRAGMA table_info\(threads\)/i.test(sql)) return "schemaReads";
  if (/^PRAGMA data_version/i.test(sql)) return "generationReads";
  if (/^SELECT id FROM threads\b/i.test(sql)) return "idIndexQueries";
  if (!/\bFROM threads\b/i.test(sql)) return "otherQueries";
  if (/\bCOLLATE NOCASE\b/i.test(sql)) return "caseInsensitiveQueries";
  return /\bWHERE\b/i.test(sql) ? "filteredQueries" : "fullThreadQueries";
}

async function runWorker({ bundle, label, fixture }) {
  let counts;
  class CountedDatabase extends sqlite.DatabaseSync {
    constructor(file, ...options) {
      super(file, ...options);
      this.counted = file === fixture.database;
      if (this.counted && counts) counts.nativeOpens++;
    }
    prepare(sql) {
      const statement = super.prepare(sql);
      if (!this.counted) return statement;
      const category = queryCategory(sql);
      const all = statement.all.bind(statement),
        get = statement.get.bind(statement);
      statement.all = (...args) => {
        const result = all(...args);
        if (counts) {
          counts[category]++;
          if (category === "fullThreadQueries" || category === "filteredQueries") {
            counts.threadRows += result.length;
          }
        }
        return result;
      };
      statement.get = (...args) => {
        const result = get(...args);
        if (counts) counts[category]++;
        return result;
      };
      return statement;
    }
  }
  const requireDependency = createRequire(path.join(repository, "packages/backend/package.json"));
  const module = { exports: {} };
  new Function("require", "exports", "module", "__filename", "__dirname", bundle)(
    (id) =>
      id === "node:sqlite" ? { ...sqlite, DatabaseSync: CountedDatabase } : requireDependency(id),
    module.exports,
    module,
    script,
    path.dirname(script),
  );
  const api = module.exports;
  const data = path.join(fixture.root, label);
  const store = new api.BackendStore(path.join(data, "index.sqlite"));
  const env = { CODEX_HOME: fixture.home, HOME: fixture.root, USERPROFILE: fixture.root, PATH: "" };
  store.sql.run(
    "INSERT INTO schema_meta(key,value) VALUES ('conversation_salt',?)",
    "catalog-io-benchmark",
  );
  const readers = new api.SessionReaders(
    store.sessions,
    {
      run: () => {
        throw new Error("Benchmark cannot launch native agent commands");
      },
    },
    env,
    { profiles: async () => [] },
  );
  let releaseLedger;
  try {
    fixture.workspaces.forEach((workspace, index) => {
      const workspaceId = `workspace-${index}`;
      store.sql.run(
        "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES (?,?,?,?,?)",
        workspaceId,
        workspace,
        workspaceId,
        "healthy",
        timestamp,
      );
      api.saveManagedRecord(data, {
        id: `managed-${index}`,
        workspace_id: workspaceId,
        workspace,
        cwd: workspace,
        home: fixture.home,
        native_id: nativeId(index).toLowerCase(),
        title: `Thread ${index}`,
        created_at: timestamp,
        released: false,
        adopted: false,
      });
    });
    releaseLedger = api.retainManagedLedgerReaders(data);
    async function refresh(times) {
      let last;
      counts = {
        nativeOpens: 0,
        schemaReads: 0,
        generationReads: 0,
        idIndexQueries: 0,
        caseInsensitiveQueries: 0,
        filteredQueries: 0,
        fullThreadQueries: 0,
        otherQueries: 0,
        threadRows: 0,
      };
      const metrics = await sample(async () => {
        for (let index = 0; index < times; index++) {
          last = await api.managedCatalogProjection(store, readers, api.readManagedCatalog(data));
          assert.equal(last.aliases.size, scenario.workspaces);
          assert.equal(last.nativeByOwner.size, scenario.workspaces);
        }
      });
      const projection = [
        [...last.aliases].sort().map(([owner, aliases]) => [owner, [...aliases].sort()]),
        [...last.nativeByOwner].sort(),
      ];
      const hash = createHash("sha256").update(JSON.stringify(projection)).digest("hex");
      return { hash, metrics: { ...metrics, ...counts }, last };
    }
    const first = await refresh(1);
    const repeat = await refresh(scenario.repeatRefreshes);
    assert.equal(first.hash, repeat.hash, "Repeated refresh changed catalog output");
    const writer = new sqlite.DatabaseSync(fixture.database);
    try {
      const update = writer.prepare("UPDATE threads SET title = ? WHERE id = ?");
      update.run("Updated thread 2", nativeId(2));
      const changed = await refresh(1);
      assert.equal(changed.last.nativeByOwner.get("managed-2")?.title, "Updated thread 2");
      process.stdout.write(
        JSON.stringify({
          owners: first.last.aliases.size,
          projectionHashes: { first: first.hash, repeat: repeat.hash, changed: changed.hash },
          first: first.metrics,
          repeat: repeat.metrics,
          changed: changed.metrics,
        }),
      );
    } finally {
      writer.prepare("UPDATE threads SET title = ? WHERE id = ?").run("Thread 2", nativeId(2));
      writer.close();
    }
  } finally {
    releaseLedger?.();
    readers.close();
    store.close();
  }
}

function diskSample() {
  if (process.platform !== "darwin") return null;
  try {
    return JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          [
            "import ctypes,json,struct,sys",
            "lib=ctypes.CDLL('/usr/lib/libproc.dylib')",
            "buf=ctypes.create_string_buffer(1024)",
            "assert lib.proc_pid_rusage(int(sys.argv[1]),2,ctypes.byref(buf)) == 0",
            "v=struct.unpack_from('18Q',buf,16)",
            "print(json.dumps({'read':v[16],'write':v[17]}))",
          ].join("\n"),
          String(process.pid),
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    );
  } catch {
    return null;
  }
}

async function sample(run) {
  const before = diskSample();
  const rssBeforeBytes = process.memoryUsage.rss();
  const cpu = process.cpuUsage();
  const start = performance.now();
  await run();
  const elapsedMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  const after = diskSample();
  return {
    elapsedMs,
    cpuMs: (used.user + used.system) / 1_000,
    rssBeforeBytes,
    rssAfterBytes: process.memoryUsage.rss(),
    peakRssKiB: process.resourceUsage().maxRSS,
    diskReadBytes: before && after ? after.read - before.read : null,
    diskWriteBytes: before && after ? after.write - before.write : null,
  };
}
