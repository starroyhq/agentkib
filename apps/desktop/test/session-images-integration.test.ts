// @vitest-environment node
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerSession } from "../../../packages/backend/src/codex-app-server";
import { CodexFollowerBridge } from "../../../packages/backend/src/codex-follower-bridge";
import { CodexRuntimePreflight } from "../../../packages/backend/src/codex-runtime-preflight";
import { CodexSessions } from "../../../packages/backend/src/codex-sessions";
import type { Commands } from "../../../packages/backend/src/commands";
import { saveManagedRecord } from "../../../packages/backend/src/managed-ledger";
import type { ConversationEventPage } from "../../../packages/backend/src/session-events";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import { BackendStore } from "../../../packages/backend/src/store";
import { WebReadRequests } from "../../../packages/backend/src/web-read";

// A real one-pixel PNG, not a MIME label attached to arbitrary text bytes.
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZsAAAAASUVORK5CYII=";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-image-read-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"),
    home = path.join(root, "codex");
  mkdirSync(workspace);
  mkdirSync(path.join(home, "sessions"), { recursive: true });
  const nativeIds = [randomUUID(), randomUUID()];
  const transcripts = nativeIds.map((id) => path.join(home, "sessions", `${id}.jsonl`));
  for (const [index, id] of nativeIds.entries()) {
    const rows = [
      { type: "session_meta", payload: { id, cwd: workspace, source: "cli" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: `turn-${index}` } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          id: `message-${index}`,
          content: [
            { type: "input_text", text: `Synthetic image ${index}` },
            { type: "input_image", image_url: `data:image/png;base64,${png}` },
          ],
        },
      },
    ];
    writeFileSync(transcripts[index]!, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  }
  const native = new DatabaseSync(path.join(home, "state_1.sqlite"));
  native.exec(
    "CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,cwd TEXT,title TEXT,source TEXT,archived INTEGER)",
  );
  for (const [index, id] of nativeIds.entries())
    native
      .prepare("INSERT INTO threads VALUES(?,?,?,?,?,?)")
      .run(id, transcripts[index]!, workspace, `Image ${index}`, "cli", 0);
  native.close();
  const environment = { CODEX_HOME: home, HOME: root, PATH: "" };
  const store = new BackendStore(path.join(root, "agentkib.db"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "workspace",
    workspace,
    "Synthetic",
    "healthy",
    new Date().toISOString(),
  );
  store.sessions.sync(
    "workspace",
    "codex",
    new CodexSessions(environment).list(workspace).sessions.map((source) => source.session),
  );
  const ids = nativeIds.map((id) => store.sessions.id("codex", id));
  const readers = new SessionReaders(store.sessions, {} as Commands, environment, {
    profiles: async () => [],
  });
  cleanups.push(() => readers.close());
  let generation = 0n;
  const read = new WebReadRequests(store, readers, root, () => generation, environment);
  cleanups.push(() => read.closeAsync());
  const start = vi
    .spyOn(CodexAppServerSession, "start")
    .mockRejectedValue(new Error("must-not-start-writer"));
  const follower = vi
    .spyOn(CodexFollowerBridge, "connect")
    .mockRejectedValue(new Error("must-not-connect-follower"));
  const preflight = vi
    .spyOn(CodexRuntimePreflight.prototype, "check")
    .mockRejectedValue(new Error("must-not-probe-cli"));
  const events = async (sessionId = ids[0]!) =>
    (await read.request({ operation: "events", sessionId, limit: 50 })) as ConversationEventPage;
  const image = (imageId: string, sessionId = ids[0]!) =>
    read.request({ operation: "session-image", sessionId, imageId });
  return {
    root,
    workspace,
    home,
    store,
    readers,
    read,
    ids,
    nativeIds,
    transcripts,
    events,
    image,
    start,
    follower,
    preflight,
    bump: () => {
      generation++;
    },
  };
}

describe("native message images through the read-only WebRead boundary", () => {
  it("serves verified bytes separately from stable event references, without acquiring execution ownership", async () => {
    const f = fixture();
    const first = await f.events();
    const message = first.events.find((event) => event.kind === "user-message")!;
    expect(message).toMatchObject({
      content: "Synthetic image 0",
      images: [{ id: expect.stringMatching(/^session-image-v1-/), mimeType: "image/png" }],
    });
    expect(JSON.stringify(first)).not.toContain(png);
    expect(JSON.stringify(first)).not.toContain(f.home);
    const id = message.images![0]!.id;
    expect(await f.image(id)).toEqual({ mimeType: "image/png", base64: png });
    expect(
      (await f.events()).events.find((event) => event.kind === "user-message")?.images,
    ).toEqual(message.images);
    appendFileSync(
      f.transcripts[0]!,
      JSON.stringify({
        type: "event_msg",
        payload: { type: "agent_message", message: "Later body" },
      }) + "\n",
    );
    expect(
      (await f.events()).events.find((event) => event.kind === "user-message")?.images,
    ).toEqual(message.images);
    expect(await f.image(id)).toEqual({ mimeType: "image/png", base64: png });
    expect(f.start).not.toHaveBeenCalled();
    expect(f.follower).not.toHaveBeenCalled();
    expect(f.preflight).not.toHaveBeenCalled();
  });

  it("does not accept another session's reference even when the actual image bytes match", async () => {
    const f = fixture();
    const id = (await f.events()).events.find((event) => event.images?.length)?.images![0]!.id!;
    await f.events(f.ids[1]);
    await expect(f.image(id, f.ids[1])).rejects.toThrow("session-image-unavailable");
  });

  it("rejects a response after index generation changes during the read", async () => {
    const f = fixture();
    const id = (await f.events()).events.find((event) => event.images?.length)?.images![0]!.id!;
    const original = f.readers.image.bind(f.readers);
    vi.spyOn(f.readers, "image").mockImplementation(async (...args) => {
      const result = await original(...args);
      f.bump();
      return result;
    });
    await expect(f.image(id)).rejects.toThrow("session-image-unavailable");
  });

  it("rejects when indexing is disabled before or during a read", async () => {
    const f = fixture();
    const id = (await f.events()).events.find((event) => event.images?.length)?.images![0]!.id!;
    const original = f.readers.image.bind(f.readers);
    const image = vi.spyOn(f.readers, "image").mockImplementation(async (...args) => {
      const result = await original(...args);
      writeFileSync(
        path.join(f.root, "preferences.json"),
        JSON.stringify({ session_index_enabled: false }),
      );
      return result;
    });
    await expect(f.image(id)).rejects.toThrow("session-image-unavailable");
    image.mockClear();
    await expect(f.image(id)).rejects.toThrow("session-image-unavailable");
    expect(image).not.toHaveBeenCalled();
  });

  it("rejects when the registered workspace is replaced during image resolution", async () => {
    const f = fixture();
    const id = (await f.events()).events.find((event) => event.images?.length)?.images![0]!.id!;
    const original = f.readers.resolve.bind(f.readers);
    let calls = 0;
    vi.spyOn(f.readers, "resolve").mockImplementation(async (...args) => {
      if (++calls === 2)
        f.store.sql.run("UPDATE workspaces SET canonical_path=? WHERE id=?", f.home, "workspace");
      return original(...args);
    });
    await expect(f.image(id)).rejects.toThrow();
  });

  it("uses the verified native history for a disconnected managed alias", async () => {
    const f = fixture();
    saveManagedRecord(f.root, {
      id: "managed-session",
      workspace_id: "workspace",
      workspace: f.workspace,
      home: f.home,
      native_id: f.nativeIds[0],
      title: "Synthetic managed",
      created_at: new Date().toISOString(),
      policy_id: "workspace-write-on-request",
      released: false,
      adopted: false,
      snapshot: { revision: 1 },
    });
    const page = await f.events("managed-session");
    const id = page.events.find((event) => event.images?.length)?.images![0]!.id!;
    expect(id).toMatch(/^session-image-v1-/);
    expect(await f.image(id, "managed-session")).toEqual({ mimeType: "image/png", base64: png });
    expect(f.start).not.toHaveBeenCalled();
  });

  it("rejects client-supplied paths or bytes instead of expanding image-read authority", async () => {
    const f = fixture();
    await expect(
      f.read.request({
        operation: "session-image",
        sessionId: f.ids[0],
        imageId: "invalid",
        path: f.transcripts[0],
      }),
    ).rejects.toThrow();
    await expect(f.image(f.transcripts[0]!)).rejects.toThrow("session-image-invalid");
  });
});
