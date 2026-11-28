import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createConnection, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BackendStore } from "../../../packages/backend/src/store";
import { canonicalize } from "../../../packages/backend/src/paths";
import {
  CursorBridge,
  type CursorBridgeContext,
} from "../../../packages/backend/src/cursor-bridge";
import {
  CursorIdeSessions,
  prepareCursorIdePayload,
} from "../../../packages/backend/src/cursor-ide-sessions";
import {
  continueCursorNativeImport,
  reconcileCursorNativeImport,
  CursorImportOutcomeUnknownError,
} from "../../../packages/backend/src/cursor-native-import";
import { fingerprintSessionDocument } from "../../../packages/backend/src/session-handoff";
import { HandoffWork } from "../../../packages/backend/src/handoff-work";
import {
  executeHandoffRead,
  type HandoffReadInput,
  type HandoffReadKind,
  type HandoffReadOutput,
} from "../../../packages/backend/src/handoff-read-tasks";
import { TaskContext, type TaskWorkspace } from "../../../packages/backend/src/task-executor";
import type { DocumentOptions, SessionDocument } from "../../../packages/backend/src/session-model";

const roots: string[] = [];
const stores: BackendStore[] = [];
const bridges: CursorBridge[] = [];
const sockets: Array<{ socket: Socket; closed: Promise<void> }> = [];
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const timestamp = "2026-10-07T00:00:00.000Z";
function root() {
  const directory = canonicalize(mkdtempSync(path.join(os.tmpdir(), "cursor-recovery-")));
  roots.push(directory);
  return directory;
}
function storeAt() {
  // Only the native Cursor database and import journal need to persist on disk.
  const store = new BackendStore(":memory:");
  stores.push(store);
  return store;
}
function workspace(store: BackendStore, directory: string, id: string) {
  const project = path.join(directory, id);
  mkdirSync(project, { recursive: true });
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,manifest_workspace_id,status,last_discovered_at) VALUES(?,?,?,?,?,?)",
    id,
    project,
    id,
    id,
    "healthy",
    timestamp,
  );
  return project;
}
function profileAt(directory: string, project: string, name: string): CursorBridgeContext {
  const globalStorage = path.join(directory, name, "User/globalStorage");
  mkdirSync(globalStorage, { recursive: true });
  const dbPath = path.join(globalStorage, "state.vscdb");
  const database = new DatabaseSync(dbPath);
  database.exec(`PRAGMA user_version=1;
    CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value BLOB);
    CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY,workspaceId TEXT,createdAt INTEGER,lastUpdatedAt INTEGER,isArchived INTEGER,isSubagent INTEGER,recency REAL,checkpointAt INTEGER,subagentTypeName TEXT,value TEXT);`);
  database.close();
  const appRoot = path.join(directory, "Cursor-app");
  mkdirSync(appRoot, { recursive: true });
  const manifest = JSON.stringify({ name: "Cursor", version: "3.22.12" });
  writeFileSync(path.join(appRoot, "package.json"), manifest);
  return {
    binding_id: randomUUID(),
    profile: { id: hash(dbPath), db_path: dbPath, version: "3.22.12", workspace: project },
    app_root: appRoot,
    app_hash: hash(manifest),
    extension_version: "0.1.0",
  };
}
const document = (workspaceId: string): SessionDocument => ({
  schema_version: 1,
  source: {
    agent: "claude-code",
    workspace_id: workspaceId,
    title: "Synthetic history",
    created_at: timestamp,
    updated_at: timestamp,
  },
  turns: [
    {
      id: "question",
      role: "user",
      timestamp,
      blocks: [{ type: "text", text: "随机标记 ☃ token-729; use SQLite, never replay tools." }],
    },
    {
      id: "answer",
      role: "assistant",
      timestamp,
      blocks: [{ type: "text", text: "Decision: SQLite with WAL; preserve the original source." }],
    },
  ],
  losses: [],
  redaction_count: 0,
});
type Export = { conversationState: string; blobs: Record<string, string>; name: string };
function writeConversation(context: CursorBridgeContext, nativeId: string, payload: string) {
  const exported = JSON.parse(payload) as Export;
  const workspaceIdentifier = {
    id: "cursor-workspace",
    uri: {
      scheme: "file",
      external: pathToFileURL(context.profile.workspace).href,
      fsPath: context.profile.workspace,
    },
  };
  const header = {
    composerId: nativeId,
    workspaceIdentifier,
    name: exported.name,
    isArchived: false,
    source: "local",
  };
  const db = new DatabaseSync(context.profile.db_path);
  try {
    db.prepare("INSERT OR REPLACE INTO composerHeaders VALUES(?,?,?,?,?,?,?,?,?,?)").run(
      nativeId,
      "cursor-workspace",
      Date.parse(timestamp),
      Date.parse(timestamp),
      0,
      0,
      1,
      null,
      null,
      JSON.stringify(header),
    );
    db.prepare("INSERT OR REPLACE INTO cursorDiskKV VALUES(?,?)").run(
      `composerData:${nativeId}`,
      JSON.stringify({ ...header, _v: 18, conversationState: `~${exported.conversationState}` }),
    );
    const insert = db.prepare("INSERT OR REPLACE INTO cursorDiskKV VALUES(?,?)");
    for (const [id, bytes] of Object.entries(exported.blobs))
      insert.run(`agentKv:blob:${id}`, Buffer.from(bytes, "base64"));
  } finally {
    db.close();
  }
}
function projection(value: SessionDocument) {
  return value.turns.map((turn) => ({
    role: turn.role === "user" ? ("user" as const) : ("assistant" as const),
    text: turn.blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n\n"),
  }));
}
afterEach(async () => {
  const connections = sockets.splice(0);
  for (const { socket } of connections) socket.destroy();
  for (const bridge of bridges.splice(0)) bridge.close();
  await Promise.all(connections.map(({ closed }) => closed));
  for (const store of stores.splice(0)) store.close();
  for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true });
});

type Welcome = { binding_id: string; credential: string; lease: string; boot_id: string };
async function connect(
  bridge: CursorBridge,
  workspaceId: string,
  context: CursorBridgeContext,
  options: { bindingId?: string; delay?: number; fragment?: boolean; challenge?: string } = {},
) {
  const challenge =
    options.challenge ??
    (
      (await bridge.request({
        action: "connect",
        workspaceId,
        ...(options.bindingId ? { bindingId: options.bindingId } : {}),
      })) as { challenge: string }
    ).challenge;
  const ticket = JSON.parse(challenge) as { socket: string; ticket: string };
  const socket = createConnection(ticket.socket);
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  sockets.push({ socket, closed });
  const welcome = new Promise<Welcome | null>((resolve, reject) => {
    let received = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for Cursor handshake"));
    }, 2000);
    socket.on("error", () => {});
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(null);
    });
    socket.on("data", (chunk) => {
      received += chunk.toString();
      if (received.includes("\n")) {
        clearTimeout(timer);
        resolve(JSON.parse(received.split("\n")[0]!) as Welcome);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const hello =
    JSON.stringify({
      protocol: 1,
      extension_version: "0.1.0",
      workspace: context.profile.workspace,
      global_storage: path.join(path.dirname(context.profile.db_path), "agentkib.cursor-bridge"),
      app_root: context.app_root,
      session_id: randomUUID(),
      extension_mode: 1,
      ticket: ticket.ticket,
      credential: null,
    }) + "\n";
  if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
  if (options.fragment) {
    const split = Math.floor(hello.length / 2);
    socket.write(hello.slice(0, split));
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.write(hello.slice(split));
  } else socket.write(hello);
  return { welcome: await welcome, socket };
}

describe.skipIf(process.platform !== "darwin")(
  "Cursor bridge real macOS socket regressions",
  () => {
    it("keeps workspace B readable and pairable after A moves, and can still revoke A", async () => {
      const directory = root();
      const store = storeAt();
      const a = workspace(store, directory, "a"),
        b = workspace(store, directory, "b");
      const profileA = profileAt(directory, a, "profile-a"),
        profileB = profileAt(directory, b, "profile-b");
      const bridge = new CursorBridge(path.join(directory, "data"), store);
      bridges.push(bridge);
      const first = await connect(bridge, "a", profileA);
      expect(first.welcome).not.toBeNull();
      renameSync(a, `${a}-moved`);
      await expect(bridge.request({ action: "status", workspaceId: "b" })).resolves.toMatchObject({
        bindings: [],
      });
      const second = await connect(bridge, "b", profileB);
      expect(second.welcome).not.toBeNull();
      const nativeId = randomUUID();
      writeConversation(
        profileB,
        nativeId,
        prepareCursorIdePayload(document("b"), randomUUID(), b).payload,
      );
      const reader = new CursorIdeSessions(bridge);
      const native = reader.list(b).sessions[0]!;
      expect(reader.document(native, "b", b).turns.at(-1)?.blocks[0]).toMatchObject({
        text: "Decision: SQLite with WAL; preserve the original source.",
      });
      expect(bridge.profiles(a)).toEqual([]);
      await expect(
        bridge.request({
          action: "disconnect",
          workspaceId: "a",
          bindingId: first.welcome!.binding_id,
        }),
      ).resolves.toEqual({ disconnected: true });
      await expect(bridge.request({ action: "status", workspaceId: "b" })).resolves.toMatchObject({
        bindings: [{ connected: true }],
      });
      expect(reader.nativeId(native.native_ref, b)).toBe(nativeId);
    });

    it("revokes an unconsumed reconnect challenge when the binding is disconnected", async () => {
      const directory = root();
      const store = storeAt();
      const project = workspace(store, directory, "project");
      const context = profileAt(directory, project, "profile");
      const bridge = new CursorBridge(path.join(directory, "data"), store);
      bridges.push(bridge);
      const first = await connect(bridge, "project", context);
      const bindingId = first.welcome!.binding_id;
      const pending = (await bridge.request({
        action: "connect",
        workspaceId: "project",
        bindingId,
      })) as { challenge: string };
      await bridge.request({ action: "disconnect", workspaceId: "project", bindingId });
      expect(
        (await connect(bridge, "project", context, { challenge: pending.challenge })).welcome,
      ).toBeNull();
      expect(bridge.profiles(project)).toEqual([]);
      await expect(
        bridge.request({ action: "status", workspaceId: "project" }),
      ).resolves.toMatchObject({ bindings: [{ connected: false }] });
      expect((await connect(bridge, "project", context, { bindingId })).welcome?.binding_id).toBe(
        bindingId,
      );
    });

    it.each([
      { delay: 50, fragment: false },
      { delay: 0, fragment: true },
    ])("accepts a delayed or fragmented first handshake: %j", async (options) => {
      const directory = root();
      const store = storeAt();
      const project = workspace(store, directory, "project");
      const context = profileAt(directory, project, "profile");
      const bridge = new CursorBridge(path.join(directory, "data"), store);
      bridges.push(bridge);
      const result = await connect(bridge, "project", context, options);
      expect(result.welcome?.binding_id).toMatch(/^[0-9a-f-]{36}$/);
      await expect(
        bridge.request({ action: "status", workspaceId: "project" }),
      ).resolves.toMatchObject({ bindings: [{ connected: true }] });
    });
  },
);

describe("Cursor SQLite prefix recovery", () => {
  it("allows a new answer to reuse the old prompt blob while still rejecting changed imported text", () => {
    const directory = root();
    const store = storeAt();
    const project = workspace(store, directory, "project");
    const context = profileAt(directory, project, "profile");
    const source = document("project"),
      operation = randomUUID(),
      nativeId = randomUUID();
    const original = prepareCursorIdePayload(source, operation, project);
    const reader = new CursorIdeSessions({ profiles: () => [context.profile] });
    writeConversation(context, nativeId, original.payload);
    const native = reader.list(project).sessions[0]!;
    const extended = structuredClone(source);
    extended.turns.push(
      {
        id: "again",
        role: "user",
        blocks: [{ type: "text", text: "Repeat the same decision verbatim." }],
      },
      { ...structuredClone(source.turns[1]!), id: "same-answer" },
    );
    const next = prepareCursorIdePayload(extended, operation, project);
    const oldAnswer = hash(
      JSON.stringify({
        role: "assistant",
        content: [{ type: "text", text: projection(source)[1]!.text }],
      }),
    );
    const rootBytes = Buffer.from((JSON.parse(next.payload) as Export).conversationState, "base64");
    expect(rootBytes.indexOf(Buffer.from(oldAnswer, "hex"))).toBeGreaterThanOrEqual(0);
    expect(rootBytes.lastIndexOf(Buffer.from(oldAnswer, "hex"))).toBeGreaterThan(
      rootBytes.indexOf(Buffer.from(oldAnswer, "hex")),
    );
    writeConversation(context, nativeId, next.payload);
    expect(() =>
      reader.verifyPromptProjection(
        native.native_ref,
        project,
        projection(original.expected),
        false,
      ),
    ).not.toThrow();
    expect(reader.document(native, "project", project).turns.map((turn) => turn.blocks[0])).toEqual(
      next.expected.turns.map((turn) => turn.blocks[0]),
    );
    expect(() =>
      reader.verifyPromptProjection(
        native.native_ref,
        project,
        projection(original.expected),
        true,
      ),
    ).toThrow("count");
    extended.turns[1]!.blocks = [{ type: "text", text: "Changed the imported decision" }];
    writeConversation(
      context,
      nativeId,
      prepareCursorIdePayload(extended, operation, project).payload,
    );
    expect(() =>
      reader.verifyPromptProjection(
        native.native_ref,
        project,
        projection(original.expected),
        false,
      ),
    ).toThrow("approved preview");
  }, 15_000);
});

// The extension command boundary is simulated; plans, receipts and target reads stay real.
class ImportWindow extends CursorBridge {
  imports = 0;
  opened: string[] = [];
  loseImportReply = true;
  onImport?: () => void;
  onOpen?: () => void;
  readonly nativeId = randomUUID();
  constructor(
    dataDir: string,
    store: BackendStore,
    readonly binding: CursorBridgeContext,
  ) {
    super(dataDir, store);
  }
  override context(bindingId: string, project: string) {
    if (bindingId !== this.binding.binding_id || project !== this.binding.profile.workspace)
      throw new Error("Unexpected test window");
    this.validateContext(this.binding);
    return this.binding;
  }
  override profiles(project: string) {
    return project === this.binding.profile.workspace ? [this.binding.profile] : [];
  }
  override async call(
    context: CursorBridgeContext,
    action: "status" | "import" | "open" | "selected",
    args: unknown,
  ): Promise<unknown> {
    this.context(context.binding_id, context.profile.workspace);
    if (action === "import") {
      this.imports++;
      const payload = (args as { payload: string }).payload;
      writeConversation(this.binding, this.nativeId, payload);
      this.onImport?.();
      if (this.loseImportReply)
        throw new Error("Synthetic lost import response after native persistence");
      return { consumed: true };
    }
    if (action === "open") {
      const id = (args as { native_id: string }).native_id;
      this.opened.push(id);
      this.onOpen?.();
      return { selected: [id] };
    }
    throw new Error("Unexpected extension action");
  }
}

function importFixture(persisted = true, includePreCompactionHistory = false) {
  const directory = root();
  const store = storeAt();
  const project = workspace(store, directory, "registered");
  store.sql.run("UPDATE workspaces SET manifest_workspace_id=? WHERE id=?", "legacy", "registered");
  store.sessions.sync("registered", "claude-code", [
    {
      native_ref: "source",
      agent: "claude-code",
      title: "Synthetic history",
      created_at: timestamp,
      updated_at: timestamp,
      message_count: 2,
      git_branch: null,
      archived: false,
      sidechain: false,
      availability: "readable",
      origin: "interactive",
    },
  ]);
  const context = profileAt(directory, project, "profile");
  // A compacted source reads differently with and without the earlier history.
  const base = document("legacy");
  const withHistory: SessionDocument = {
    ...base,
    turns: [
      { id: "old", role: "user", blocks: [{ type: "text", text: "Earlier history marker" }] },
      ...base.turns,
    ],
  };
  const dataDir = path.join(directory, "data"),
    operation = randomUUID(),
    source = includePreCompactionHistory ? withHistory : base;
  const prepared = prepareCursorIdePayload(source, operation, project);
  const plan = {
    schema_version: 1,
    operation_id: operation,
    workspace_id: "legacy",
    workspace: project,
    source_session_id: store.sessions.id("claude-code", "source"),
    source_fingerprint: fingerprintSessionDocument(source),
    target_agent: "cursor",
    target_session_id: operation,
    context,
    before_native_refs: [],
    document: source,
    expected: prepared.expected,
    payload: prepared.payload,
    marker: prepared.marker,
    ...(includePreCompactionHistory ? { include_pre_compaction_history: true } : {}),
  };
  const content = JSON.stringify(plan, null, 2) + "\n";
  const location = path.join(
    dataDir,
    "continuations",
    hash("legacy").slice(0, 32),
    operation,
    "import",
  );
  mkdirSync(location, { recursive: true });
  const planFile = path.join(location, "plan.json");
  if (persisted) writeFileSync(planFile, content);
  const request = {
    mode: "native-import",
    operation_id: operation,
    workspace_id: "legacy",
    target_agent: "cursor",
    plan_hash: hash(content),
    binding_id: context.binding_id,
  };
  const value = {
    approveHome: true,
    launchRequest: request,
    changeSet: {
      id: operation,
      project_root: project,
      created_at: timestamp,
      requires_home_approval: true,
      changes: [
        {
          target: planFile,
          scope: "application-data",
          original_hash: null,
          before: "",
          after: content,
          risk: "high",
          validator: "json",
        },
      ],
    },
  };
  const bridge = new ImportWindow(dataDir, store, context);
  bridge.loseImportReply = false;
  bridges.push(bridge);
  let beforeSourceRead: (() => void) | undefined;
  const requested: Array<DocumentOptions | undefined> = [];
  const sessions = {
    document: async (_id: string, options?: DocumentOptions) => {
      requested.push(options);
      beforeSourceRead?.();
      return structuredClone(options?.includePreCompactionHistory ? withHistory : base);
    },
  };
  const environment = { HOME: directory, USERPROFILE: directory };
  return {
    store,
    bridge,
    requested,
    planFile,
    receiptFile: path.join(location, "receipt.json"),
    attemptFile: path.join(location, "attempted.json"),
    proceed: () =>
      continueCursorNativeImport(
        value,
        sessions,
        store.sessions,
        store,
        dataDir,
        bridge,
        environment,
      ),
    recover: () =>
      reconcileCursorNativeImport(
        request,
        sessions,
        store.sessions,
        store,
        dataDir,
        bridge,
        environment,
      ),
    onSourceRead: (action: () => void) => {
      beforeSourceRead = action;
    },
    replaceOwner: () => {
      const otherProject = path.join(directory, "other-project");
      mkdirSync(otherProject);
      store.sql.run(
        "UPDATE workspaces SET canonical_path=?, manifest_workspace_id=? WHERE id=?",
        otherProject,
        "other-legacy",
        "registered",
      );
      store.sql.run(
        "INSERT INTO workspaces(id,canonical_path,name,manifest_workspace_id,status,last_discovered_at) VALUES(?,?,?,?,?,?)",
        "replacement",
        project,
        "Replacement",
        "legacy",
        "healthy",
        timestamp,
      );
    },
  };
}

// Execute the actual read task, then change the owner before its result reaches the caller.
class RebindingReadWork extends HandoffWork {
  replaced = false;
  constructor(
    readonly stage: HandoffReadKind,
    readonly replaceOwner: () => void,
  ) {
    super();
  }
  override async read<K extends HandoffReadKind>(
    kind: K,
    input: HandoffReadInput<K>,
    task: TaskContext,
  ): Promise<HandoffReadOutput<K>> {
    task.checkpoint();
    const result = await executeHandoffRead(kind, input, this.commands);
    if (kind === this.stage && !this.replaced) {
      this.replaced = true;
      this.replaceOwner();
    }
    return result;
  }
}
async function duringRead<T>(
  stage: HandoffReadKind,
  replaceOwner: () => void,
  action: () => Promise<T>,
) {
  const work = new RebindingReadWork(stage, replaceOwner);
  const task = new TaskContext({ id: randomUUID(), deadlineAt: Date.now() + 5000 });
  try {
    return await work.run(task, action);
  } finally {
    task.dispose();
    await work.close();
  }
}

describe("Cursor continuation registered owner stability", () => {
  it.each(["cursor-plan", "serialize", "cursor-projection"] as const)(
    "rejects owner replacement during %s before changing reviewed files or importing",
    async (stage) => {
      const f = importFixture(stage === "cursor-plan");
      const reviewed = existsSync(f.planFile) ? readFileSync(f.planFile, "utf8") : null;
      await expect(duringRead(stage, f.replaceOwner, f.proceed)).rejects.toThrow(
        /workspace identity changed/,
      );
      expect(f.bridge.imports).toBe(0);
      expect(f.bridge.opened).toEqual([]);
      if (reviewed === null) expect(existsSync(f.planFile)).toBe(false);
      else expect(readFileSync(f.planFile, "utf8")).toBe(reviewed);
      expect(existsSync(f.attemptFile)).toBe(false);
      expect(existsSync(f.receiptFile)).toBe(false);
    },
  );

  it("rejects owner replacement during source parsing before persisting or importing", async () => {
    const f = importFixture(false);
    f.onSourceRead(f.replaceOwner);
    await expect(f.proceed()).rejects.toThrow(/workspace identity changed/);
    expect(f.bridge.imports).toBe(0);
    expect(existsSync(f.planFile)).toBe(false);
    expect(existsSync(f.attemptFile)).toBe(false);
    expect(existsSync(f.receiptFile)).toBe(false);
  });

  it.each([false, true])(
    "reads an unpersisted source again with the pre-compaction history choice of its plan (%s)",
    async (include) => {
      const f = importFixture(false, include);
      await f.proceed();
      expect(f.requested).toEqual([include ? { includePreCompactionHistory: true } : undefined]);
      expect(f.bridge.imports).toBe(1);
    },
  );
  it("keeps a consumed import unresolved when its registered owner changes before the reply", async () => {
    const f = importFixture();
    f.bridge.onImport = f.replaceOwner;
    await expect(f.proceed()).rejects.toBeInstanceOf(CursorImportOutcomeUnknownError);
    expect(f.bridge.imports).toBe(1);
    expect(f.bridge.opened).toEqual([]);
    expect(existsSync(f.attemptFile)).toBe(true);
    expect(existsSync(f.receiptFile)).toBe(false);
    expect(
      new CursorIdeSessions(f.bridge).list(f.bridge.binding.profile.workspace).sessions,
    ).toHaveLength(1);
  });

  it.each(["cursor-list", "cursor-read"] as const)(
    "keeps an imported target unresolved when its owner changes during %s",
    async (stage) => {
      const f = importFixture();
      await expect(duringRead(stage, f.replaceOwner, f.proceed)).rejects.toBeInstanceOf(
        CursorImportOutcomeUnknownError,
      );
      expect(f.bridge.imports).toBe(1);
      expect(f.bridge.opened).toEqual([]);
      expect(existsSync(f.receiptFile)).toBe(false);
    },
  );

  it("rejects a changed recovery owner before reopening or importing again", async () => {
    const f = importFixture();
    f.bridge.loseImportReply = true;
    await expect(f.proceed()).rejects.toBeInstanceOf(CursorImportOutcomeUnknownError);
    await expect(duringRead("cursor-recovery", f.replaceOwner, f.recover)).rejects.toThrow(
      /workspace identity changed/,
    );
    expect(f.bridge.imports).toBe(1);
    expect(f.bridge.opened).toEqual([]);
    expect(existsSync(f.receiptFile)).toBe(false);
  });

  it("does not mark a verified receipt launched after its registered owner changes during open", async () => {
    const f = importFixture();
    f.bridge.onOpen = f.replaceOwner;
    await expect(f.proceed()).rejects.toThrow(/workspace identity changed/);
    expect(f.bridge.imports).toBe(1);
    expect(f.bridge.opened).toEqual([f.bridge.nativeId]);
    expect(JSON.parse(readFileSync(f.receiptFile, "utf8"))).toMatchObject({
      verified: true,
      launched: false,
    });
  });

  it("rejects an owner replaced while the launched receipt commit settles, preserving the receipt", async () => {
    const f = importFixture();
    const work = new HandoffWork({
      filename: path.resolve("dist-electron/backend-handoff-read.cjs"),
    });
    let committedReceipt: Buffer | undefined;
    const task = new (class extends TaskContext {
      override async commit<T>(operation: () => Promise<T> | T, scope?: TaskWorkspace) {
        const result = await super.commit(operation, scope);
        if (!committedReceipt && existsSync(f.receiptFile)) {
          const content = readFileSync(f.receiptFile);
          if (JSON.parse(content.toString("utf8")).launched === true) {
            committedReceipt = content;
            f.replaceOwner();
          }
        }
        return result;
      }
    })({ id: randomUUID(), deadlineAt: Date.now() + 10_000 });
    try {
      await expect(work.run(task, f.proceed)).rejects.toThrow(/workspace identity changed/);
      expect(f.bridge.imports).toBe(1);
      expect(f.bridge.opened).toEqual([f.bridge.nativeId]);
      expect(committedReceipt).toBeDefined();
      expect(readFileSync(f.receiptFile)).toEqual(committedReceipt);
    } finally {
      task.dispose();
      await work.close();
    }
  }, 15_000);
});

describe("Cursor persisted import recovery", () => {
  it("reconciles a lost reply and a deleted receipt without importing twice, retaining the original native UUID", async () => {
    const directory = root();
    const store = storeAt();
    const project = workspace(store, directory, "project");
    const context = profileAt(directory, project, "profile");
    const dataDir = path.join(directory, "data"),
      operation = randomUUID(),
      source = document("project");
    const prepared = prepareCursorIdePayload(source, operation, project);
    const plan = {
      schema_version: 1,
      operation_id: operation,
      workspace_id: "project",
      workspace: project,
      source_session_id: "synthetic-source",
      source_fingerprint: fingerprintSessionDocument(source),
      target_agent: "cursor",
      target_session_id: operation,
      context,
      before_native_refs: [],
      document: source,
      expected: prepared.expected,
      payload: prepared.payload,
      marker: prepared.marker,
    };
    const content = JSON.stringify(plan, null, 2) + "\n";
    const location = path.join(
      dataDir,
      "continuations",
      hash("project").slice(0, 32),
      operation,
      "import",
    );
    mkdirSync(location, { recursive: true });
    const planFile = path.join(location, "plan.json");
    writeFileSync(planFile, content);
    const request = {
      mode: "native-import",
      operation_id: operation,
      workspace_id: "project",
      target_agent: "cursor",
      plan_hash: hash(content),
      binding_id: context.binding_id,
    };
    const value = {
      approveHome: true,
      launchRequest: request,
      changeSet: {
        id: operation,
        project_root: project,
        created_at: timestamp,
        requires_home_approval: true,
        changes: [
          {
            target: planFile,
            scope: "application-data",
            original_hash: null,
            before: "",
            after: content,
            risk: "high",
            validator: "json",
          },
        ],
      },
    };
    const bridge = new ImportWindow(dataDir, store, context);
    bridges.push(bridge);
    const sessions = {
      document: async () => {
        throw new Error("Recovery must use the frozen source document");
      },
    };
    const environment = { HOME: directory, USERPROFILE: directory };
    await expect(
      continueCursorNativeImport(
        value,
        sessions,
        store.sessions,
        store,
        dataDir,
        bridge,
        environment,
      ),
    ).rejects.toBeInstanceOf(CursorImportOutcomeUnknownError);
    expect(bridge.imports).toBe(1);
    const attempt = readFileSync(path.join(location, "attempted.json"), "utf8");
    expect(JSON.parse(attempt).plan_hash).toBe(hash(content));
    const recover = () =>
      reconcileCursorNativeImport(
        request,
        sessions,
        store.sessions,
        store,
        dataDir,
        bridge,
        environment,
      );
    await expect(recover()).resolves.toMatchObject({ status: "launched" });
    const receiptFile = path.join(location, "receipt.json");
    const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
    expect(receipt).toMatchObject({ verified: true, launched: true });
    rmSync(receiptFile);
    await expect(recover()).resolves.toMatchObject({ status: "launched" });
    expect(JSON.parse(readFileSync(receiptFile, "utf8")).target_session_id).toBe(
      receipt.target_session_id,
    );
    const extended = structuredClone(source);
    extended.turns.push(
      {
        id: "repeat",
        role: "user",
        blocks: [{ type: "text", text: "Repeat the original answer." }],
      },
      { ...structuredClone(source.turns[1]!), id: "repeated-answer" },
    );
    writeConversation(
      context,
      bridge.nativeId,
      prepareCursorIdePayload(extended, operation, project).payload,
    );
    await expect(recover()).resolves.toMatchObject({ status: "launched" });
    await expect(recover()).resolves.toMatchObject({ status: "launched" });
    expect(bridge.imports).toBe(1);
    expect(bridge.opened).toEqual(Array(4).fill(bridge.nativeId));
    const reader = new CursorIdeSessions(bridge);
    const listing = reader.list(project);
    expect(listing.sessions).toHaveLength(1);
    expect(reader.nativeId(listing.sessions[0]!.native_ref, project)).toBe(bridge.nativeId);
    expect(readFileSync(planFile, "utf8")).toBe(content);
    expect(readFileSync(path.join(location, "attempted.json"), "utf8")).toBe(attempt);
  }, 15_000);
});
