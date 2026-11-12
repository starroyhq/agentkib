import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// No native agent process, model call, personal log, or credential is used.
const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), "../../..");
const scenario = { readCycles: 1_000, deltas: 600, deltaBytes: 32, intervalMs: 20 };

if (process.argv[2] === "--worker") {
  const { bundle, label } = JSON.parse(readFileSync(0, "utf8"));
  const module = { exports: {} };
  // Execute the trusted local source bundled by Vite, without writing a build artifact.
  new Function("require", "exports", "module", "__filename", "__dirname", bundle)(
    createRequire(import.meta.url),
    module.exports,
    module,
    script,
    path.dirname(script),
  );
  const api = module.exports;
  const root = mkdtempSync(path.join(tmpdir(), "agentkib-managed-io-"));
  let releaseReaders;
  let bridge;
  try {
    const record = {
      id: "managed",
      workspace_id: "workspace",
      workspace: path.join(root, "workspace"),
      home: path.join(root, "codex"),
      native_id: "thread",
      snapshot: { revision: 0 },
    };
    api.saveManagedRecord(root, record);
    // Match Runtime ownership; old baselines simply have no retained reader API.
    releaseReaders = api.retainManagedLedgerReaders?.(root);
    const ledger = path.join(root, "codex-managed/executions.sqlite");
    const before = statSync(ledger, { bigint: true });
    const reads = await sample(async () => {
      for (let index = 0; index < scenario.readCycles; index++) {
        assert.equal(api.readManagedRecord(root, record.id).id, record.id);
        assert.equal(api.listManagedRecords(root).length, 1);
        api.replayManagedCommand(root, "missing-command", "missing-fingerprint");
        api.readManagedCatalogSnapshot(root);
      }
    });
    const after = statSync(ledger, { bigint: true });
    reads.ctimeChanged = before.ctimeNs !== after.ctimeNs;
    reads.mtimeChanged = before.mtimeNs !== after.mtimeNs;

    let persists = 0;
    let published = 0;
    const session = Object.assign(new EventEmitter(), {
      connected: true,
      close: async () => {},
      respond() {},
      respondError() {},
    });
    const writer = api.createManagedSnapshotWriter(root, record);
    bridge = new api.ManagedCodexEventBridge(
      session,
      new api.ManagedCodexState(record),
      (snapshot, events) => {
        persists++;
        writer(snapshot, events);
      },
      () => published++,
    );
    const stream = await sample(async () => {
      session.emit("notification", {
        method: "turn/started",
        params: { threadId: "thread", turn: { id: "turn", status: "inProgress" } },
      });
      for (let index = 0; index < scenario.deltas; index++) {
        session.emit("notification", {
          method: "item/agentMessage/delta",
          params: { threadId: "thread", turnId: "turn", delta: "x".repeat(scenario.deltaBytes) },
        });
        await delay(scenario.intervalMs);
      }
      session.emit("notification", {
        method: "turn/completed",
        params: { threadId: "thread", turn: { id: "turn", status: "completed" } },
      });
      await bridge.flush();
    });
    const storedBytes = Buffer.byteLength(
      api.readManagedRecord(root, record.id).snapshot.streamText,
    );
    assert.equal(storedBytes, scenario.deltas * scenario.deltaBytes);
    assert.equal(published, scenario.deltas + 2, "Every delta and turn boundary must be published");
    Object.assign(stream, { persists, published, storedBytes });
    process.stdout.write(
      JSON.stringify({ label, retainedReaders: Boolean(releaseReaders), reads, stream }),
    );
  } finally {
    await bridge?.close();
    releaseReaders?.();
    rmSync(root, { recursive: true, force: true });
  }
} else {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.info(
      "Usage: node apps/desktop/scripts/benchmark-managed-io.mjs [--baseline-root /path/to/frozen/source]\n" +
        "Measures 1,000 ledger read cycles and 600 synthetic 32-byte deltas at 20 ms intervals.\n" +
        "macOS disk counters require python3; unavailable counters are null with a reason.",
    );
  } else {
    assert.ok(
      args.length === 0 || (args.length === 2 && args[0] === "--baseline-root" && args[1]),
      "Expected only --baseline-root /path/to/frozen/source (or --help)",
    );
    const roots = [
      ...(args.length ? [{ label: "baseline", root: path.resolve(args[1]) }] : []),
      { label: "candidate", root: repository },
    ];
    const { build } = await import("vite");
    const results = [];
    for (const { label, root } of roots) {
      const ledger = path.join(root, "packages/backend/src/managed-ledger.ts");
      const state = path.join(root, "packages/backend/src/managed-codex-state.ts");
      assert.ok(statSync(ledger).isFile() && statSync(state).isFile());
      const entry = path.join(root, ".managed-io-benchmark-entry.ts");
      const output = await build({
        configFile: false,
        root,
        logLevel: "error",
        plugins: [
          {
            name: "managed-io-benchmark-entry",
            resolveId: (id) => (id === entry ? entry : undefined),
            load: (id) =>
              id === entry
                ? `export * from ${JSON.stringify(ledger)}; export { ManagedCodexEventBridge, ManagedCodexState } from ${JSON.stringify(state)};`
                : undefined,
          },
        ],
        build: {
          write: false,
          minify: false,
          lib: { entry, formats: ["cjs"], fileName: () => "managed-io.cjs" },
          rollupOptions: {
            // Frozen source can live outside the checkout; reuse the installed dependencies.
            external: (id) => id.startsWith("node:") || id === "koffi" || id === "zod",
          },
        },
      });
      const chunks = (Array.isArray(output) ? output : [output]).flatMap((result) => result.output);
      assert.equal(chunks.length, 1, "Expected one in-memory bundle");
      assert.equal(chunks[0].type, "chunk");
      const bundle = chunks[0].code;
      const result = JSON.parse(
        execFileSync(process.execPath, [script, "--worker"], {
          input: JSON.stringify({ bundle, label }),
          encoding: "utf8",
          timeout: 120_000,
          maxBuffer: 2 * 1024 * 1024,
        }),
      );
      results.push({
        ...result,
        sourceRoot: root,
        bundleSha256: createHash("sha256").update(bundle).digest("hex"),
      });
    }
    console.info(
      JSON.stringify(
        {
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          scenario,
          results,
          note: "Synthetic isolated SQLite and Codex event projection. OS disk counters exclude cached physical reads; timing and disk deltas are diagnostics, not fixed acceptance thresholds.",
        },
        null,
        2,
      ),
    );
  }
}

function diskSample() {
  if (process.platform !== "darwin")
    return {
      unavailable: `Disk sampling is unsupported on ${process.platform}; macOS proc_pid_rusage is required`,
    };
  try {
    return JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          "import ctypes,json,struct,sys\n" +
            "lib=ctypes.CDLL('/usr/lib/libproc.dylib')\n" +
            "buf=ctypes.create_string_buffer(1024)\n" +
            "assert lib.proc_pid_rusage(int(sys.argv[1]),2,ctypes.byref(buf)) == 0\n" +
            "v=struct.unpack_from('18Q',buf,16)\n" +
            "print(json.dumps({'read':v[16],'write':v[17]}))",
          String(process.pid),
        ],
        { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
  } catch (error) {
    return {
      unavailable: `macOS disk sampling failed (${error.code ?? error.status ?? "unknown"}); python3 and proc_pid_rusage are required`,
    };
  }
}

async function sample(run) {
  const before = diskSample();
  const cpu = process.cpuUsage();
  const start = performance.now();
  await run();
  const elapsedMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  const after = diskSample();
  const unavailable = before.unavailable ?? after.unavailable;
  return {
    elapsedMs,
    cpuMs: (used.user + used.system) / 1_000,
    diskReadBytes: unavailable ? null : after.read - before.read,
    diskWriteBytes: unavailable ? null : after.write - before.write,
    diskSampling: unavailable ?? "macOS proc_pid_rusage RUSAGE_INFO_V2",
  };
}
