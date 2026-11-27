// @vitest-environment node
import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sessionAttachmentMarkdown } from "@agentkib/runtime-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationEvent } from "../../../packages/backend/src/session-events";
import { sanitizeSessionText } from "../../../packages/backend/src/session-handoff";
import { MAX_SESSION_IMAGE_BYTES } from "../../../packages/backend/src/session-images";
import { SessionSentAttachments } from "../../../packages/backend/src/session-sent-attachments";
import { AttachmentStore } from "../electron/main/web/attachments";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHxoAAAAASUVORK5CYII=";
const png = Buffer.from(PNG, "base64");

function event(
  content: string,
  kind: ConversationEvent["kind"] = "user-message",
): ConversationEvent {
  return {
    id: "message",
    kind,
    timestamp: null,
    content,
    attachment_count: 0,
    tool_name: null,
    tool_status: null,
    duration_ms: null,
    truncated: false,
  };
}

function fileIn(line: string): string {
  return fileURLToPath(line.slice(line.lastIndexOf("](file:") + 2, -1));
}

describe("sent message attachment projection", () => {
  let root: string;
  let workspace: string;
  let store: AttachmentStore;
  let reader: SessionSentAttachments;
  const sessionId = "native-turn-session";

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "ak-sent-attachments-")));
    workspace = path.join(root, "workspace");
    await mkdir(workspace);
    store = new AttachmentStore(path.join(root, "attachments"));
    reader = new SessionSentAttachments(root, {});
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function upload(name: string, mime: string, bytes: Buffer, session = sessionId) {
    const owner = { deviceId: "desktop", sessionId: session };
    return store.upload(
      (async function* () {
        yield bytes;
      })(),
      owner,
      name,
      mime,
      () => {},
    );
  }
  function read(imageId: string, session = sessionId) {
    return reader.image({ operation: "session-image", sessionId: session, imageId });
  }

  it("projects a terminal upload the same way in pages, live snapshots and individual items", async () => {
    const image = await upload("screenshot.png", "image/png", png);
    const input = await store.inputForTerminal(
      "desktop",
      sessionId,
      [image.id],
      "Check this",
      workspace,
      "request-one",
    );
    const message = event(input.text);
    const projected = reader.project(sessionId, { events: [message] }).events[0]!;
    expect(projected).toEqual({
      ...message,
      content: "Check this",
      attachment_count: 1,
      attachments: [
        {
          name: image.name,
          kind: "image",
          mimeType: "image/png",
          size: png.length,
          available: true,
          imageId: expect.stringMatching(/^sent-attachment-v1-/),
        },
      ],
    });
    expect(reader.project(sessionId, { items: [message] }).items[0]).toEqual(projected);
    expect(reader.project(sessionId, message)).toEqual(projected);
    const imageId = projected.attachments![0]!.imageId!;
    expect(read(imageId)).toEqual({ mimeType: "image/png", base64: PNG });
    expect(() => read(imageId, "another-session")).toThrow("session-image-unavailable");
    const copyFile = fileIn(input.text.split("\n").at(-1)!);
    await unlink(copyFile);
    expect(reader.project(sessionId, message).attachments).toEqual([
      {
        name: image.name,
        kind: "image",
        mimeType: "image/png",
        size: png.length,
        available: false,
      },
    ]);
    expect(() => read(imageId)).toThrow("session-image-unavailable");
  });

  it("projects multiple exact lines inside a redacted body, preserving the surrounding text", async () => {
    vi.stubEnv("HOME", root);
    vi.stubEnv("USERPROFILE", root);
    const first = await upload("notes [today].txt", "text/plain", Buffer.from("notes"));
    const second = await upload("screenshot.png", "image/png", png);
    const input = await store.inputForTerminal(
      "desktop",
      sessionId,
      [first.id, second.id],
      "",
      workspace,
      "request-two",
    );
    const [firstLine, secondLine] = input.text.split("\n\n");
    const body = sanitizeSessionText(`before\n${firstLine}\n${secondLine}\nafter`, { value: 0 });
    const item = reader.project(sessionId, event(body));
    expect(item.content).toBe("before\nafter");
    expect(item.attachments).toEqual([
      { name: first.name, kind: "file", mimeType: "text/plain", size: first.size, available: true },
      {
        name: second.name,
        kind: "image",
        mimeType: "image/png",
        size: second.size,
        available: true,
        imageId: expect.any(String),
      },
    ]);
  });

  it("leaves incomplete and unproven attachment lines as ordinary text", async () => {
    const genuine = await upload("image.png", "image/png", png);
    const input = await store.inputForTerminal(
      "desktop",
      sessionId,
      [genuine.id],
      "",
      workspace,
      "request-three",
    );
    const outside = path.join(workspace, "other.png");
    const inventedDirectory = path.join(workspace, ".agentkib-attachment-" + randomUUID());
    await mkdir(inventedDirectory);
    await writeFile(outside, png);
    await writeFile(path.join(inventedDirectory, genuine.id + ".png"), png);
    const waiting = await upload("draft.png", "image/png", png);
    const target = pathToFileURL(fileIn(input.text)).href;
    for (const body of [
      "User attached file image.png",
      sessionAttachmentMarkdown(genuine.name, pathToFileURL(outside).href),
      sessionAttachmentMarkdown(
        genuine.name,
        pathToFileURL(path.join(inventedDirectory, genuine.id + ".png")).href,
      ),
      sessionAttachmentMarkdown(
        genuine.name,
        target.replace("/" + genuine.id, "/other/../" + genuine.id),
      ),
      sessionAttachmentMarkdown("different.png", target),
      sessionAttachmentMarkdown(
        waiting.name,
        pathToFileURL(path.join(root, "attachments", waiting.id)).href,
      ),
    ])
      expect(reader.project(sessionId, event(body))).toEqual(event(body));
    expect(reader.project("another-session", event(input.text))).toEqual(event(input.text));
    expect(reader.project(sessionId, event(input.text, "agent-message"))).toEqual(
      event(input.text, "agent-message"),
    );
  });

  it("uses the host upload index for nonterminal sends and bounds image previews", async () => {
    const image = await upload(
      "oversize.png",
      "image/png",
      Buffer.alloc(MAX_SESSION_IMAGE_BYTES + 1),
    );
    const input = await store.input("desktop", sessionId, [image.id], "", "link");
    const projected = reader.project(sessionId, event(String(input[0]?.text)));
    expect(projected).toMatchObject({
      content: null,
      attachment_count: 1,
      attachments: [{ name: image.name, kind: "image", available: false, size: image.size }],
    });
    expect(projected.attachments![0]!.imageId).toBeUndefined();
  });

  it("recognizes a LAN host upload from the trusted desktop profile", async () => {
    const electron = path.join(root, "electron");
    store = new AttachmentStore(path.join(electron, "web-lan", "attachments"));
    reader = new SessionSentAttachments(root, {
      AGENTKIB_HOST_ATTACHMENTS_DIRS: JSON.stringify([path.join(electron, "web", "attachments")]),
    });
    const file = await upload("notes.txt", "text/plain", Buffer.from("notes"));
    const input = await store.input("desktop", sessionId, [file.id], "", "link");
    expect(reader.project(sessionId, event(String(input[0]?.text))).attachments).toEqual([
      { name: file.name, kind: "file", mimeType: "text/plain", size: file.size, available: true },
    ]);
  });
});
