// @vitest-environment node
import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SessionImages,
  MAX_SESSION_IMAGE_BYTES,
  sessionImageSources,
} from "../../../packages/backend/src/session-images";
import { SessionPaging } from "../../../packages/backend/src/session-paging";
import { enrichLedgerImages } from "../../../packages/backend/src/session-image-matching";
import { codexRollouts } from "../../../packages/backend/src/codex-rollout-files";
import type {
  ConversationEvent,
  HistoryFormat,
} from "../../../packages/backend/src/session-events";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=",
  "base64",
);
const uri = (bytes = png, mime = "image/png") => `data:${mime};base64,${bytes.toString("base64")}`;
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(rows: unknown[] = []) {
  const root = mkdtempSync(path.join(tmpdir(), "agentkib-images-"));
  roots.push(root);
  const file = path.join(root, "history.jsonl");
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return { root, file };
}
const response = (
  images: unknown[] = [{ type: "input_image", image_url: uri() }],
  text = "Question",
) => ({
  type: "response_item",
  payload: {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }, ...images],
    internal_chat_message_metadata_passthrough: { turn_id: "turn" },
  },
});
const primary = (image: string, text = "Question") => ({
  type: "event_msg",
  payload: {
    type: "user_message",
    message: text,
    images: [],
    local_images: [image],
    turn_id: "turn",
  },
});
function registered(row: unknown, format: HistoryFormat = "codex") {
  const f = fixture([row]);
  const images = new SessionImages();
  const metadata = images.register(
    "scope",
    0,
    Buffer.from(JSON.stringify(row)),
    row,
    format,
    f.root,
  );
  return { ...f, images, metadata };
}

describe("native image authority", () => {
  it("returns only opaque metadata and reads the verified inline image on demand", () => {
    const { file, images, metadata } = registered(response());
    expect(metadata).toHaveLength(1);
    expect(metadata[0]).toMatchObject({ mimeType: "image/png" });
    expect(JSON.stringify(metadata)).not.toContain(png.toString("base64"));
    expect(images.read("scope", file, metadata[0]!.id)).toEqual({
      mimeType: "image/png",
      base64: png.toString("base64"),
    });
    expect(() => images.read("different-session", file, metadata[0]!.id)).toThrow(
      "session-image-unavailable",
    );
    expect(() => images.read("scope", file, "../local.png")).toThrow("session-image-invalid");
  });
  it("keeps IDs stable across native re-reads and mirrored records", () => {
    const row = response();
    const { images, metadata } = registered(row);
    expect(images.register("scope", 99, Buffer.from(JSON.stringify(row)), row, "codex")).toEqual(
      metadata,
    );
    expect(
      images.register("another", 99, Buffer.from(JSON.stringify(row)), row, "codex")[0]!.id,
    ).not.toBe(metadata[0]!.id);
  });
  it("never reads ordinary text paths, remote URLs, SVG, HTML, or nested URL wrappers", () => {
    let nested: unknown = uri();
    for (let index = 0; index < 12_000; index++) nested = { url: nested };
    for (const row of [
      response([], "/private/secret.png"),
      response([{ type: "input_image", image_url: "https://example.invalid/image.png" }]),
      response([{ type: "input_image", image_url: "data:image/svg+xml;base64,PHN2Zz4=" }]),
      response([{ type: "input_image", image_url: nested }]),
    ])
      expect(sessionImageSources(row, "codex", "/tmp")).toEqual([]);
    const { images, file, metadata } = registered(
      response([{ type: "input_image", image_url: uri(Buffer.from("<html>bad</html>")) }]),
    );
    expect(() => images.read("scope", file, metadata[0]!.id)).toThrow("session-image-unsupported");
  });
  it("rejects changed/deleted native rows and expired references", () => {
    const f = registered(response());
    writeFileSync(f.file, JSON.stringify(response([], "Changed")) + "\n");
    expect(() => f.images.read("scope", f.file, f.metadata[0]!.id)).toThrow(
      "session-image-changed",
    );
    rmSync(f.file);
    expect(() => f.images.read("scope", f.file, f.metadata[0]!.id)).toThrow(
      "session-image-unavailable",
    );
    const fresh = registered(response());
    const now = performance.now();
    vi.spyOn(performance, "now").mockReturnValue(now + 16 * 60_000);
    expect(() => fresh.images.read("scope", fresh.file, fresh.metadata[0]!.id)).toThrow(
      "session-image-unavailable",
    );
  });
  it("validates MIME against bytes and canonical base64", () => {
    for (const value of [
      uri(png, "image/jpeg"),
      "data:image/png;base64,@@@@",
      uri().slice(0, -1),
    ]) {
      const { images, file, metadata } = registered(
        response([{ type: "input_image", image_url: value }]),
      );
      expect(() => images.read("scope", file, metadata[0]!.id)).toThrow(
        "session-image-unsupported",
      );
    }
  });
  it("pins structured local images to file identity and returns only basename", () => {
    const f = fixture();
    const local = path.join(f.root, "clipboard.png");
    writeFileSync(local, png);
    const row = primary(local);
    writeFileSync(f.file, JSON.stringify(row) + "\n");
    const images = new SessionImages();
    const [image] = images.register("scope", 0, Buffer.from(JSON.stringify(row)), row, "codex");
    expect(image!.name).toBe("clipboard.png");
    expect(JSON.stringify(image)).not.toContain(f.root);
    expect(images.read("scope", f.file, image!.id).base64).toBe(png.toString("base64"));
    renameSync(local, local + ".old");
    writeFileSync(local, png);
    expect(() => images.read("scope", f.file, image!.id)).toThrow("session-image-changed");
    rmSync(local);
    symlinkSync(local + ".old", local);
    expect(() => images.read("scope", f.file, image!.id)).toThrow("session-image-unavailable");
  });
  it("rejects missing local files and images larger than 8 MiB", () => {
    const missing = registered(primary("missing.png"));
    expect(() => missing.images.read("scope", missing.file, missing.metadata[0]!.id)).toThrow(
      "session-image-unavailable",
    );
    const f = fixture();
    const local = path.join(f.root, "large.png");
    writeFileSync(local, Buffer.concat([png, Buffer.alloc(MAX_SESSION_IMAGE_BYTES)]));
    const row = primary(local);
    writeFileSync(f.file, JSON.stringify(row) + "\n");
    const images = new SessionImages();
    const [image] = images.register("scope", 0, Buffer.from(JSON.stringify(row)), row, "codex");
    expect(() => images.read("scope", f.file, image!.id)).toThrow("session-image-too-large");
  });
});

describe("paged native media", () => {
  it("renders image-only Codex messages and merges complete mirrored image lists", () => {
    const f = fixture();
    const local = path.join(f.root, "clipboard.png");
    writeFileSync(local, png);
    writeFileSync(
      f.file,
      [response(undefined, ""), primary(local, "")].map(JSON.stringify).join("\n") + "\n",
    );
    const paging = new SessionPaging();
    const first = paging.read(f.file, null, 1, "codex");
    expect(first.events).toHaveLength(1);
    expect(first.events[0]!.images).toHaveLength(1);
    expect(first.events[0]!.images![0]).toMatchObject({
      name: "clipboard.png",
      mimeType: "image/png",
    });
    expect(first.events[0]!.attachment_count).toBe(1);
    expect(paging.read(f.file, null, 1, "codex").events).toEqual(first.events);
    expect(paging.image(f.file, first.events[0]!.images![0]!.id).base64).toBe(
      png.toString("base64"),
    );
    appendFileSync(f.file, JSON.stringify(response([], "Newer")) + "\n");
    expect(paging.image(f.file, first.events[0]!.images![0]!.id).base64).toBe(
      png.toString("base64"),
    );
  });
  it.each(["user", "assistant"])("preserves Claude %s image-only content", (type) => {
    const f = fixture([
      {
        type,
        uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        message: {
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: png.toString("base64") },
            },
          ],
        },
      },
    ]);
    const paging = new SessionPaging();
    const page = paging.read(f.file, null, 50, "claude-code");
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.images).toHaveLength(1);
    expect(page.events[0]!.content).toBe("");
    expect(paging.image(f.file, page.events[0]!.images![0]!.id).mimeType).toBe("image/png");
  });
  it("reads an 8 MiB inline image beyond the normal 4 MiB line budget without paging the bytes", () => {
    const bytes = Buffer.alloc(MAX_SESSION_IMAGE_BYTES);
    png.copy(bytes);
    const f = fixture([response([{ type: "input_image", image_url: uri(bytes) }])]);
    const paging = new SessionPaging();
    const page = paging.read(f.file, null, 50, "codex");
    expect(page.warnings).not.toContain("TRANSCRIPT_OVERSIZED_LINES");
    expect(JSON.stringify(page).length).toBeLessThan(1024);
    expect(paging.image(f.file, page.events[0]!.images![0]!.id).base64).toBe(
      bytes.toString("base64"),
    );
  });
  it("keeps the text-record and dedicated media-record bounds", () => {
    const text = fixture([response([], "x".repeat(5 * 1024 * 1024))]);
    const oversized = fixture([
      response([{ type: "input_image", image_url: uri(Buffer.alloc(10 * 1024 * 1024)) }]),
    ]);
    for (const f of [text, oversized]) {
      const page = new SessionPaging().read(f.file, null, 50, "codex");
      expect(page.events).toEqual([]);
      expect(page.warnings).toContain("TRANSCRIPT_OVERSIZED_LINES");
    }
  });
  it("retains original media offsets when reading a compressed Codex rollout", async () => {
    const f = fixture();
    const file = f.file + ".zst";
    writeFileSync(file, zstdCompressSync(Buffer.from(JSON.stringify(response()) + "\n")));
    const plain = await codexRollouts.plain(file);
    const paging = new SessionPaging();
    const page = paging.read(plain, null, 50, "codex", {}, true, "verified-native");
    expect(
      paging.image(
        await codexRollouts.plain(file),
        page.events[0]!.images![0]!.id,
        "verified-native",
      ).base64,
    ).toBe(png.toString("base64"));
  });
});

describe("connected managed image matching", () => {
  const event = (id: string, turn: string, text = id, images = false): ConversationEvent => ({
    id,
    kind: "user-message",
    turn_id: turn,
    timestamp: null,
    content: text,
    tool_name: null,
    tool_status: null,
    duration_ms: null,
    attachment_count: images ? 1 : 0,
    truncated: false,
    ...(images ? { images: [{ id: "opaque-image" }] } : {}),
  });
  it("finds an older target beyond the first native page while retaining ledger identity", async () => {
    const target = event("ledger-item", "old-turn", "Picture");
    const read = vi.fn(async (cursor: string | null) => ({
      events: cursor
        ? [event("native-item", "old-turn", "Picture", true)]
        : Array.from({ length: 100 }, (_, index) => event(`recent-${index}`, "recent")),
      next_cursor: cursor ? null : "older",
      warnings: [],
    }));
    const page = await enrichLedgerImages(
      { events: [{ ...target }], next_cursor: "ledger-cursor", warnings: [] },
      read,
    );
    expect(read).toHaveBeenCalledTimes(2);
    expect(page.events[0]).toMatchObject({ id: "ledger-item", images: [{ id: "opaque-image" }] });
    expect(page.next_cursor).toBe("ledger-cursor");
  });
  it("never guesses duplicate text, or returns a partially verified turn", async () => {
    const target = event("ledger", "turn", "Same");
    const ambiguous = await enrichLedgerImages(
      { events: [{ ...target }], next_cursor: null, warnings: [] },
      async () => ({
        events: [event("a", "turn", "Same", true), event("b", "turn", "Same", true)],
        next_cursor: null,
        warnings: [],
      }),
    );
    expect(ambiguous.events[0]!.images).toBeUndefined();
    const limited = await enrichLedgerImages(
      { events: [{ ...target }], next_cursor: null, warnings: [] },
      async (_cursor, budget) => {
        budget.remainingBytes = 0;
        return { events: [event("a", "turn", "Same", true)], next_cursor: "older", warnings: [] };
      },
    );
    expect(limited.events[0]!.images).toBeUndefined();
    expect(limited.warnings).toContain("SESSION_IMAGES_SCAN_BUDGET");
  });
});
