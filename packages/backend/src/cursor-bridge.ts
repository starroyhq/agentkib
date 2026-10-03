import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import type { BackendStore } from "./store";

const SUPPORTED_VERSIONS = ["3.22.12", "3.23.12"] as const;
const cursorVersion = z.enum(SUPPORTED_VERSIONS);
const EXTENSION_VERSION = "0.1.0";
const MAX_FRAME = 128 * 1024 * 1024;
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const uuid = z.string().uuid();
const contextSchema = z
  .object({
    binding_id: uuid,
    profile: z
      .object({
        id: z.string().regex(/^[a-z0-9_-]{1,128}$/),
        db_path: z.string(),
        version: cursorVersion,
        workspace: z.string(),
      })
      .strict(),
    app_root: z.string(),
    app_hash: z.string().regex(/^[0-9a-f]{64}$/),
    extension_version: z.literal(EXTENSION_VERSION),
  })
  .strict();
export type CursorBridgeContext = z.infer<typeof contextSchema>;
type Profile = CursorBridgeContext["profile"];
const registrationSchema = z
  .object({ context: contextSchema, credential_hash: z.string() })
  .strict();
type Registration = z.infer<typeof registrationSchema>;
const helloSchema = z
  .object({
    protocol: z.literal(1),
    extension_version: z.literal(EXTENSION_VERSION),
    workspace: z.string(),
    global_storage: z.string(),
    app_root: z.string(),
    session_id: z.string().min(1).max(255),
    extension_mode: z.literal(1),
    ticket: z.string().nullable(),
    credential: z.string().nullable(),
  })
  .strict();
type Window = {
  socket: Socket;
  lease: string;
  sessionId: string;
  pending: Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >;
};

function safe(value: string): void {
  if (!path.isAbsolute(value) || path.normalize(value) !== value)
    throw new Error("Invalid Cursor bridge path");
  for (let current = value; ; current = path.dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw new Error("Cursor bridge path is a link");
    if (path.dirname(current) === current) break;
  }
}

function privateDirectory(value: string): void {
  safe(value);
  mkdirSync(value, { recursive: true, mode: 0o700 });
  chmodSync(value, 0o700);
}

function privateJson(file: string, value: unknown): void {
  safe(file);
  privateDirectory(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) rmSync(temporary);
  }
}

export class CursorBridge {
  readonly root: string;
  readonly boot = randomUUID();
  #server?: Server;
  #socket?: string;
  #tickets: Array<{ token: string; workspace: string; bindingId?: string; expires: number }> = [];
  #windows = new Map<string, Window>();
  constructor(
    dataDir: string,
    readonly store: BackendStore,
  ) {
    this.root = path.join(dataDir, "cursor-bridge");
  }
  initialize(): void {
    try {
      if (process.platform === "darwin" && this.#registrations().length)
        void this.#listen().catch(() => undefined);
    } catch {}
  }

  #registrations(): Registration[] {
    const file = path.join(this.root, "profiles-v1.json");
    safe(file);
    if (!existsSync(file)) return [];
    if (statSync(file).size > 1024 * 1024) throw new Error("Cursor registry exceeds size limit");
    const value = z
      .object({ schema_version: z.literal(1), registrations: z.array(registrationSchema).max(64) })
      .strict()
      .parse(JSON.parse(readFileSync(file, "utf8")));
    return value.registrations;
  }
  #save(registrations: Registration[]): void {
    privateJson(path.join(this.root, "profiles-v1.json"), { schema_version: 1, registrations });
  }
  profiles(workspace: string): CursorBridgeContext["profile"][] {
    const rows = this.#registrations().filter(
      (row) => row.credential_hash && row.context.profile.workspace === workspace,
    );
    const profiles: Profile[] = [];
    for (const row of rows) {
      try {
        this.validateContext(row.context);
        profiles.push(row.context.profile);
      } catch {
        /* An unavailable profile does not suppress other registered Cursor windows. */
      }
    }
    return [...new Map(profiles.map((profile) => [profile.id, profile])).values()];
  }
  validateProfile(profile: CursorBridgeContext["profile"]): void {
    safe(profile.db_path);
    safe(profile.workspace);
    if (
      path.basename(profile.db_path) !== "state.vscdb" ||
      path.basename(path.dirname(profile.db_path)) !== "globalStorage" ||
      path.basename(path.dirname(path.dirname(profile.db_path))) !== "User" ||
      !statSync(profile.db_path).isFile() ||
      realpathSync(profile.db_path) !== profile.db_path
    )
      throw new Error("Unverified Cursor profile database");
    for (const sidecar of [profile.db_path + "-wal", profile.db_path + "-shm"]) {
      if (existsSync(sidecar)) {
        safe(sidecar);
        if (!lstatSync(sidecar).isFile()) throw new Error("Unsafe Cursor database sidecar");
      }
    }
    if (
      realpathSync(profile.workspace) !== profile.workspace ||
      !statSync(profile.workspace).isDirectory()
    )
      throw new Error("Cursor workspace changed");
  }
  validateContext(context: CursorBridgeContext): void {
    contextSchema.parse(context);
    this.validateProfile(context.profile);
    safe(context.app_root);
    const bytes = readFileSync(path.join(context.app_root, "package.json"));
    const manifest = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    const manifestVersion = cursorVersion.safeParse(manifest.version);
    if (
      manifest.name !== "Cursor" ||
      !manifestVersion.success ||
      manifestVersion.data !== context.profile.version ||
      hash(bytes) !== context.app_hash
    )
      throw new Error("Cursor installation changed after connection");
  }
  context(bindingId: string, workspace: string): CursorBridgeContext {
    if (process.platform !== "darwin")
      throw new Error("Cursor IDE bridge is only verified on macOS");
    const row = this.#registrations().find(
      (entry) => entry.context.binding_id === bindingId && entry.credential_hash,
    );
    if (!row || row.context.profile.workspace !== workspace)
      throw new Error("Cursor profile is not connected to this workspace");
    this.validateContext(row.context);
    if (!this.#windows.has(bindingId)) throw new Error("Cursor IDE window is disconnected");
    return row.context;
  }
  async request(value: unknown): Promise<unknown> {
    const input = z
      .discriminatedUnion("action", [
        z.object({ action: z.literal("status"), workspaceId: z.string() }).strict(),
        z
          .object({
            action: z.literal("connect"),
            workspaceId: z.string(),
            bindingId: uuid.optional(),
          })
          .strict(),
        z
          .object({ action: z.literal("disconnect"), workspaceId: z.string(), bindingId: uuid })
          .strict(),
      ])
      .parse(value);
    const workspace = this.store.workspacePath(input.workspaceId);
    if (input.action === "status")
      return {
        supported: process.platform === "darwin",
        supportedVersions: [...SUPPORTED_VERSIONS],
        bindings: this.#registrations()
          .filter((row) => row.context.profile.workspace === workspace)
          .map((row) => ({
            id: row.context.binding_id,
            profile: row.context.profile.id,
            version: row.context.profile.version,
            connected: !!row.credential_hash && this.#windows.has(row.context.binding_id),
          })),
      };
    if (process.platform !== "darwin")
      throw new Error("Cursor IDE bridge is only verified on macOS");
    if (input.action === "disconnect") {
      const rows = this.#registrations();
      const row = rows.find((entry) => entry.context.binding_id === input.bindingId);
      if (!row || row.context.profile.workspace !== workspace)
        throw new Error("Cursor binding workspace mismatch");
      row.credential_hash = "";
      this.#save(rows);
      this.#tickets = this.#tickets.filter((ticket) => ticket.bindingId !== input.bindingId);
      this.#windows.get(input.bindingId)?.socket.destroy();
      this.#windows.delete(input.bindingId);
      return { disconnected: true };
    }
    if (input.bindingId) {
      const row = this.#registrations().find(
        (entry) =>
          entry.context.binding_id === input.bindingId &&
          entry.context.profile.workspace === workspace,
      );
      if (!row) throw new Error("Cursor reconnect binding is unavailable");
      this.validateProfile(row.context.profile);
    }
    await this.#listen();
    this.#tickets = this.#tickets.filter((ticket) => ticket.expires > Date.now());
    if (this.#tickets.length >= 8) throw new Error("Cursor connection queue is full");
    const token = randomBytes(32).toString("hex");
    this.#tickets.push({
      token,
      workspace,
      bindingId: input.bindingId,
      expires: Date.now() + 120_000,
    });
    return {
      challenge: JSON.stringify({ socket: this.#socket, ticket: token }),
      expires_in_seconds: 120,
    };
  }
  async #listen(): Promise<void> {
    if (this.#server) return;
    privateDirectory(this.root);
    const directory = path.join(
      realpathSync(os.tmpdir()),
      `akib-${randomUUID().replaceAll("-", "")}`,
    );
    privateDirectory(directory);
    const socket = path.join(directory, "b.sock");
    if (Buffer.byteLength(socket) >= 104) throw new Error("Cursor bridge socket path is too long");
    const server = createServer((stream) => this.#accept(stream));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socket, () => {
          server.off("error", reject);
          resolve();
        });
      });
      chmodSync(socket, 0o600);
      privateJson(path.join(this.root, "endpoint-v1.json"), {
        schema_version: 1,
        boot_id: this.boot,
        socket,
      });
      this.#socket = socket;
      this.#server = server;
    } catch (error) {
      server.close();
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }
  #accept(socket: Socket): void {
    socket.setTimeout(3000, () => socket.destroy());
    let buffer = Buffer.alloc(0);
    let bindingId: string | undefined;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME) {
        socket.destroy();
        return;
      }
      for (;;) {
        const end = buffer.indexOf(10);
        if (end < 0) break;
        const frame = buffer.subarray(0, end);
        buffer = buffer.subarray(end + 1);
        try {
          const value: unknown = JSON.parse(frame.toString("utf8"));
          if (!bindingId) {
            bindingId = this.#hello(socket, value);
            socket.setTimeout(0);
          } else this.#reply(bindingId, value);
        } catch {
          socket.destroy();
          return;
        }
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (!bindingId) return;
      const window = this.#windows.get(bindingId);
      if (window?.socket !== socket) return;
      this.#windows.delete(bindingId);
      for (const request of window.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("Cursor window disconnected"));
      }
    });
  }
  #hello(socket: Socket, value: unknown): string {
    const hello = helloSchema.parse(value);
    for (const value of [hello.workspace, hello.global_storage, hello.app_root]) safe(value);
    const workspace = realpathSync(hello.workspace);
    if (
      workspace !== hello.workspace ||
      path.basename(hello.global_storage) !== "agentkib.cursor-bridge"
    )
      throw new Error("Cursor window identity changed");
    const db = path.join(path.dirname(hello.global_storage), "state.vscdb");
    const manifest = readFileSync(path.join(hello.app_root, "package.json"));
    const manifestVersion = cursorVersion.parse(
      (JSON.parse(manifest.toString("utf8")) as Record<string, unknown>).version,
    );
    const profile = { id: hash(db), db_path: db, version: manifestVersion, workspace };
    const rows = this.#registrations();
    let credential: string | null = null;
    let row: Registration;
    if (hello.ticket) {
      const index = this.#tickets.findIndex(
        (ticket) =>
          ticket.token === hello.ticket &&
          ticket.workspace === workspace &&
          ticket.expires > Date.now(),
      );
      if (index < 0) throw new Error("Expired Cursor connection challenge");
      const ticket = this.#tickets.splice(index, 1)[0]!;
      const previousMatches = ticket.bindingId
        ? rows.filter((item) => item.context.binding_id === ticket.bindingId)
        : rows.filter(
            (item) =>
              item.context.profile.id === profile.id &&
              item.context.profile.workspace === workspace,
          );
      if (previousMatches.length > 1) throw new Error("Cursor reconnect profile is ambiguous");
      const previous = previousMatches[0];
      if (
        previous &&
        (previous.context.profile.id !== profile.id ||
          previous.context.profile.workspace !== workspace)
      )
        throw new Error("Cursor reconnect profile changed");
      const context: CursorBridgeContext = {
        binding_id: previous?.context.binding_id ?? randomUUID(),
        profile,
        app_root: hello.app_root,
        app_hash: hash(manifest),
        extension_version: hello.extension_version,
      };
      this.validateContext(context);
      if (!previous && rows.length >= 64) throw new Error("Too many Cursor profiles");
      credential = randomBytes(32).toString("hex");
      row = { context, credential_hash: hash(credential) };
      this.#save([...rows.filter((item) => item.context.binding_id !== context.binding_id), row]);
    } else {
      const matches = rows.filter(
        (item) =>
          item.context.profile.id === profile.id && item.context.profile.workspace === workspace,
      );
      if (matches.length !== 1 || !hello.credential)
        throw new Error("Cursor window requires explicit reconnection");
      row = matches[0]!;
      if (row.credential_hash !== hash(hello.credential) || row.context.app_root !== hello.app_root)
        throw new Error("Cursor credential changed");
      this.validateContext(row.context);
      const existing = this.#windows.get(row.context.binding_id);
      if (existing && existing.sessionId !== hello.session_id)
        throw new Error("Multiple Cursor windows require explicit selection");
    }
    if (this.#windows.size >= 8 && !this.#windows.has(row.context.binding_id))
      throw new Error("Cursor window limit reached");
    const lease = randomUUID();
    socket.write(
      JSON.stringify({
        protocol: 1,
        boot_id: this.boot,
        binding_id: row.context.binding_id,
        lease,
        credential,
        endpoint: path.join(this.root, "endpoint-v1.json"),
      }) + "\n",
    );
    this.#windows.get(row.context.binding_id)?.socket.destroy();
    this.#windows.set(row.context.binding_id, {
      socket,
      lease,
      sessionId: hello.session_id,
      pending: new Map(),
    });
    return row.context.binding_id;
  }
  #reply(bindingId: string, value: unknown): void {
    const window = this.#windows.get(bindingId);
    const reply = z
      .object({
        protocol: z.literal(1),
        boot_id: z.literal(this.boot),
        lease: z.string(),
        request_id: uuid,
        result: z.unknown().optional(),
        error: z.string().optional(),
      })
      .parse(value);
    if (!window || reply.lease !== window.lease)
      throw new Error("Cursor response identity changed");
    const pending = window.pending.get(reply.request_id);
    if (!pending) throw new Error("Unexpected Cursor response");
    window.pending.delete(reply.request_id);
    clearTimeout(pending.timer);
    if (reply.error) pending.reject(new Error("Cursor command failed; reconcile the operation"));
    else pending.resolve(reply.result);
  }
  async call(
    context: CursorBridgeContext,
    action: "status" | "import" | "open" | "selected",
    args: unknown,
  ): Promise<unknown> {
    this.context(context.binding_id, context.profile.workspace);
    const window = this.#windows.get(context.binding_id)!;
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.pending.delete(requestId);
        window.socket.destroy();
        reject(new Error("Cursor bridge request timed out"));
      }, 60_000);
      window.pending.set(requestId, { resolve, reject, timer });
      window.socket.write(
        JSON.stringify({
          protocol: 1,
          boot_id: this.boot,
          binding_id: context.binding_id,
          lease: window.lease,
          request_id: requestId,
          workspace: context.profile.workspace,
          action,
          args,
        }) + "\n",
      );
    });
  }
  close(): void {
    for (const window of this.#windows.values()) window.socket.destroy();
    this.#windows.clear();
    this.#tickets = [];
    this.#server?.close();
    this.#server = undefined;
    if (this.#socket) rmSync(path.dirname(this.#socket), { recursive: true, force: true });
    this.#socket = undefined;
  }
}
