import { describe, expect, it } from "vitest";
import { requireRemoteRequest } from "./remote-validation";

describe("remote IPC allowlist", () => {
  it("accepts fixed operations and bounded opaque event IDs", () => {
    expect(
      requireRemoteRequest({ operation: "read-state", id: "host", sessionId: "opaque" }),
    ).toEqual({ operation: "read-state", id: "host", sessionId: "opaque" });
    expect(
      requireRemoteRequest({
        operation: "read-state-update",
        id: "host",
        sessionId: "opaque",
        expectedVersion: "version",
        seenResultId: null,
      }),
    ).toMatchObject({ expectedVersion: "version", seenResultId: null });
    expect(requireRemoteRequest({ operation: "status" })).toEqual({ operation: "status" });
    expect(
      requireRemoteRequest({ operation: "events", id: "host", sessionId: "opaque", limit: 100 }),
    ).toMatchObject({ sessionId: "opaque", limit: 100 });
    expect(
      requireRemoteRequest({ operation: "pair", address: "192.168.1.9:39091", code: "01234567" }),
    ).toMatchObject({ code: "01234567" });
  });
  it.each([
    { operation: "read-state", id: "host", sessionId: "opaque", readerScope: "other" },
    { operation: "read-state-update", id: "host", sessionId: "opaque", expectedVersion: "version" },
    {
      operation: "read-state-update",
      id: "host",
      sessionId: "opaque",
      expectedVersion: "version",
      seenResultId: 1,
    },
    { operation: "workspace.scan" },
    { operation: "status", method: "shell.run" },
    { operation: "pair", address: "example.com:80", code: "12345678" },
    { operation: "pair", address: "192.168.1.2:0", code: "12345678" },
    { operation: "pair", address: "192.168.1.2:80", code: "1234" },
    { operation: "events", id: "host", sessionId: "session", path: "/private" },
    { operation: "events", id: "host", sessionId: "session", limit: 101 },
    { operation: "events", id: "host", sessionId: "session", cursor: "x".repeat(1025) },
  ])("rejects unsafe or unsupported request %j", (input) => {
    expect(() => requireRemoteRequest(input)).toThrow(TypeError);
  });
});
