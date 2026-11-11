import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, pathIdentity } from "./paths";
import type { ConversationEvent, ConversationEventPage } from "./session-events";
import { MAX_PAGE_BYTES, truncateUtf8 } from "./session-events";
import type { AntigravityLocalRecord } from "./antigravity-local-store";
import { timestamp } from "./timestamps";

const MAX_RESPONSE = 32 * 1024 * 1024;
const ROOTS = { app: "antigravity", ide: "antigravity-ide" } as const;
type Endpoint = { pid: number; port: number; csrf: string };
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Only the already running native daemon is used. Never starts or resumes an agent. */
export class AntigravityLocalRuntime {
  constructor(readonly env: NodeJS.ProcessEnv) {}
  #endpoint(surface: "app" | "ide"): Endpoint | null {
    const home = this.env.HOME ?? this.env.USERPROFILE ?? homedir();
    const root = path.join(home, ".gemini", ROOTS[surface]);
    const daemon = path.join(root, "daemon");
    for (const directory of [path.join(home, ".gemini"), root, daemon]) {
      try {
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new Error("Antigravity runtime metadata is unavailable");
      }
    }
    const entries = readdirSync(daemon).filter((name) => /^ls_[a-zA-Z0-9_-]+\.json$/.test(name));
    if (entries.length > 32) throw new Error("Antigravity runtime metadata exceeds limit");
    const live: Endpoint[] = [];
    for (const name of entries) {
      let fd: number | undefined;
      try {
        fd = openSync(path.join(daemon, name), constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = fstatSync(fd);
        if (
          !stat.isFile() ||
          stat.size > 16_384 ||
          (process.getuid && stat.uid !== process.getuid())
        )
          throw new Error("Invalid Antigravity daemon metadata");
        const data = object(JSON.parse(readFileSync(fd, "utf8")));
        if (
          !Number.isSafeInteger(data.pid) ||
          Number(data.pid) <= 0 ||
          !Number.isSafeInteger(data.httpPort) ||
          Number(data.httpPort) < 1 ||
          Number(data.httpPort) > 65535 ||
          typeof data.csrfToken !== "string" ||
          !/^[\x21-\x7e]{1,1024}$/.test(data.csrfToken)
        )
          continue;
        try {
          process.kill(Number(data.pid), 0);
        } catch {
          continue;
        }
        live.push({ pid: Number(data.pid), port: Number(data.httpPort), csrf: data.csrfToken });
      } catch (error) {
        if (!["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw new Error("Antigravity runtime metadata is invalid");
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    // Do not guess between different authenticated daemons for the same store.
    return live.length === 1 ? live[0]! : null;
  }
  available(surface: "app" | "ide"): boolean {
    return this.#endpoint(surface) !== null;
  }

  #listCache = new Map<string, { at: number; rows: Promise<AntigravityLocalRecord[]> }>();
  async list(surface: "app" | "ide"): Promise<AntigravityLocalRecord[]> {
    const endpoint = this.#endpoint(surface);
    if (!endpoint) return [];
    const key = `${surface}:${endpoint.pid}:${endpoint.port}:${createHash("sha256").update(endpoint.csrf).digest("hex")}`;
    const cached = this.#listCache.get(key);
    if (cached && Date.now() - cached.at < 1_000) return cached.rows;
    const rows = this.#request(surface, endpoint, "GetAllCascadeTrajectories", {}).then((value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid Antigravity native catalog");
      const data = object(value);
      if (
        Object.keys(data).length &&
        (data.trajectorySummaries === null ||
          typeof data.trajectorySummaries !== "object" ||
          Array.isArray(data.trajectorySummaries))
      )
        throw new Error("Invalid Antigravity native catalog");
      const summaries = object(data.trajectorySummaries);
      if (Object.keys(summaries).length > 10_000)
        throw new Error("Antigravity native catalog exceeds limit");
      const result: AntigravityLocalRecord[] = [];
      for (const [id, raw] of Object.entries(summaries)) {
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))
          throw new Error("Invalid Antigravity native catalog identity");
        const summary = object(raw);
        if (!Array.isArray(summary.workspaces) || summary.workspaces.length > 128) continue;
        for (const item of summary.workspaces) {
          const uri = object(item).workspaceFolderAbsoluteUri;
          if (typeof uri !== "string") continue;
          const url = new URL(uri);
          if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) continue;
          let workspace: string;
          try {
            workspace = canonicalize(fileURLToPath(url));
          } catch {
            continue;
          }
          if (result.length >= 10_000) throw new Error("Antigravity native catalog exceeds limit");
          result.push({
            surface,
            id: id.toLowerCase(),
            workspace,
            title: typeof summary.summary === "string" ? summary.summary.slice(0, 512) : null,
            created_at: null,
            updated_at:
              typeof summary.lastModifiedTime === "string" &&
              timestamp(summary.lastModifiedTime) !== null
                ? summary.lastModifiedTime
                : null,
            message_count: null,
            availability: "readable",
          });
        }
      }
      return result;
    });
    if (this.#listCache.size >= 4) this.#listCache.clear();
    this.#listCache.set(key, { at: Date.now(), rows });
    try {
      return await rows;
    } catch (error) {
      this.#listCache.delete(key);
      throw error;
    }
  }
  async events(
    record: AntigravityLocalRecord,
    cursor: string | null,
    limit: number,
  ): Promise<ConversationEventPage | null> {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(record.id) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error("Invalid Antigravity history request");
    const endpoint = this.#endpoint(record.surface);
    if (!endpoint) return null;
    const verifyWorkspace = async () => {
      const known = (await this.list(record.surface)).filter((row) => row.id === record.id);
      if (
        known.length &&
        !known.some((row) => pathIdentity(row.workspace) === pathIdentity(record.workspace))
      )
        throw new Error("Antigravity native session workspace changed");
    };
    await verifyWorkspace();
    const value = await this.#request(record.surface, endpoint, "GetCascadeTrajectorySteps", {
      cascadeId: record.id,
      stepOffset: 0,
      trajectoryVerbosity: 2,
    });
    this.#listCache.clear();
    await verifyWorkspace();
    return antigravityNativePage(
      value,
      record.id,
      cursor,
      limit,
      [record.surface, pathIdentity(record.workspace), endpoint.pid, endpoint.port].join("\0"),
    );
  }
  async #request(
    surface: "app" | "ide",
    endpoint: Endpoint,
    method: "GetAllCascadeTrajectories" | "GetCascadeTrajectorySteps",
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const payload = JSON.stringify(body);
      const raw = await new Promise<Buffer>((resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port: endpoint.port,
            path: `/exa.language_server_pb.LanguageServerService/${method}`,
            method: "POST",
            // Use a direct connection so the native credential never reaches a global proxy.
            agent: false,
            signal: controller.signal,
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
              "x-codeium-csrf-token": endpoint.csrf,
            },
          },
          (response) => {
            response.on("error", reject);
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              response.destroy(new Error("Antigravity native history is unavailable"));
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > MAX_RESPONSE) {
                response.destroy(new Error("Antigravity native history exceeds limit"));
                return;
              }
              chunks.push(chunk);
            });
            response.on("end", () => resolve(Buffer.concat(chunks, bytes)));
          },
        );
        req.on("error", reject);
        req.end(payload);
      });
      const current = this.#endpoint(surface);
      if (
        !current ||
        current.pid !== endpoint.pid ||
        current.port !== endpoint.port ||
        current.csrf !== endpoint.csrf
      )
        throw new Error("Antigravity runtime changed while reading history");
      return JSON.parse(raw.toString("utf8"));
    } catch {
      // Never include native response bodies or the CSRF credential in errors or logs.
      throw new Error("Antigravity native history could not be read");
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Parse only verified user-visible fields; never expose planner thinking or execute tool records. */
export function antigravityNativePage(
  value: unknown,
  id: string,
  cursor: string | null,
  limit: number,
  scope = id,
): ConversationEventPage {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Antigravity native history");
  const data = object(value);
  if (!Object.keys(data).length) data.steps = [];
  if (!Array.isArray(data.steps) || data.steps.length > 100_000)
    throw new Error("Invalid Antigravity native history");
  const events: ConversationEvent[] = [];
  for (const [index, raw] of data.steps.entries()) {
    const step = object(raw),
      metadata = object(step.metadata);
    const identity = object(metadata.sourceTrajectoryStepInfo);
    if (typeof identity.cascadeId === "string" && identity.cascadeId !== id)
      throw new Error("Antigravity native history identity mismatch");
    let kind: ConversationEvent["kind"] | undefined;
    let text: string | undefined;
    if (step.type === "CORTEX_STEP_TYPE_USER_INPUT") {
      kind = "user-message";
      const input = object(step.userInput);
      if (typeof input.userResponse === "string") text = input.userResponse;
    } else if (step.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE") {
      kind = "agent-message";
      const reply = object(step.plannerResponse);
      if (typeof reply.modifiedResponse === "string" && reply.modifiedResponse.trim())
        text = reply.modifiedResponse;
      else if (typeof reply.response === "string") text = reply.response;
    }
    if (!kind || !text?.trim()) continue;
    const time =
      typeof metadata.createdAt === "string" && timestamp(metadata.createdAt) !== null
        ? metadata.createdAt
        : null;
    events.push({
      id: `antigravity-native-${id}-${index}`,
      kind,
      timestamp: time,
      ...truncateUtf8(text),
      tool_name: null,
      tool_status: null,
      duration_ms: null,
      attachment_count: 0,
    });
  }
  const revision = createHash("sha256")
    .update(scope)
    .update("\0")
    .update(JSON.stringify(events))
    .digest("hex")
    .slice(0, 24);
  let end = events.length;
  if (cursor !== null) {
    const match = /^antigravity-local-native-v1-([a-f0-9]{24})-(\d+)$/.exec(cursor);
    if (
      !match ||
      match[1] !== revision ||
      !Number.isSafeInteger(Number(match[2])) ||
      Number(match[2]) > end
    )
      throw new Error("Invalid Antigravity native history cursor");
    end = Number(match[2]);
  }
  let start = end,
    bytes = 0;
  while (start > 0 && end - start < limit) {
    const size = Buffer.byteLength(JSON.stringify(events[start - 1]));
    if (bytes + size > MAX_PAGE_BYTES) break;
    bytes += size;
    start--;
  }
  return {
    events: events.slice(start, end),
    next_cursor: start ? `antigravity-local-native-v1-${revision}-${start}` : null,
    warnings: ["history.warning.partial"],
  };
}
