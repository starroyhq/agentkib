import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";

const bundle = path.resolve(process.argv[2] ?? "apps/desktop/dist-electron");
for (const filename of [
  "backend.cjs",
  "backend-insights.cjs",
  "backend-skills.cjs",
  "backend-handoff-read.cjs",
  "backend-history-search.cjs",
  "backend-antigravity-history.cjs",
]) {
  const metadata = await stat(path.join(bundle, filename));
  assert(metadata.isFile() && metadata.size > 0, `Missing built backend entry: ${filename}`);
}

// Resolve the shipped native package directly. A workspace node_modules fallback
// would hide missing or incompatible native resources in the build output.
const nativePackage = path.join(bundle, "native", "koffi");
assert((await stat(path.join(nativePackage, "package.json"))).isFile());
const worker = new Worker(
  `const { parentPort, workerData } = require("node:worker_threads");
   const { DatabaseSync } = require('node:sqlite');
   const db = new DatabaseSync(':memory:');
   db.exec("CREATE VIRTUAL TABLE documents USING fts5(body, tokenize='trigram');");
   db.prepare('INSERT INTO documents(body) VALUES(?)').run('Unicode 中文正文 /src/main.ts');
   if (db.prepare('SELECT count(*) AS n FROM documents WHERE documents MATCH ?').get('"中文正文"').n !== 1)
     throw new Error('SQLite FTS5 trigram unavailable');
   db.close();
   const koffi = require(workerData.nativePackage);
   const library = koffi.load(process.platform === "win32" ? "kernel32.dll" :
     process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6");
   const getPid = process.platform === "win32"
     ? library.func("__stdcall", "GetCurrentProcessId", "uint", [])
     : library.func("int getpid(void)");
   parentPort.postMessage({ pid: getPid(), platform: process.platform, arch: process.arch });`,
  { eval: true, workerData: { nativePackage } },
);
let timeout;
try {
  const result = await new Promise((resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error("Staged native worker smoke test timed out")),
      10_000,
    );
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) =>
      reject(new Error(`Native worker exited before replying (${code})`)),
    );
  });
  assert.equal(result.pid, process.pid, "Staged Koffi must call the native API from a Worker");
  assert.equal(result.platform, process.platform);
  assert.equal(result.arch, process.arch);
  console.log(
    `Backend entries and staged Koffi Worker smoke passed (${result.platform}/${result.arch}).`,
  );
} finally {
  clearTimeout(timeout);
  await worker.terminate();
}
