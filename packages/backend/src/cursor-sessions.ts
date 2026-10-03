import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync, opendirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { userHome } from "./mcp-config-read";
import { isReparseOrSymlink } from "./native-files";
import { belongsToWorkspace, stableNativeRef } from "./session-history";
import { sessionTitle } from "./codex-sessions";
import type { NativeSession } from "./session-store";
import type { ConversationEventPage } from "./session-events";
import { MAX_MESSAGE_BYTES, MAX_PAGE_BYTES } from "./session-events";
import { sessionTurn, type SessionDocument } from "./session-model";
import { finishDocument } from "./session-document-providers";
type SessionTurn = import("zod").infer<typeof sessionTurn>;

const MAX_BLOB = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_STORES = 2_000;
const MAX_ENTRIES = 20_000;
type Field = { number: number; wire: number; data: Buffer };

function varint(bytes: Buffer, offset: { value: number }): bigint {
  let result = 0n;
  for (let shift = 0n; shift < 70n; shift += 7n) {
    if (offset.value >= bytes.length) throw new Error("Truncated Cursor protobuf integer");
    const byte = bytes[offset.value++]!;
    if (shift === 63n && byte > 1) throw new Error("Overflowed Cursor protobuf integer");
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result;
  }
  throw new Error("Overflowed Cursor protobuf integer");
}

function fields(bytes: Buffer): Field[] {
  const result: Field[] = [];
  const offset = { value: 0 };
  while (offset.value < bytes.length) {
    if (result.length >= 100_000) throw new Error("Cursor protobuf field limit exceeded");
    const tagValue = varint(bytes, offset);
    if (tagValue > 0xffff_ffffn) throw new Error("Invalid Cursor protobuf tag");
    const tag = Number(tagValue);
    const number = tag >>> 3;
    const wire = tag & 7;
    if (!number || number >= 1 << 29) throw new Error("Invalid Cursor protobuf field number");
    if (wire === 0) {
      const start = offset.value;
      varint(bytes, offset);
      result.push({ number, wire, data: bytes.subarray(start, offset.value) });
      continue;
    }
    const length =
      wire === 1 ? 8 : wire === 5 ? 4 : wire === 2 ? Number(varint(bytes, offset)) : -1;
    if (length < 0 || !Number.isSafeInteger(length) || offset.value + length > bytes.length)
      throw new Error("Unsupported or truncated Cursor protobuf field");
    result.push({ number, wire, data: bytes.subarray(offset.value, offset.value + length) });
    offset.value += length;
  }
  return result;
}

function bytesField(items: Field[], number: number, required = false): Buffer | undefined {
  const found = items.filter((item) => item.number === number);
  if (found.length > 1 || (required && found.length !== 1))
    throw new Error("Invalid Cursor protobuf field cardinality");
  if (!found.length) return undefined;
  if (found[0]!.wire !== 2) throw new Error("Unexpected Cursor protobuf wire type");
  return found[0]!.data;
}

function textField(items: Field[], number: number): string | undefined {
  const value = bytesField(items, number);
  return value === undefined ? undefined : new TextDecoder("utf-8", { fatal: true }).decode(value);
}

function timestamp(items: Field[], number: number): string | undefined {
  const found = items.find((item) => item.number === number);
  if (!found) return undefined;
  if (found.wire !== 0) throw new Error("Unexpected Cursor timestamp wire type");
  const value = Number(varint(found.data, { value: 0 }));
  if (!Number.isSafeInteger(value)) throw new Error("Invalid Cursor timestamp");
  return new Date(value).toISOString();
}

function createdAt(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeDb(file: string): DatabaseSync {
  let parent = file;
  for (let depth = 0; depth < 5; depth++) {
    const stat = lstatSync(parent);
    if (isReparseOrSymlink(parent, stat)) throw new Error("Unsafe Cursor store path");
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || isReparseOrSymlink(file, stat))
    throw new Error("Cursor store is not a regular file");
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = file + suffix;
    if (!existsSync(sidecar)) continue;
    const side = lstatSync(sidecar);
    if (!side.isFile() || isReparseOrSymlink(sidecar, side))
      throw new Error("Unsafe Cursor SQLite sidecar");
  }
  const db = new DatabaseSync(file, { readOnly: true, timeout: 100 });
  db.exec("PRAGMA query_only=ON;");
  db.exec("BEGIN DEFERRED");
  if (db.prepare("PRAGMA user_version").get()?.user_version !== 1) {
    db.close();
    throw new Error("Unsupported Cursor CLI database version");
  }
  return db;
}

class CursorStore {
  readonly db: DatabaseSync;
  readonly root: Buffer;
  readonly rootId: string;
  readBytes = 0;
  constructor(file: string) {
    this.db = safeDb(file);
    try {
      const raw = this.db.prepare("SELECT value FROM meta WHERE key='0'").get()?.value;
      if (typeof raw !== "string" || raw.length > 131_072 || !/^(?:[a-f0-9]{2})+$/i.test(raw))
        throw new Error("Invalid Cursor metadata");
      const metadata = JSON.parse(Buffer.from(raw, "hex").toString("utf8")) as {
        latestRootBlobId?: unknown;
      };
      if (
        typeof metadata.latestRootBlobId !== "string" ||
        !/^[a-f0-9]{64}$/i.test(metadata.latestRootBlobId)
      )
        throw new Error("Cursor root identity is absent");
      this.rootId = metadata.latestRootBlobId;
      this.root = this.blob(Buffer.from(this.rootId, "hex"));
      this.workspaces();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  blob(reference: Buffer): Buffer {
    if (reference.length !== 32) throw new Error("Unsupported Cursor blob identity");
    const id = reference.toString("hex");
    const row = this.db.prepare("SELECT data FROM blobs WHERE id=?").get(id);
    if (!row || !(row.data instanceof Uint8Array) || row.data.length > MAX_BLOB)
      throw new Error("Cursor blob exceeds read limit");
    const data = Buffer.from(row.data);
    this.readBytes += data.length;
    if (
      this.readBytes > MAX_TOTAL_BYTES ||
      !createHash("sha256").update(data).digest().equals(reference)
    )
      throw new Error("Cursor history size or blob hash is invalid");
    return data;
  }
  workspaces(): string[] {
    const paths = fields(this.root)
      .filter((field) => field.number === 9)
      .map((field) => {
        if (field.wire !== 2) throw new Error("Invalid Cursor workspace URI");
        const uri = new URL(field.data.toString("utf8"));
        if (uri.protocol !== "file:") throw new Error("Cursor workspace URI is unsupported");
        return fileURLToPath(uri);
      });
    if (!paths.length || paths.some((value) => !path.isAbsolute(value)))
      throw new Error("Cursor history lacks verified workspace ownership");
    return paths;
  }
  turns(): {
    turns: SessionTurn[];
    losses: Map<"source-content-truncated" | "reasoning-excluded", number>;
  } {
    const root = fields(this.root);
    if (root.some((field) => [2, 6, 11, 13].includes(field.number)))
      throw new Error("Cursor legacy or compacted history is unsupported");
    const refs = root.filter((field) => field.number === 8);
    const turns: SessionTurn[] = [];
    const losses = new Map<"source-content-truncated" | "reasoning-excluded", number>();
    const loss = (code: "source-content-truncated" | "reasoning-excluded") =>
      losses.set(code, (losses.get(code) ?? 0) + 1);
    for (const ref of refs) {
      const variant = fields(this.blob(ref.data));
      if (variant.length !== 1) throw new Error("Unknown Cursor conversation turn variant");
      if (variant[0]!.number === 2) {
        loss("source-content-truncated");
        continue;
      }
      if (variant[0]!.number !== 1) throw new Error("Unknown Cursor conversation turn type");
      const agent = fields(variant[0]!.data);
      const user = fields(this.blob(bytesField(agent, 1, true)!));
      const simulated = user.find((field) => field.number === 5);
      const isSimulated = simulated ? Number(varint(simulated.data, { value: 0 })) !== 0 : false;
      if (!isSimulated) {
        let text = textField(user, 1) ?? "";
        const hydrated = bytesField(user, 18);
        if (hydrated) {
          const full = new TextDecoder("utf-8", { fatal: true }).decode(this.blob(hydrated));
          if (text && text !== full) throw new Error("Cursor user text representations disagree");
          text = full;
        }
        if (!text) throw new Error("Cursor user message has no supported text");
        if (user.some((field) => field.number === 3)) loss("source-content-truncated");
        turns.push({
          id: `cursor-${turns.length}`,
          role: "user",
          timestamp: timestamp(user, 25) ?? null,
          blocks: [{ type: "text", text }],
        });
      }
      for (const step of agent.filter((field) => field.number === 2)) {
        const part = fields(this.blob(step.data));
        if (part.length !== 1) throw new Error("Unknown Cursor conversation step variant");
        if (part[0]!.number === 1) {
          const message = fields(part[0]!.data);
          const text = textField(message, 1);
          if (text)
            turns.push({
              id: `cursor-${turns.length}`,
              role: "assistant",
              timestamp: timestamp(message, 2) ?? null,
              blocks: [{ type: "text", text }],
            });
        } else if (part[0]!.number === 2) loss("source-content-truncated");
        else if (part[0]!.number === 3) loss("reasoning-excluded");
        else throw new Error("Unknown Cursor conversation step type");
      }
    }
    if (!turns.length) throw new Error("Cursor history has no supported original messages");
    return { turns, losses };
  }
}

export class CursorSessions {
  constructor(readonly environment: NodeJS.ProcessEnv) {}
  root() {
    const configured = this.environment.CURSOR_CONFIG_DIR;
    if (configured?.trim()) return configured;
    const xdg = this.environment.XDG_CONFIG_HOME;
    return xdg?.trim()
      ? path.join(xdg, "cursor")
      : path.join(userHome(this.environment), ".cursor");
  }
  list(workspace: string): { sessions: NativeSession[]; incomplete: boolean } {
    const config = this.root(),
      chats = path.join(config, "chats");
    if (!existsSync(chats)) return { sessions: [], incomplete: false };
    const found: NativeSession[] = [];
    let incomplete = false,
      visited = 0,
      inspected = 0;
    try {
      for (const directory of [config, chats]) {
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || isReparseOrSymlink(directory, stat))
          throw new Error("Unsafe Cursor chats directory");
      }
    } catch {
      return { sessions: [], incomplete: true };
    }
    const walk = (dir: string, depth: number) => {
      if (depth > 3) return;
      let handle;
      try {
        handle = opendirSync(dir);
      } catch {
        incomplete = true;
        return;
      }
      try {
        for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
          if (++visited > MAX_ENTRIES || inspected >= MAX_STORES) {
            incomplete = true;
            return;
          }
          const file = path.join(dir, entry.name);
          try {
            const stat = lstatSync(file);
            if (isReparseOrSymlink(file, stat)) continue;
            if (stat.isDirectory() && depth < 3) walk(file, depth + 1);
            else if (depth === 2 && entry.name === "store.db" && stat.isFile()) {
              inspected++;
              const store = new CursorStore(file);
              try {
                if (
                  !store
                    .workspaces()
                    .some((cwd) => belongsToWorkspace(cwd, workspace, userHome(this.environment)))
                )
                  continue;
                const metadata = JSON.parse(
                  Buffer.from(
                    String(
                      store.db.prepare("SELECT value FROM meta WHERE key='0'").get()?.value ?? "",
                    ),
                    "hex",
                  ).toString("utf8"),
                );
                const statFile = lstatSync(file);
                found.push({
                  native_ref: stableNativeRef("cursor-cli", [config, path.relative(chats, file)]),
                  agent: "cursor",
                  title: sessionTitle(typeof metadata.name === "string" ? metadata.name : null),
                  created_at: createdAt(metadata.createdAt),
                  updated_at: statFile.mtime.toISOString(),
                  message_count: null,
                  git_branch: null,
                  archived: false,
                  sidechain: false,
                  availability: "readable",
                  origin: "interactive",
                });
              } finally {
                store.close();
              }
            }
          } catch {
            incomplete = true;
          }
        }
      } finally {
        handle.closeSync();
      }
    };
    walk(chats, 0);
    found.sort(
      (a, b) =>
        (b.updated_at ?? "").localeCompare(a.updated_at ?? "") ||
        a.native_ref.localeCompare(b.native_ref),
    );
    return { sessions: found, incomplete };
  }
  resolve(nativeRef: string): { file: string; store: CursorStore } {
    const config = this.root();
    const chats = path.join(config, "chats");
    for (const directory of [config, chats]) {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || isReparseOrSymlink(directory, stat))
        throw new Error("Unsafe Cursor chats directory");
    }
    const stack = [{ directory: chats, depth: 0 }];
    let visited = 0;
    while (stack.length) {
      const { directory: dir, depth } = stack.pop()!;
      let handle;
      try {
        handle = opendirSync(dir);
      } catch {
        continue;
      }
      try {
        for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
          if (++visited > MAX_ENTRIES) throw new Error("Cursor discovery limit exceeded");
          const file = path.join(dir, entry.name);
          const stat = lstatSync(file);
          if (isReparseOrSymlink(file, stat)) continue;
          if (stat.isDirectory() && depth < 3) stack.push({ directory: file, depth: depth + 1 });
          else if (
            entry.name === "store.db" &&
            stat.isFile() &&
            stableNativeRef("cursor-cli", [config, path.relative(chats, file)]) === nativeRef
          ) {
            const store = new CursorStore(file);
            return { file, store };
          }
        }
      } finally {
        handle.closeSync();
      }
    }
    throw new Error("Cursor CLI session is unavailable");
  }
  document(native: NativeSession, workspaceId: string, workspace: string): SessionDocument {
    const { store } = this.resolve(native.native_ref);
    try {
      if (
        !store
          .workspaces()
          .some((cwd) => belongsToWorkspace(cwd, workspace, userHome(this.environment)))
      )
        throw new Error("Cursor workspace changed while reading history");
      const parsed = store.turns();
      return finishDocument(
        { ...native, workspace_id: workspaceId, agent: "cursor" },
        parsed.turns,
        parsed.losses,
      );
    } finally {
      store.close();
    }
  }
  events(nativeRef: string, cursor: string | null, limit: number): ConversationEventPage {
    const { store } = this.resolve(nativeRef);
    try {
      const { turns, losses } = store.turns();
      let offset = 0;
      if (cursor !== null) {
        const [root, rawOffset, extra] = cursor.split(":");
        if (
          root !== store.rootId ||
          rawOffset === undefined ||
          extra !== undefined ||
          !/^\d+$/.test(rawOffset)
        )
          throw new Error("Invalid Cursor history cursor");
        offset = Number(rawOffset);
      }
      if (offset > turns.length) throw new Error("Cursor history offset is out of range");
      let bytes = 0;
      const selected: SessionTurn[] = [];
      for (const turn of turns
        .slice(0, turns.length - offset)
        .reverse()
        .slice(0, Math.max(1, Math.min(200, limit)))) {
        const text = turn.blocks
          .filter((block) => block.type === "text")
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("\n");
        const size = Buffer.byteLength(text);
        if (selected.length > 0 && bytes + size > MAX_PAGE_BYTES) break;
        selected.push(turn);
        bytes += size;
      }
      const page = selected.reverse();
      const events = page.map((turn) => {
        const fullText = turn.blocks
          .filter((block) => block.type === "text")
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("\n");
        const raw = Buffer.from(fullText);
        let end = Math.min(raw.length, MAX_MESSAGE_BYTES);
        while (end > 0 && (raw[end]! & 0xc0) === 0x80) end--;
        return {
          id: turn.id,
          kind: turn.role === "user" ? ("user-message" as const) : ("agent-message" as const),
          timestamp: turn.timestamp ?? null,
          content: raw.subarray(0, end).toString("utf8"),
          tool_name: null,
          tool_status: null,
          duration_ms: null,
          attachment_count: 0,
          truncated: raw.length > end,
        };
      });
      const end = offset + events.length;
      return {
        events,
        next_cursor: end < turns.length ? `${store.rootId}:${end}` : null,
        warnings: [
          ...(losses.has("source-content-truncated")
            ? [
                "Cursor CLI tool and selected-context records are omitted from this text-only adapter",
              ]
            : []),
          ...(losses.has("reasoning-excluded") ? ["Cursor CLI reasoning is excluded"] : []),
        ],
      };
    } finally {
      store.close();
    }
  }
}
