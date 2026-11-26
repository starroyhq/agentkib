import { chmodSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * A stand-in Devin CLI for tests. `devin auth status` and `devin models list` answer as the
 * options say; `devin acp` speaks the part of ACP AgentKib uses. Each turn behaves as the files
 * beside the script say (see `turn`), and every call is appended to `calls.log`:
 * `new <id>`, `load <id>`, `mcp <name> <url>`, `config <id>=<value>`, `prompt <text>`,
 * `permission <optionId|cancelled>`, `cancel`.
 */
export function fakeDevinAcp(
  root: string,
  {
    loggedIn = true,
    models = null as unknown,
    sessionId = "fresh-otter",
    authError = null as string | null,
    strictConfig = false,
  } = {},
) {
  const file = path.join(root, "devin");
  const log = path.join(root, "calls.log");
  writeFileSync(
    file,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const dir = ${JSON.stringify(root)};
const log = (line) => fs.appendFileSync(${JSON.stringify(log)}, line + "\\n");
const read = (name) => { try { return fs.readFileSync(path.join(dir, name), "utf8"); } catch { return null; } };
const args = process.argv.slice(2);
if (args[0] === "auth") { console.log(${JSON.stringify(loggedIn ? "Logged in as tester" : "Not logged in.")}); process.exit(0); }
if (args[0] === "models") { const value = ${JSON.stringify(JSON.stringify(models))}; if (value === "null") process.exit(1); console.log(value); process.exit(0); }
if (args[0] !== "acp") process.exit(2);
const config = { mode: "accept-edits", model: "swe-2-high", thought_level: "high", speed: "standard" };
const allowed = ${strictConfig} ? {
  mode: ["ask", "accept-edits", "smart", "dangerous"],
  model: ["swe-2-high"],
  thought_level: ["high", "max"],
  speed: ["standard"],
} : null;
const options = () => Object.entries(config).map(([id, currentValue]) => ({
  id, type: "select", currentValue, options: (allowed?.[id] ?? []).map((value) => ({ value, name: value })),
}));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let prompt = null, permission = null, nextId = 1000;
function finish(result) { if (!prompt) return; const id = prompt.id; prompt = null; clearTimeout(finish.timer); send({ jsonrpc: "2.0", id, ...result }); }
function answer(session, text) {
  const hook = path.join(dir, "turn-hook");
  if (fs.existsSync(hook)) execFileSync(hook, [session, text], { stdio: "ignore" });
  const error = read("turn-error");
  if (error !== null) return finish({ error: { code: Number(read("turn-error-code") ?? -32603), message: error } });
  finish({ result: { stopReason: read("turn-stop-reason") ?? "end_turn" } });
}
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const { id, method, params = {} } = message;
  if (method === undefined) {
    if (permission && id === permission.id) {
      const outcome = message.result?.outcome;
      log("permission " + (outcome?.outcome === "selected" ? outcome.optionId : "cancelled"));
      const session = permission.session, text = permission.text; permission = null;
      answer(session, text);
    }
    return;
  }
  if (method === "initialize") return send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: true } }, authMethods: [] } });
  if (method === "session/new" || method === "session/load") {
    const auth = ${JSON.stringify(authError)};
    if (auth) return send({ jsonrpc: "2.0", id, error: { code: -32000, message: auth } });
    for (const server of params.mcpServers ?? []) log("mcp " + server.name + " " + server.url);
    const session = method === "session/new" ? ${JSON.stringify(sessionId)} : params.sessionId;
    log((method === "session/new" ? "new " : "load ") + session);
    return send({ jsonrpc: "2.0", id, result: { ...(method === "session/new" ? { sessionId: session } : {}), configOptions: options() } });
  }
  if (method === "session/set_config_option") {
    if (allowed && !allowed[params.configId]?.includes(params.value)) {
      log("config rejected " + params.configId + "=" + params.value);
      return send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params" } });
    }
    config[params.configId] = params.value;
    log("config " + params.configId + "=" + params.value);
    return send({ jsonrpc: "2.0", id, result: { configOptions: options() } });
  }
  if (method === "session/cancel") { log("cancel"); return finish({ result: { stopReason: "cancelled" } }); }
  if (method === "session/prompt") {
    const text = (params.prompt ?? []).map((block) => block.text ?? "").join("");
    log("prompt " + text);
    prompt = { id };
    for (const update of JSON.parse(read("turn-updates") ?? "[]"))
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update } });
    const ask = read("turn-permission");
    if (ask !== null) {
      permission = { id: nextId++, session: params.sessionId, text };
      return send({ jsonrpc: "2.0", id: permission.id, method: "session/request_permission", params: { sessionId: params.sessionId, ...JSON.parse(ask) } });
    }
    const wait = Number(read("turn-sleep") ?? 0);
    if (wait) finish.timer = setTimeout(() => answer(params.sessionId, text), wait * 1000).unref();
    else answer(params.sessionId, text);
    return;
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
});
`,
  );
  chmodSync(file, 0o755);
  return {
    file,
    log,
    /** How the next turns end: after `sleep` seconds, with `error`, or asking `permission`. */
    turn({
      sleep = 0,
      error = null as string | null,
      errorCode = null as number | null,
      stopReason = null as string | null,
      permission = null as Record<string, unknown> | null,
      hook = null as string | null,
      updates = [] as Array<Record<string, unknown>>,
    } = {}) {
      for (const [name, value] of Object.entries({
        "turn-sleep": sleep ? String(sleep) : null,
        "turn-error": error,
        "turn-error-code": errorCode === null ? null : String(errorCode),
        "turn-stop-reason": stopReason,
        "turn-permission": permission ? JSON.stringify(permission) : null,
        "turn-hook": hook,
        "turn-updates": updates.length ? JSON.stringify(updates) : null,
      })) {
        const target = path.join(root, name);
        if (value === null) rmSync(target, { force: true });
        else {
          writeFileSync(target, value);
          if (name === "turn-hook") chmodSync(target, 0o755);
        }
      }
    },
  };
}
