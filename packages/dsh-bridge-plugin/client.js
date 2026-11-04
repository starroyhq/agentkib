// Transport to AgentKib: per-user discovery files and HTTP over a private Unix socket.
import { readFile, lstat } from "node:fs/promises";
import { request } from "node:http";
import { homedir } from "node:os";
import path from "node:path";

export const DISCOVERY_FILE = path.join("dsh-bridge", "discovery-v1.json");
const MAX_RESPONSE = 4 * 1024 * 1024;

/** Production first, then the development app; the same lookup order as the Claude plugin. */
export function discoveryRoots(env = process.env, home = homedir()) {
  const roots = [];
  if (env.AGENTKIB_HOME && path.isAbsolute(env.AGENTKIB_HOME)) roots.push(env.AGENTKIB_HOME);
  if (home && path.isAbsolute(home))
    roots.push(path.join(home, ".agentkib"), path.join(home, ".agentkib-dev"));
  return [...new Set(roots)];
}

export function safeSocket(value) {
  return (
    typeof value === "string" &&
    path.isAbsolute(value) &&
    path.normalize(value) === value &&
    Buffer.byteLength(value) < 104 &&
    value.endsWith(".sock")
  );
}

/** Missing, unreadable, foreign or malformed discovery files mean that AgentKib is not available there. */
export async function discover(roots = discoveryRoots()) {
  const found = [];
  for (const root of roots) {
    const file = path.join(root, DISCOVERY_FILE);
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.size > 4096) continue;
      if (process.getuid && stat.uid !== process.getuid()) continue;
      const value = JSON.parse(await readFile(file, "utf8"));
      if (
        value?.protocol === 1 &&
        safeSocket(value.socketPath) &&
        typeof value.key === "string" &&
        /^[a-f0-9]{64}$/.test(value.key) &&
        !found.some((item) => item.socketPath === value.socketPath)
      )
        found.push({ socketPath: value.socketPath, key: value.key });
    } catch {
      // Not available in this root.
    }
  }
  return found;
}

export class BridgeHttpError extends Error {
  constructor(status, code) {
    super(code || `http-${status}`);
    this.status = status;
    this.code = code;
  }
}

/** One JSON POST; rejects on transport errors, non-2xx replies and oversized bodies. */
export function post(socketPath, route, body, { timeoutMs = 10_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const call = request(
      {
        socketPath,
        path: route,
        method: "POST",
        headers: {
          host: "localhost",
          "content-type": "application/json",
          "content-length": payload.length,
        },
        signal,
        timeout: timeoutMs,
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE) {
            response.destroy();
            reject(new BridgeHttpError(413, "bridge-response-too-large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          let value = null;
          try {
            value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
          } catch {
            reject(new BridgeHttpError(response.statusCode ?? 0, "bridge-invalid-response"));
            return;
          }
          if ((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300) resolve(value);
          else reject(new BridgeHttpError(response.statusCode ?? 0, value?.error));
        });
        response.on("error", reject);
      },
    );
    call.on("timeout", () => call.destroy(new BridgeHttpError(0, "bridge-timeout")));
    call.on("error", reject);
    call.end(payload);
  });
}
