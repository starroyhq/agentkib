import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { remoteReadStateClient } from "./remote-read-state";
import { parseRemoteCatalog, parseRemoteReadState } from "./remote-payload";
const readState = {
  source: "agentkib" as const,
  status: "unread" as const,
  freshness: "current" as const,
  version: "ledger:opaque",
  firstUnread: { type: "result" as const, resultId: "result", turnId: "turn" },
  latestResult: {
    id: "result",
    turnId: "turn",
    itemId: "answer",
    outcome: "failed" as const,
    completedAt: null,
  },
};
afterEach(() => vi.restoreAllMocks());
describe("desktop remote TLS read state", () => {
  it("keeps validated state in the remote catalog, strips forged provenance, and preserves unsupported absence", () => {
    const input = {
      workspaces: [{ id: "w", name: "Project", path: "/test" }],
      sessions: [
        {
          id: "s",
          workspace_id: "w",
          agent: "codex",
          archived: false,
          sidechain: false,
          availability: "readable",
          readState,
          remote: { host_id: "forged" },
        },
      ],
    };
    expect(parseRemoteCatalog(input).sessions[0]).toMatchObject({ readState });
    expect(parseRemoteCatalog(input).sessions[0].remote).toBeUndefined();
    expect(
      parseRemoteCatalog({ ...input, sessions: [{ ...input.sessions[0], readState: undefined }] })
        .sessions[0].readState,
    ).toBeUndefined();
    expect(() =>
      parseRemoteReadState({ readState: { ...readState, source: "unsupported" } }),
    ).toThrow("REMOTE_INVALID_RESPONSE");
    expect(() =>
      parseRemoteCatalog({
        ...input,
        sessions: [{ ...input.sessions[0], readState: { ...readState, version: 1 } }],
      }),
    ).toThrow("REMOTE_INVALID_RESPONSE");
  });
  it.each([
    { error: "REMOTE_DISCONNECTED", conflict: false },
    { error: "REMOTE_READ_STATE_CONFLICT_UNCONFIRMED", conflict: false },
    { error: "REMOTE_READ_STATE_CONFLICT", conflict: true },
    {
      error:
        "Error invoking remote method 'agentkib:remote:request': RuntimeRequestError: AgentKib command failed: REMOTE_READ_STATE_CONFLICT",
      conflict: true,
    },
  ])("reads back exactly once and distinguishes $error", async ({ error, conflict }) => {
    const request = vi
      .spyOn(api, "remoteRequest")
      .mockRejectedValueOnce(new Error(error))
      .mockResolvedValue({ readState } as never);
    const client = remoteReadStateClient("host-a", "native-session");
    expect(
      await client.acknowledgeReadState('remote:["host-a","native-session"]', "expected", "result"),
    ).toEqual({ readState, acknowledged: false, ...(conflict ? { conflict: true } : {}) });
    expect(request.mock.calls.map(([value]) => value)).toEqual([
      {
        operation: "read-state-update",
        id: "host-a",
        sessionId: "native-session",
        expectedVersion: "expected",
        seenResultId: "result",
      },
      { operation: "read-state", id: "host-a", sessionId: "native-session" },
    ]);
  });
  it("does not apply a late read after its connection generation is abandoned", async () => {
    let finish!: (value: never) => void;
    vi.spyOn(api, "remoteRequest").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const abort = new AbortController();
    const pending = remoteReadStateClient("host-old", "session").readState("session", abort.signal);
    abort.abort();
    finish({ readState } as never);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
