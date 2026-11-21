// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WebClient,
  type ConversationClientBridge,
  type HistoryLocatedRecord,
  type HistorySearchStatus,
} from "@agentkib/web-client";
import { EmbeddedConversation, type EmbeddedConversationHandle } from "../../conversation";
import { historyCopy } from "@agentkib/session-ui";
import { codexCopy } from "../sessions/codex-copy";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
const c = historyCopy["en-US"];
const status: HistorySearchStatus = {
  enabled: true,
  generation: "index",
  bytes: 0,
  limitBytes: 10000,
  budgetExceeded: false,
  coverage: {
    total: 1,
    ready: 1,
    building: 0,
    partial: 0,
    stale: 0,
    unavailable: 0,
    limitations: [],
  },
};
function fixture(sourceId = "second") {
  const grant = { scope: "scope" };
  const requests: { path: string; body?: unknown }[] = [];
  const upload = vi.fn<ConversationClientBridge["uploadAttachment"]>().mockResolvedValue({
    id: "uploaded-note",
    name: "draft-note.txt",
    mime: "text/plain",
    size: 15,
    version: "upload-version",
  });
  const source: HistoryLocatedRecord = {
    location: {
      sessionId: sourceId,
      recordId: "record",
      chunkId: "chunk",
      sourceRevision: "revision",
    },
    workspaceId: "workspace",
    agent: "claude-code",
    title: "Source history",
    timestamp: null,
    kind: "assistant",
    toolName: null,
    content: "needle source excerpt",
    contentHash: "hash",
    before: null,
    after: null,
  };
  const live = (sessionId: string) => ({
    sessionId,
    status: "idle",
    revision: 1,
    sendEnabled: true,
    approvals: [],
    questions: [],
  });
  const bridge: ConversationClientBridge = {
    async request<Result>(path: string, body?: unknown) {
      requests.push({ path, body });
      const operation = path.split("?")[0];
      const id = new URLSearchParams(path.split("?")[1]).get("sessionId") ?? "";
      let value: unknown;
      if (operation === "access")
        value = {
          protocolVersion: 2,
          status: "approved",
          csrfToken: "test",
          bootId: "boot",
          experimentalEnabled: true,
          historySearch: true,
          historySearchScope: grant.scope,
          device: {
            id: "local",
            name: "Test",
            send: true,
            approve: true,
            manage: true,
            attachments: true,
          },
        };
      else if (operation === "catalog")
        value = {
          indexEnabled: true,
          workspaces: [{ id: "workspace", name: "Workspace", path: "/workspace" }],
          sessions: ["first", "second"].map((sessionId) => ({
            id: sessionId,
            workspace_id: "workspace",
            agent: "claude-code",
            availability: "readable",
            archived: false,
            sidechain: false,
            origin: "interactive",
          })),
        };
      else if (operation === "events")
        value = {
          events: [
            {
              id: id + "-event",
              kind: "agent-message",
              content: id + " history",
              attachment_count: 0,
              truncated: false,
            },
          ],
          warnings: [],
        };
      else if (operation === "live") value = live(id);
      else if (operation === "history/status") value = status;
      else if (operation === "history/search")
        value = {
          status,
          hits: [{ ...source, snippet: source.content, matchRanges: [], stale: false }],
          nextCursor: null,
          limited: false,
        };
      else if (operation === "history/locate") value = source;
      else if (operation === "history/references")
        value = {
          references: [{ ...source, reference: (body as { references: unknown[] }).references[0] }],
          text: source.content,
        };
      else if (operation === "managed/options")
        value = {
          available: true,
          workspaces: [{ id: "workspace", name: "Workspace" }],
          models: [],
        };
      else if (operation === "codex/capabilities" || operation === "managed/capabilities")
        value = {
          sessionId: id,
          executionMode: operation === "managed/capabilities" ? "claude-managed" : "codex-managed",
          status: "idle",
          features: {
            archive: { available: true },
            attachments: { available: true },
          },
        };
      else if (operation === "codex/queue") value = { sessionId: id, data: [] };
      else value = { available: false };
      return value as Result;
    },
    stream(id, handlers) {
      let closed = false;
      queueMicrotask(() => {
        if (closed) return;
        handlers.open();
        if (id)
          handlers.event(
            "session-event",
            JSON.stringify({
              protocolVersion: 2,
              subscriptionId: id,
              sessionId: id,
              runtimeBootId: "runtime",
              epoch: "epoch",
              seq: 0,
              cursor: "cursor",
              type: "snapshot",
              payload: { live: live(id) },
            }),
          );
      });
      return () => {
        closed = true;
      };
    },
    uploadAttachment: upload,
  };
  const changed = vi.fn();
  const client = new WebClient(undefined, { type: "same-origin" }, bridge);
  return { changed, client, grant, upload, requests };
}
async function renderConversation(sourceId?: string) {
  const f = fixture(sourceId);
  const controlsRef = createRef<EmbeddedConversationHandle>();
  render(
    <EmbeddedConversation
      controlsRef={controlsRef}
      client={f.client}
      sessionId="first"
      locale="en-US"
      onSessionChange={f.changed}
    />,
  );
  await screen.findByText("first history");
  fireEvent.change(screen.getByRole("textbox", { name: "Send a message" }), {
    target: { value: "Keep my draft" },
  });
  return { ...f, openSearch: () => act(() => controlsRef.current?.openPanel("search")) };
}
async function openSource(openSearch: () => void) {
  openSearch();
  await screen.findByRole("dialog", { name: c.title });
  fireEvent.change(screen.getByRole("textbox", { name: c.query }), { target: { value: "needle" } });
  fireEvent.click(await screen.findByRole("button", { name: /Source history/ }, { timeout: 3000 }));
  await screen.findByRole("region", { name: c.source });
}
async function renderUploadedDraft() {
  const f = await renderConversation();
  const input = screen.getByRole("textbox", { name: "Send a message" });
  const file = new File(["Attachment text"], "draft-note.txt", { type: "text/plain" });
  const uploadInput = screen.getByLabelText(codexCopy["en-US"].attachment);
  expect(uploadInput).toHaveAttribute("type", "file");
  await waitFor(() => expect(uploadInput).toBeEnabled());
  fireEvent.change(uploadInput, { target: { files: [file] } });
  await waitFor(() => expect(screen.getByText(file.name).closest("li")).toHaveTextContent("100%"));
  expect(f.upload).toHaveBeenCalledExactlyOnceWith(
    "first",
    file,
    expect.any(Function),
    expect.any(AbortSignal),
  );
  expect(f.upload.mock.calls[0][1]).toBe(file);
  const attachmentRow = screen.getByText(file.name).closest("li")!;
  await openSource(f.openSearch);
  fireEvent.click(screen.getByRole("button", { name: c.quote }));
  await screen.findByText(c.added);
  fireEvent.click(screen.getByRole("button", { name: c.close }));
  const references = screen.getByRole("region", { name: c.references });
  expect(references).toHaveTextContent("needle source excerpt");
  expect(input).toHaveValue("Keep my draft");
  return { ...f, input, file, attachmentRow, references };
}
describe("history search conversation navigation", () => {
  it("references source content while preserving the real selected conversation and composer draft", async () => {
    const f = await renderConversation();
    await openSource(f.openSearch);
    fireEvent.click(screen.getByRole("button", { name: c.quote }));
    await screen.findByText(c.added);
    fireEvent.click(screen.getByRole("button", { name: c.close }));
    expect(screen.getByRole("textbox", { name: "Send a message" })).toHaveValue("Keep my draft");
    expect(screen.getByText("first history")).toBeVisible();
    expect(screen.getByRole("region", { name: c.references })).toHaveTextContent(
      "needle source excerpt",
    );
    expect(f.changed).not.toHaveBeenCalled();
  });
  it("cancels cross-session opening without losing the real draft", async () => {
    const f = await renderConversation();
    await openSource(f.openSearch);
    fireEvent.click(screen.getByRole("button", { name: c.openSession }));
    fireEvent.click(await screen.findByRole("button", { name: c.openCancel }));
    fireEvent.click(screen.getByRole("button", { name: c.close }));
    expect(screen.getByRole("textbox", { name: "Send a message" })).toHaveValue("Keep my draft");
    expect(f.changed).not.toHaveBeenCalled();
  });
  it("opens a different source through the existing router only after confirmation", async () => {
    const f = await renderConversation();
    await openSource(f.openSearch);
    fireEvent.click(screen.getByRole("button", { name: c.openSession }));
    const confirm = await screen.findByRole("button", { name: c.openDiscard });
    expect(f.changed).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    await screen.findByText("second history");
    await waitFor(() => expect(f.changed).toHaveBeenCalledWith("second"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Send a message" })).toHaveValue("");
  });
  it("keeps an uploaded File, draft and reference when cross-session opening is cancelled", async () => {
    const f = await renderUploadedDraft();
    await openSource(f.openSearch);
    fireEvent.click(screen.getByRole("button", { name: c.openSession }));
    fireEvent.click(await screen.findByRole("button", { name: c.openCancel }));
    fireEvent.click(screen.getByRole("button", { name: c.close }));
    expect(screen.getByRole("textbox", { name: "Send a message" })).toBe(f.input);
    expect(f.input).toHaveValue("Keep my draft");
    expect(screen.getByRole("region", { name: c.references })).toBe(f.references);
    expect(f.references).toHaveTextContent("needle source excerpt");
    expect(screen.getByText(f.file.name).closest("li")).toBe(f.attachmentRow);
    expect(f.attachmentRow).toHaveTextContent("100%");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    expect(screen.getByText("first history")).toBeVisible();
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(f.requests.some(({ path }) => ["send", "attachments/delete"].includes(path))).toBe(
      false,
    );
  });
  it("clears the uploaded attachment, draft and reference only after confirmed source navigation", async () => {
    const f = await renderUploadedDraft();
    await openSource(f.openSearch);
    fireEvent.click(screen.getByRole("button", { name: c.openSession }));
    const confirm = await screen.findByRole("button", { name: c.openDiscard });
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.input).toHaveValue("Keep my draft");
    expect(f.attachmentRow).toHaveTextContent("100%");
    expect(f.references).toHaveTextContent("needle source excerpt");
    fireEvent.click(confirm);
    await screen.findByText("second history");
    await waitFor(() => expect(f.changed).toHaveBeenCalledExactlyOnceWith("second"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Send a message" })).not.toBe(f.input);
    expect(screen.getByRole("textbox", { name: "Send a message" })).toHaveValue("");
    expect(f.input).not.toBeInTheDocument();
    expect(f.attachmentRow).not.toBeInTheDocument();
    expect(f.references).not.toBeInTheDocument();
    expect(screen.queryByText(f.file.name)).toBeNull();
    expect(screen.queryByRole("region", { name: c.references })).toBeNull();
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(f.requests.some(({ path }) => ["send", "attachments/delete"].includes(path))).toBe(
      false,
    );
  });
  it("opens the current source without clearing the real draft", async () => {
    const f = await renderConversation("first");
    await openSource(f.openSearch);
    fireEvent.click(screen.getByRole("button", { name: c.openSession }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("textbox", { name: "Send a message" })).toHaveValue("Keep my draft");
    expect(f.changed).not.toHaveBeenCalled();
  });
});
