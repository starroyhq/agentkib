// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WebClient,
  type ConversationClientBridge,
  type HistoryLocatedRecord,
  type HistorySearchStatus,
} from "@agentkib/web-client";
import { EmbeddedConversation } from "../../web-embedded-conversation";
import { historyCopy } from "@agentkib/session-ui";

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
function fixture(send: boolean) {
  const grant = { scope: "scope" };
  const source: HistoryLocatedRecord = {
    location: {
      sessionId: "second",
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
    async request<Result>(path: string) {
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
            send,
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
    uploadAttachment: vi.fn(),
  };
  const changed = vi.fn();
  const client = new WebClient(undefined, { type: "same-origin" }, bridge);
  return { changed, client };
}
async function renderConversation(send = true) {
  const f = fixture(send);
  render(
    <EmbeddedConversation
      client={f.client}
      sessionId="first"
      locale="en-US"
      onSessionChange={f.changed}
    />,
  );
  await screen.findByText("first history");
  if (send) {
    fireEvent.change(screen.getByRole("textbox", { name: "Send a message" }), {
      target: { value: "Keep my draft" },
    });
  }
  return f;
}
async function openSource() {
  const search = screen.getByRole("button", { name: c.title });
  expect(search).toHaveClass("size-11");
  expect(search).toHaveTextContent(/^$/);
  fireEvent.click(search);
  fireEvent.change(screen.getByRole("textbox", { name: c.query }), { target: { value: "needle" } });
  fireEvent.click(await screen.findByRole("button", { name: /Source history/ }, { timeout: 3000 }));
  await screen.findByRole("region", { name: c.source });
}
describe("history search Web workspace entry", () => {
  it("uses the touch search entry and Web router for a confirmed source", async () => {
    const f = await renderConversation();
    await openSource();
    fireEvent.click(screen.getByRole("button", { name: c.openSession }));
    const confirm = await screen.findByRole("button", { name: c.openDiscard });
    expect(f.changed).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    await screen.findByText("second history");
    await waitFor(() => expect(f.changed).toHaveBeenCalledWith("second"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Send a message" })).toHaveValue("");
  });

  it("keeps search and navigation available on a device without send permission", async () => {
    const f = await renderConversation(false);
    const requestReference = vi.spyOn(f.client, "historyReferences");
    await openSource();
    const quote = screen.getByRole("button", { name: c.quote });
    expect(quote).toBeDisabled();
    expect(quote).not.toHaveAttribute("title");
    expect(screen.queryByText(c.referenceSendPermission)).not.toBeInTheDocument();
    fireEvent.click(quote);
    expect(requestReference).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: c.openSession }));
    fireEvent.click(await screen.findByRole("button", { name: c.openDiscard }));
    await screen.findByText("second history");
    await waitFor(() => expect(f.changed).toHaveBeenCalledWith("second"));
  });
});
