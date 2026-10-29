// QA-only native OpenCode provider fetch guard. CPA custom-provider variant, not a production adapter.
// Kept separate from the reviewed immutable official-free experiment.
// A durable, exclusive token is consumed before the one permitted native fetch.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const CPA_ENDPOINT = "http://127.0.0.1:8317/v1/chat/completions";
export const CPA_MODEL = "relay/claude-opus-5-5";
const fail = (message) => { throw new Error(`AgentKib single-dispatch guard: ${message}`); };
const hash = (value) => createHash("sha256").update(value).digest("hex");

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.some((part) => part.type !== "text" || typeof part.text !== "string")) {
    return null;
  }
  return content.map((part) => part.text).join("\n");
}

export function makeGuard(contractFile, { offline = false, nativeFetch = globalThis.fetch } = {}) {
  if (!path.isAbsolute(contractFile)) fail("absolute contract required");
  const dir = path.dirname(contractFile);
  const parent = fs.lstatSync(dir);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) fail("private directory required");
  const stat = fs.lstatSync(contractFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) fail("invalid contract file");
  const raw = fs.readFileSync(contractFile);
  const contract = JSON.parse(raw);
  const contractHash = hash(raw);
  const endpoint = new URL(contract.endpoint);
  if (offline) {
    if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port || endpoint.pathname !== "/v1/chat/completions") {
      fail("offline fixture must use exact loopback endpoint");
    }
  } else if (contract.endpoint !== CPA_ENDPOINT || contract.model !== CPA_MODEL) {
    fail("explicit CPA endpoint and selected model required");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) fail("endpoint credentials or suffix forbidden");
  if (contract.model !== CPA_MODEL) fail("selected CPA model required");
  if (typeof contract.sessionId !== "string" || !contract.sessionId.startsWith("ses_")) fail("native session identity required");
  if (typeof contract.prompt !== "string" || !contract.prompt || !Array.isArray(contract.history) || contract.history.length < 2) fail("prompt and history required");
  if (contract.history.some((row) => !["user", "assistant"].includes(row.role) || typeof row.text !== "string" || !row.text)) fail("invalid reviewed history");
  function verifyRetryWindow() {
    if (offline) return;
    if (typeof contract.retryWindow !== "string" || !path.isAbsolute(contract.retryWindow)) fail("retry window proof required");
    const stat = fs.lstatSync(contract.retryWindow);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) fail("invalid retry window proof");
    const window = JSON.parse(fs.readFileSync(contract.retryWindow));
    const expected = {requestRetry: 0, maxRetryCredentials: 1, streamBootstrapRetries: 0,
      credentialOverrides: false, ccSwitchRectifierEnabled: false, ccSwitchAutoFailoverEnabled: false};
    if (window.schemaVersion !== 1 || window.status !== "open" || window.endpoint !== "http://127.0.0.1:8317"
        || window.model !== CPA_MODEL || !(Date.parse(window.expiresAt) > Date.now())) fail("retry window is not active");
    for (const [key, value] of Object.entries(expected)) {
      if (window.retryPolicy?.[key] !== value) fail("retry policy differs from reviewed single-attempt policy");
    }
  }
  verifyRetryWindow();
  const token = path.join(dir, "dispatch-token.json");
  const log = path.join(dir, "guard-events.jsonl");
  const record = (event) => fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", { mode: 0o600 });
  record({ event: "loaded", contractHash, offline });
  const guardedFetch = async function (input, init) {
    // A changed review contract never grants a new dispatch opportunity.
    if (hash(fs.readFileSync(contractFile)) !== contractHash) fail("contract changed");
    const request = new Request(input, init);
    if (request.url !== contract.endpoint || request.method !== "POST") fail("unreviewed endpoint or method");
    if (request.headers.has("x-opencode-client")) fail("custom provider must not use official free identity");
    if (request.headers.get("x-session-id") !== contract.sessionId || request.headers.get("x-session-affinity") !== contract.sessionId) fail("native session identity differs");
    const bodyText = await request.clone().text();
    const body = JSON.parse(bodyText);
    if (offline) fs.writeFileSync(path.join(dir, "offline-candidate.json"), bodyText, { mode: 0o600 });
    if (body.model !== contract.model || body.stream !== true || (body.tools && body.tools.length)) fail("unreviewed model, stream, or tools");
    if (!Array.isArray(body.messages)) fail("messages unavailable");
    const messages = body.messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role, text: textContent(message.content) }));
    if (messages.length !== contract.history.length + 1 || messages.at(-1).role !== "user" || messages.at(-1).text !== contract.prompt) fail("unreviewed user turn");
    if (JSON.stringify(messages.slice(0, -1)) !== JSON.stringify(contract.history)) fail("reviewed history changed");
    verifyRetryWindow();
    const requestHash = hash(bodyText);
    let fd;
    try {
      fd = fs.openSync(token, "wx", 0o600);
    } catch (error) {
      record({ event: "blocked", reason: error.code === "EEXIST" ? "token-consumed" : "token-unavailable", requestHash });
      fail("dispatch token unavailable");
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({ version: 1, contractHash, requestHash, sessionId: contract.sessionId, endpoint: contract.endpoint, model: contract.model, attemptedAt: new Date().toISOString() }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const directoryFd = fs.openSync(dir, "r");
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    // Persisted before any network call. Failures below leave the token consumed.
    record({ event: "dispatch", requestHash });
    fs.writeFileSync(path.join(dir, "reviewed-request.json"), bodyText, { mode: 0o600, flag: "wx" });
    // Native SDK URL, body and headers are retained. Redirect following is disabled
    // because even a same-origin 307 could otherwise issue a second POST.
    const response = await nativeFetch(request, { redirect: "error", timeout: false });
    record({ event: "response", status: response.status });
    return response;
  };
  Object.defineProperty(guardedFetch, "endpoint", { value: contract.endpoint });
  return guardedFetch;
}
