// Only loopback mock HTTP is used. No provider/model network request.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { makeGuard } from "./opencode-cpa-once-guard.mjs";

const root = path.resolve(process.argv[2]);
if (fs.existsSync(root)) throw new Error("Self-test directory must be new");
fs.mkdirSync(root, { mode: 0o700, recursive: true });
let mode = "500";
const requests = [];
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push({ mode, path: req.url, body, headers: req.headers });
  if (mode === "network") return req.socket.destroy();
  if (mode === "redirect") { res.writeHead(307, { location: "/second" }); return res.end(); }
  if (mode === "stream") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"partial":true}\n\n');
    return setImmediate(() => res.destroy());
  }
  if (mode === "ok") { res.writeHead(200); return res.end("ok"); }
  res.writeHead(Number(mode), { "content-type": "application/json", "retry-after": "0" });
  res.end(JSON.stringify({ error: { message: "fixture failure" } }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
const history = [{ role: "user", text: "marker M7, decision SQLite WAL" }, { role: "assistant", text: "Confirmed M7 and SQLite WAL" }];
const prompt = "Recall the previous marker and decision, without tools.";
const body = JSON.stringify({ model: "relay/claude-opus-5-5", stream: true, messages: history.map((row) => ({ role: row.role, content: row.text })).concat({ role: "user", content: prompt }) });
const options = { method: "POST", headers: { "content-type": "application/json", "x-original-client": "fixture", "x-session-id": "ses_mock", "x-session-affinity": "ses_mock" }, body };
const evidence = [];
function create(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { mode: 0o700 });
  const file = path.join(dir, "contract.json");
  fs.writeFileSync(file, JSON.stringify({ endpoint, model: "relay/claude-opus-5-5", sessionId: "ses_mock", history, prompt }));
  return file;
}
async function attempt(guard) {
  try { await (await guard(endpoint, options)).text(); } catch {}
}
try {
  for (const failure of ["500", "429", "redirect", "stream", "network"]) {
    mode = failure;
    const file = create(failure);
    const guard = makeGuard(file, { offline: true });
    const before = requests.length;
    await attempt(guard);
    await attempt(guard);
    // A newly created guard models a fresh official CLI/Runtime process.
    await attempt(makeGuard(file, { offline: true }));
    assert.equal(requests.length - before, 1, failure);
    assert.equal(requests.at(-1).path, "/v1/chat/completions");
    assert.equal(requests.at(-1).body, body);
    assert.equal(requests.at(-1).headers["x-original-client"], "fixture");
    evidence.push({ case: failure, outboundRequests: 1, secondAttemptBlocked: true, freshGuardBlocked: true });
  }
  mode = "ok";
  const parallelFile = create("multiprocess");
  const before = requests.length;
  const module = pathToFileURL(path.join(import.meta.dirname, "opencode-cpa-once-guard.mjs")).href;
  const childSource = `import {makeGuard} from ${JSON.stringify(module)}; const guard=makeGuard(process.argv[1],{offline:true});try {await (await guard(process.argv[2],JSON.parse(process.argv[3]))).text();}catch{}`;
  await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childSource, parallelFile, endpoint, JSON.stringify(options)], { stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exit ${code}`)));
  })));
  assert.equal(requests.length - before, 1);
  evidence.push({ case: "six-concurrent-processes", outboundRequests: 1 });
  const requestFile = create("request-object");
  const requestGuard = makeGuard(requestFile, { offline: true });
  const requestBefore = requests.length;
  assert.equal(await (await requestGuard(new Request(endpoint, options))).text(), "ok");
  await attempt(requestGuard);
  assert.equal(requests.length - requestBefore, 1);
  assert.equal(requests.at(-1).body, body);
  evidence.push({ case: "Request-input-body-preserved", outboundRequests: 1 });
  const invalid = create("invalid-contract");
  const blocked = makeGuard(invalid, { offline: true });
  fs.writeFileSync(invalid, "changed");
  await assert.rejects(blocked(endpoint, options), /contract changed/);
  const writeFailure = create("write-failure");
  fs.mkdirSync(path.join(path.dirname(writeFailure), "dispatch-token.json"));
  const count = requests.length;
  await attempt(makeGuard(writeFailure, { offline: true }));
  assert.equal(requests.length, count);
  evidence.push({ case: "changed-contract-and-unavailable-token", outboundRequests: 0 });
  fs.writeFileSync(path.join(root, "results.json"), JSON.stringify({ passed: true, cases: evidence, totalRequests: requests.length }, null, 2));
  console.log(JSON.stringify({ passed: true, cases: evidence, totalRequests: requests.length }));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
