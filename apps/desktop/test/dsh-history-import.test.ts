// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareDshHistoryDocument } from "../../../packages/backend/src/agents/dsh/history-import";
import { readCodexDocument } from "../../../packages/backend/src/session-document-providers";
import {
  historyImportServices,
  historyImportWorkspace,
  importDshHistory,
} from "../../../packages/dsh-bridge-plugin/history-import.js";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP49cABAATyAhudsmHgAAAAAElFTkSuQmCC";
type StoredEvent = { type: string; data: unknown };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "ak-dsh-import-")));
  roots.push(cwd);
  const id = randomUUID();
  const history = new Map<string, { header: Record<string, unknown>; events: StoredEvent[] }>();
  const savedImages = new Map<string, Uint8Array>();
  const workspace = {
    id: "native-workspace",
    path: cwd,
    sessionIds: [] as string[],
    attachSession: vi.fn(async (id: string) => {
      if (!history.get(id)?.events.length) throw new Error("missing history");
      workspace.sessionIds.push(id);
    }),
  };
  const writer = {
    create: vi.fn(async (header: Record<string, unknown> & { id: string }) => {
      if (history.has(header.id)) throw new Error("existing history");
      return {
        append: async (events: StoredEvent[]) => {
          history.set(header.id, { header, events: structuredClone(events) });
        },
        flush: async () => {},
        close: async () => {},
      };
    }),
    open: async (id: string) => {
      const stored = history.get(id)!;
      return {
        header: stored.header,
        inheritedEventCount: 0,
        read: async (_offset: number, length: number) => ({
          events: structuredClone(stored.events.slice(0, length)),
        }),
        close: async () => {},
      };
    },
    stat: async (id: string) => history.get(id),
  };
  const context = {
    sessionPersistence: writer,
    workspaceRegistry: { list: () => [workspace], archivedSessionIds: [] as string[] },
    sessions: {
      prepare: vi.fn((id: string, options: { seed: unknown[]; meta: object }) => ({
        header: { ...options.meta, id, version: 4 },
      })),
    },
    attachments: {
      saveImage: vi.fn(
        async ({
          data,
          mediaType,
          name,
        }: {
          data: Uint8Array;
          mediaType: string;
          name: string;
        }) => {
          const attachmentId = `sha256:${createHash("sha256").update(data).digest("hex")}`;
          savedImages.set(attachmentId, data);
          return { attachmentId, mediaType, bytes: data.length, width: 1, height: 1, name };
        },
      ),
      readImage: vi.fn(async ({ attachmentId }: { attachmentId: string }) => {
        if (!savedImages.has(attachmentId)) throw new Error("missing image");
      }),
    },
  };
  const service = (name: string) => context[name as keyof typeof context];
  const services = historyImportServices(service, "0.2.2-rc.5")!;
  const request = {
    sessionId: id,
    workspaceId: workspace.id,
    cwd,
    document: {
      schema_version: 1,
      source: { agent: "codex", title: "Reviewed project", created_at: "2026-11-05T12:00:00Z" },
      turns: [
        {
          role: "user",
          timestamp: "2026-11-05T12:01:00Z",
          blocks: [
            { type: "text", text: "Original user text" },
            {
              type: "attachment",
              kind: "image",
              media_type: "image/png",
              inline_base64: png,
              filename: "pixel.png",
            },
            { type: "attachment", kind: "document", media_type: "application/pdf" },
          ],
        },
        {
          role: "assistant",
          blocks: [
            { type: "text", text: "Original assistant text" },
            { type: "tool-call", name: "HistoricalSearch", input: "private args" },
          ],
        },
        {
          role: "tool",
          blocks: [{ type: "tool-result", is_error: true, output: "private output" }],
        },
        { role: "user", blocks: [{ type: "text", text: "Follow-up text" }] },
        { role: "assistant", blocks: [{ type: "text", text: "Final answer" }] },
      ],
    },
  };
  const send = (fields: Record<string, unknown> = {}) =>
    importDshHistory(services, { ...request, ...fields }, new AbortController().signal);
  return { id, service, context, workspace, request, history, savedImages, send };
}

describe("DSH native history import", () => {
  it("keeps native chat roles and saved image references and stores only historical summaries", async () => {
    const f = fixture();
    expect(historyImportServices(f.service, "0.2.2-rc.3")).toBeNull();
    expect(await historyImportWorkspace(f.context.workspaceRegistry, f.request.cwd)).toBe(
      f.workspace,
    );
    expect(await f.send()).toEqual({ sessionId: f.id, imported: true });
    expect(f.context.sessions.prepare).toHaveBeenCalledTimes(1);
    expect(f.context.attachments.saveImage).toHaveBeenCalledExactlyOnceWith({
      data: Buffer.from(png, "base64"),
      mediaType: "image/png",
      name: "pixel.png",
    });
    const stored = f.history.get(f.id)!;
    const text = JSON.stringify(stored.events);
    expect(text).toContain("Original user text");
    expect(text).toContain("Original assistant text");
    expect(text).toContain("Final answer");
    expect(text).toContain("HistoricalSearch; arguments omitted");
    expect(text).toContain("Historical tool result (error); output omitted");
    expect(text).not.toContain("private args");
    expect(text).not.toContain("private output");
    expect(stored.events).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "tool/call" })]),
    );
    expect(stored.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "user/message",
          data: expect.objectContaining({
            content: [
              { type: "text", text: "Original user text" },
              {
                type: "image",
                attachment: expect.objectContaining({
                  attachmentId: expect.stringMatching(/^sha256:/),
                  name: "pixel.png",
                }),
              },
              { type: "text", text: "[Historical attachment omitted]" },
            ],
          }),
        }),
        expect.objectContaining({
          type: "assistant/message",
          data: expect.objectContaining({
            message: expect.objectContaining({
              role: "assistant",
              source: { kind: "model", provider: "agentkib-import", model: "agentkib-import" },
            }),
          }),
        }),
      ]),
    );
    expect(f.workspace.sessionIds).toEqual([f.id]);
    expect(await f.send({ verifyOnly: true })).toEqual({ sessionId: f.id, imported: true });
    expect(f.context.sessionPersistence.create).toHaveBeenCalledTimes(1);
    expect(f.context.attachments.saveImage).toHaveBeenCalledTimes(1);
    expect(f.workspace.attachSession).toHaveBeenCalledTimes(1);
    f.savedImages.clear();
    await expect(f.send({ verifyOnly: true })).rejects.toThrow("missing image");
  });

  it("imports text and images from one Codex record in the same DSH turn", async () => {
    const f = fixture();
    const timestamp = "2026-11-05T12:01:00Z";
    const message = (role: string, content: object[]) => ({
      type: "response_item",
      timestamp,
      payload: { type: "message", role, content },
    });
    const image = { type: "input_image", image_url: `data:image/png;base64,${png}` };
    const rows = [
      message("user", [{ type: "input_text", text: "Actually unanswered" }]),
      message("user", [{ type: "input_text", text: "Describe this pixel" }, image]),
      message("assistant", [{ type: "output_text", text: "A blue pixel" }]),
      message("user", [image]),
      message("assistant", [{ type: "output_text", text: "Another blue pixel" }]),
    ];
    const file = path.join(f.request.cwd, "codex-history.jsonl");
    writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const source = readCodexDocument(
      {
        agent: "codex",
        workspace_id: f.workspace.id,
        title: "Codex image history",
        created_at: timestamp,
        updated_at: timestamp,
        git_branch: null,
      },
      file,
    );

    const document = prepareDshHistoryDocument(source);
    expect(await f.send({ document })).toEqual({ sessionId: f.id, imported: true });
    const events = f.history.get(f.id)!.events;
    expect(events.filter((event) => event.type === "turn/end").map((event) => event.data)).toEqual([
      {
        turn: 1,
        reason: {
          kind: "error",
          error: expect.objectContaining({ code: "AGENTKIB_IMPORT_NO_REPLY" }),
        },
      },
      { turn: 2, reason: { kind: "completed" } },
      { turn: 3, reason: { kind: "completed" } },
    ]);
    const messages = events.filter((event) => event.type === "user/message").slice(1);
    const savedImage = {
      type: "image",
      attachment: expect.objectContaining({ attachmentId: expect.stringMatching(/^sha256:/) }),
    };
    expect(messages.map((event) => event.data)).toMatchObject([
      { content: [{ type: "text", text: "Actually unanswered" }] },
      { content: [{ type: "text", text: "Describe this pixel" }, savedImage] },
      { content: [savedImage] },
    ]);
    expect(await f.send({ document, verifyOnly: true })).toEqual({
      sessionId: f.id,
      imported: true,
    });
  });

  it("will not create during reconciliation and can attach a verified prior write", async () => {
    const f = fixture();
    expect(await f.send({ verifyOnly: true })).toEqual({ sessionId: f.id, imported: false });
    expect(f.context.sessionPersistence.create).not.toHaveBeenCalled();
    expect(f.context.attachments.saveImage).not.toHaveBeenCalled();
    f.workspace.attachSession.mockRejectedValueOnce(new Error("native workspace changed"));
    await expect(f.send()).rejects.toThrow("native workspace changed");
    expect(f.workspace.sessionIds).toEqual([]);
    await expect(f.send({ workspaceId: "not-authorized", verifyOnly: true })).rejects.toThrow(
      "workspace-unavailable",
    );
    expect(await f.send({ verifyOnly: true })).toEqual({ sessionId: f.id, imported: true });
    expect(f.context.sessionPersistence.create).toHaveBeenCalledTimes(1);
    expect(f.context.attachments.saveImage).toHaveBeenCalledTimes(1);
    expect(f.workspace.sessionIds).toEqual([f.id]);
    const revised = {
      ...f.request.document,
      source: { ...f.request.document.source, title: "Different" },
    };
    await expect(f.send({ document: revised })).rejects.toThrow("import-conflict");
    expect(f.context.sessionPersistence.create).toHaveBeenCalledTimes(1);
  });
});
