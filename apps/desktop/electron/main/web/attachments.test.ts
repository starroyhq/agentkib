// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AttachmentStore } from "./attachments";

describe("private attachment input storage", () => {
  let dir: string;
  let store: AttachmentStore;
  const owner = { deviceId: "phone", sessionId: "task" };
  const bytes = async function* (value = "hello") {
    yield Buffer.from(value);
  };
  const binary = async function* (value: Buffer) {
    yield value;
  };
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=",
    "base64",
  );
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ak-attachments-"));
    store = new AttachmentStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it("streams upload, binds ownership, retains sent references across restart, and explicitly deletes", async () => {
    const uploaded = await store.upload(bytes(), owner, "notes.txt", "text/plain", () => {});
    expect(uploaded).not.toHaveProperty("path");
    await expect(store.input("other", "task", [uploaded.id], "")).rejects.toThrow(
      "attachment_not_found",
    );
    await expect(store.input("phone", "other-task", [uploaded.id], "")).rejects.toThrow(
      "attachment_not_found",
    );
    const input = await store.input("phone", "task", [uploaded.id], "Read this");
    expect(input).toEqual([
      { type: "text", text: "Read this", text_elements: [] },
      { type: "text", text: expect.stringContaining(uploaded.id), text_elements: [] },
    ]);
    store = new AttachmentStore(dir);
    expect((await store.list("phone", "task"))[0].sent).toBe(true);
    await expect(store.remove("phone", "task", uploaded.id, "wrong-version")).rejects.toThrow(
      "attachment_not_found",
    );
    await store.remove("phone", "task", uploaded.id, uploaded.version);
    expect(await store.list("phone", "task")).toEqual([]);
  });
  it("removes a deleted conversation's uploads from every device, sent or pinned", async () => {
    const sent = await store.upload(bytes(), owner, "sent.txt", "text/plain", () => {});
    await store.input("phone", "task", [sent.id], "Read this");
    const pinned = await store.upload(
      bytes(),
      { deviceId: "laptop", sessionId: "task" },
      "pinned.txt",
      "text/plain",
      () => {},
    );
    await store.inputForAgent("laptop", "task", [pinned.id], "", "codex", "request-1");
    expect(await store.pendingRequests("task")).toEqual([
      { deviceId: "laptop", requestId: "request-1" },
    ]);
    const other = await store.upload(
      bytes(),
      { deviceId: "phone", sessionId: "other" },
      "other.txt",
      "text/plain",
      () => {},
    );
    expect(await store.removeSession("task")).toBe(2);
    expect(await store.list("phone", "task")).toEqual([]);
    expect(await store.list("laptop", "task")).toEqual([]);
    expect(await store.pendingRequests("task")).toEqual([]);
    for (const id of [sent.id, pinned.id])
      await expect(readFile(join(dir, id))).rejects.toMatchObject({ code: "ENOENT" });
    // Another conversation's upload stays, and a restart reads a consistent index.
    store = new AttachmentStore(dir);
    expect((await store.list("phone", "other")).map((item) => item.id)).toEqual([other.id]);
  });
  it("fails on revocation during transfer and removes partial data", async () => {
    await expect(
      store.upload(bytes(), owner, "n.txt", "text/plain", () => {
        throw new Error("revoked");
      }),
    ).rejects.toThrow("revoked");
    expect(await store.list("phone", "task")).toEqual([]);
  });
  it("rejects filenames with path traversal and more than ten inputs", async () => {
    await expect(store.upload(bytes(), owner, "../secret", "text/plain", () => {})).rejects.toThrow(
      "invalid_attachment_name",
    );
    await expect(
      store.input(
        "phone",
        "task",
        Array.from({ length: 11 }, (_, i) => String(i)),
        "",
      ),
    ).rejects.toThrow("invalid_attachments");
  });
  it("rejects changed content and symlink substitutions", async () => {
    const item = await store.upload(bytes(), owner, "n.txt", "text/plain", () => {});
    await writeFile(join(dir, item.id), "other");
    await expect(store.input("phone", "task", [item.id], "")).rejects.toThrow("attachment_changed");
    await unlink(join(dir, item.id));
    await writeFile(join(dir, "outside"), "hello");
    await symlink(join(dir, "outside"), join(dir, item.id));
    await expect(store.input("phone", "task", [item.id], "")).rejects.toThrow("attachment_changed");
  });
  it("removes stale drafts while retaining sent uploads", async () => {
    const a = await store.upload(bytes(), owner, "a.txt", "text/plain", () => {});
    const b = await store.upload(bytes(), owner, "b.txt", "text/plain", () => {});
    await store.input("phone", "task", [b.id], "");
    const index = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
    await writeFile(
      join(dir, "index.json"),
      JSON.stringify(index.map((i: object) => ({ ...i, createdAt: 0 }))),
    );
    expect((await store.list("phone", "task")).map((i) => i.id)).toEqual([b.id]);
    await expect(readFile(join(dir, a.id))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects oversized streaming upload without buffering it", async () => {
    async function* large() {
      for (let i = 0; i < 26; i++) yield Buffer.alloc(1024 * 1024);
    }
    await expect(
      store.upload(large(), owner, "large.bin", "application/octet-stream", () => {}),
    ).rejects.toThrow("attachment_too_large");
    expect(await store.list("phone", "task")).toEqual([]);
  });
  it("accounts for the host quota and removes interrupted unreferenced files", async () => {
    const item = await store.upload(bytes(), owner, "a.txt", "text/plain", () => {});
    const index = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
    await writeFile(
      join(dir, "index.json"),
      JSON.stringify(
        index.map((i: object) => ({ ...i, size: 2 * 1024 * 1024 * 1024, sent: true })),
      ),
    );
    const orphan = "12345678-1234-1234-1234-123456789012";
    await writeFile(join(dir, orphan), "partial");
    await expect(store.upload(bytes(), owner, "b.txt", "text/plain", () => {})).rejects.toThrow(
      "attachment_storage_full",
    );
    await expect(readFile(join(dir, orphan))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await store.list("phone", "task"))[0].id).toBe(item.id);
  });
  it("converts pure image and file inputs to Claude blocks without Codex fields", async () => {
    const image = await store.upload(binary(png), owner, "one.png", "image/png", () => {});
    const file = await store.upload(bytes(), owner, "notes.txt", "text/plain", () => {});
    expect(
      await store.inputForAgent("phone", "task", [image.id], "", "claude", "image-request"),
    ).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: png.toString("base64") },
      },
    ]);
    const input = await store.inputForAgent(
      "phone",
      "task",
      [file.id],
      "",
      "claude",
      "file-request",
    );
    expect(input).toEqual([{ type: "text", text: expect.stringContaining(file.id) }]);
    expect(input[0].text).toContain('"notes.txt"');
  });
  it("preserves Codex localImage encoding", async () => {
    const image = await store.upload(binary(png), owner, "one.png", "image/png", () => {});
    expect(
      await store.inputForAgent("phone", "task", [image.id], "look", "codex", "codex-request"),
    ).toEqual([
      { type: "text", text: "look", text_elements: [] },
      { type: "localImage", path: expect.stringContaining(image.id) },
    ]);
  });
  it("rejects MIME spoofing, unknown image formats and invalid encoded dimensions before pinning", async () => {
    const oversized = Buffer.from(png);
    oversized.writeUInt32BE(8001, 16);
    for (const [value, mime] of [
      [png, "image/jpeg"],
      [png, "text/plain"],
      [Buffer.from("fake"), "image/png"],
      [Buffer.from("<svg/>"), "image/svg+xml"],
      [oversized, "image/png"],
    ] as const) {
      const image = await store.upload(binary(value), owner, "img", mime, () => {});
      await expect(
        store.inputForAgent("phone", "task", [image.id], "", "claude", image.id),
      ).rejects.toThrow("invalid_attachment_image");
      await store.remove("phone", "task", image.id, image.version);
    }
    expect(await store.pendingRequests("task")).toEqual([]);
  });
  it("enforces per-image and aggregate Claude limits independently of the upload limit", async () => {
    const large = await store.upload(
      binary(Buffer.concat([png, Buffer.alloc(4 * 1024 * 1024)])),
      owner,
      "large.png",
      "image/png",
      () => {},
    );
    await expect(
      store.inputForAgent("phone", "task", [large.id], "", "claude", "too-large"),
    ).rejects.toThrow("claude_images_too_large");
    const images = [];
    for (let index = 0; index < 4; index++)
      images.push(
        await store.upload(
          binary(Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)])),
          owner,
          `${index}.png`,
          "image/png",
          () => {},
        ),
      );
    await expect(
      store.inputForAgent(
        "phone",
        "task",
        images.map((image) => image.id),
        "",
        "claude",
        "total-large",
      ),
    ).rejects.toThrow("claude_images_too_large");
    expect(await store.pendingRequests("task")).toEqual([]);
  });
  it("pins unknown requests across restart and aging; settles only matching owner and request", async () => {
    const item = await store.upload(bytes(), owner, "n.txt", "text/plain", () => {});
    await store.inputForAgent("phone", "task", [item.id], "", "claude", "pending");
    store = new AttachmentStore(dir);
    const index = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
    // Simulate a crash after durable pinning but before the sent flag persisted.
    await writeFile(
      join(dir, "index.json"),
      JSON.stringify(index.map((i: object) => ({ ...i, sent: false, createdAt: 0 }))),
    );
    expect((await store.list("phone", "task"))[0].id).toBe(item.id);
    expect(await store.pendingRequests("task")).toEqual([
      { deviceId: "phone", requestId: "pending" },
    ]);
    await store.settle("other", "task", "pending");
    await store.settle("phone", "other-task", "pending");
    await expect(store.remove("phone", "task", item.id, item.version)).rejects.toThrow(
      "attachment_in_use",
    );
    await store.settle("phone", "task", "pending");
    await store.settle("phone", "task", "pending");
    expect(await store.pendingRequests("task")).toEqual([]);
    await store.remove("phone", "task", item.id, item.version);
  });
  it("rejects a changed duplicate request while preserving original pins, including another active request", async () => {
    const item = await store.upload(bytes(), owner, "n.txt", "text/plain", () => {});
    const expected = await store.inputForAgent(
      "phone",
      "task",
      [item.id],
      "one",
      "claude",
      "first",
    );
    expect(await store.inputForAgent("phone", "task", [item.id], "one", "claude", "first")).toEqual(
      expected,
    );
    await expect(
      store.inputForAgent("phone", "task", [item.id], "two", "claude", "first"),
    ).rejects.toThrow("attachment_request_conflict");
    await store.inputForAgent("phone", "task", [item.id], "two", "claude", "second");
    await store.settle("phone", "task", "first");
    await expect(store.remove("phone", "task", item.id, item.version)).rejects.toThrow(
      "attachment_in_use",
    );
    await expect(
      store.inputForAgent("phone", "task", [item.id], "one", "claude", "first"),
    ).rejects.toThrow("attachment_request_settled");
    await store.settle("phone", "task", "second");
    await store.remove("phone", "task", item.id, item.version);
  });
  it("fails closed on corrupt request metadata instead of deleting possibly referenced data", async () => {
    const item = await store.upload(bytes(), owner, "n.txt", "text/plain", () => {});
    await store.inputForAgent("phone", "task", [item.id], "", "claude", "pending");
    await writeFile(join(dir, "requests.json"), '{"schemaVersion":2,"requests":[]}');
    await expect(store.remove("phone", "task", item.id, item.version)).rejects.toThrow(
      "attachment_requests_invalid",
    );
    expect(await readFile(join(dir, item.id), "utf8")).toBe("hello");
  });
  it("retains pinned files if the attachment index is lost", async () => {
    const item = await store.upload(bytes(), owner, "n.txt", "text/plain", () => {});
    await store.inputForAgent("phone", "task", [item.id], "", "claude", "pending");
    await unlink(join(dir, "index.json"));
    store = new AttachmentStore(dir);
    await expect(store.list("phone", "task")).rejects.toThrow(
      "attachment_index_missing_references",
    );
    expect(await readFile(join(dir, item.id), "utf8")).toBe("hello");
  });
  it("checks settled replay fingerprints after deletion without recreating pins", async () => {
    const item = await store.upload(bytes(), owner, "n.txt", "text/plain", () => {});
    await store.inputForAgent("phone", "task", [item.id], "original", "claude", "request");
    await store.settle("phone", "task", "request");
    await store.remove("phone", "task", item.id, item.version);
    store = new AttachmentStore(dir);
    expect(
      await store.verifyReplay("phone", "task", [item.id], "original", "claude", "request"),
    ).toBe(true);
    expect(
      await store.verifyReplay("other", "task", [item.id], "original", "claude", "request"),
    ).toBe(false);
    expect(
      await store.verifyReplay("phone", "other", [item.id], "original", "claude", "request"),
    ).toBe(false);
    expect(
      await store.verifyReplay("phone", "task", [item.id], "original", "claude", "missing"),
    ).toBe(false);
    await expect(
      store.verifyReplay("phone", "task", [item.id], "changed", "claude", "request"),
    ).rejects.toThrow("attachment_request_conflict");
    await expect(
      store.verifyReplay("phone", "task", [], "original", "claude", "request"),
    ).rejects.toThrow("attachment_request_conflict");
    await expect(
      store.verifyReplay("phone", "task", [item.id], "original", "codex", "request"),
    ).rejects.toThrow("attachment_request_conflict");
    expect(await store.pendingRequests("task")).toEqual([]);
  });
  it("rejects wrong owners and drift before adding a Claude request reference", async () => {
    const item = await store.upload(bytes(), owner, "n.txt", "text/plain", () => {});
    await expect(
      store.inputForAgent("other", "task", [item.id], "", "claude", "wrong-owner"),
    ).rejects.toThrow("attachment_not_found");
    await expect(
      store.inputForAgent("phone", "elsewhere", [item.id], "", "claude", "wrong-session"),
    ).rejects.toThrow("attachment_not_found");
    await writeFile(join(dir, item.id), "drift");
    await expect(
      store.inputForAgent("phone", "task", [item.id], "", "claude", "drift"),
    ).rejects.toThrow("attachment_changed");
    expect(await store.pendingRequests("task")).toEqual([]);
  });
});
