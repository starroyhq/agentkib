import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FormEvent } from "react";
import { WebClient, type Access } from "@agentkib/web-client";
import { useSessionController } from "@/features/conversation/web-session-controller";
import { pairingErrorCopy, pairingErrorText } from "./pairing-error-copy";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fixture(lan = false) {
  let access: Access = {
    status: "unpaired",
    pairingMode: "code",
    csrfToken: "csrf",
    bootId: "boot",
    experimentalEnabled: false,
    ...(lan ? { bearerToken: "pairing-test-browser" } : {}),
  };
  const pairResponse = vi.fn<() => Promise<Response>>().mockResolvedValue(json({ ok: true }));
  const readAccess = vi.fn(async () => json(access));
  const transport = vi.fn<typeof fetch>(async (input) => {
    const path = String(input).split("/api/web/v1/")[1];
    if (path === "info")
      return json({
        protocolVersion: 1,
        conversationProtocolVersion: 2,
        transport: "lan",
        capabilities: { read: true, send: true, approve: true },
      });
    if (path === "access") return readAccess();
    if (path === "pair") return pairResponse();
    if (path === "catalog") return json({ indexEnabled: true, sessions: [] });
    throw new Error(`Unexpected request: ${path}`);
  });
  const client = new WebClient(
    transport,
    lan ? { type: "lan-http", origin: "http://192.168.1.2:1421" } : { type: "same-origin" },
  );
  const view = renderHook(() => useSessionController({ client, embedded: true }));
  return {
    view,
    client,
    transport,
    pairResponse,
    readAccess,
    setStatus(status: Access["status"]) {
      access = { ...access, status };
    },
  };
}

async function ready(host: ReturnType<typeof fixture>) {
  await waitFor(() => expect(host.view.result.current.access?.status).toBe("unpaired"));
  act(() => {
    host.view.result.current.setCode("12345678");
    host.view.result.current.setName(" My browser ");
  });
}

function submit(host: ReturnType<typeof fixture>) {
  return host.view.result.current.pair({ preventDefault: vi.fn() } as unknown as FormEvent);
}

describe("pairing through the real session controller and HTTP client", () => {
  it.each([
    [403, "invalid_pairing_code"],
    [429, "device_limit"],
    [429, "pending_limit"],
    [429, "rate_limited"],
    [409, "already_paired"],
    [400, "invalid_input"],
    [403, "csrf_rejected"],
  ])("retains both fields and exposes the %s / %s rejection", async (status, code) => {
    const host = fixture();
    await ready(host);
    host.pairResponse.mockResolvedValue(json({ error: code }, status));

    await act(async () => submit(host));

    expect(host.view.result.current.code).toBe("12345678");
    expect(host.view.result.current.name).toBe(" My browser ");
    expect(host.view.result.current.pairingError).toBe(code);
    expect(host.view.result.current.error).toBe(false);
    expect(host.view.result.current.busy).toBe(false);
    const request = host.transport.mock.calls.find(([input]) => String(input).endsWith("/pair"));
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      code: "12345678",
      name: "My browser",
    });
  });

  it.each(["network", "unknown-code", "invalid-body"])(
    "provides a safe fallback for %s and preserves input",
    async (failure) => {
      const host = fixture();
      await ready(host);
      if (failure === "network")
        host.pairResponse.mockRejectedValue(new TypeError("Failed to fetch"));
      else
        host.pairResponse.mockResolvedValue(
          failure === "unknown-code"
            ? json({ code: "unexpected_server_error" }, 500)
            : new Response("private proxy details", { status: 502 }),
        );

      await act(async () => submit(host));

      expect(host.view.result.current.code).toBe("12345678");
      expect(host.view.result.current.name).toBe(" My browser ");
      expect(pairingErrorText("zh-CN", host.view.result.current.pairingError!)).toBe(
        pairingErrorCopy["zh-CN"].request_failed,
      );
      expect(host.view.result.current.busy).toBe(false);
    },
  );

  it("keeps fields during a delayed request, ignores repeat submissions and clears the code only after success", async () => {
    const host = fixture();
    await ready(host);
    const response = deferred<Response>();
    const access = deferred<Response>();
    host.pairResponse.mockReturnValue(response.promise);
    host.readAccess.mockReturnValue(access.promise);
    let request!: Promise<void>;

    act(() => {
      request = submit(host);
    });
    expect(host.view.result.current.busy).toBe(true);
    expect(host.view.result.current.code).toBe("12345678");
    await act(async () => submit(host));
    expect(host.pairResponse).toHaveBeenCalledOnce();
    expect(host.view.result.current.code).toBe("12345678");

    await act(async () => response.resolve(json({ pending: { id: "pending" } })));
    expect(host.view.result.current.code).toBe("");
    expect(host.view.result.current.name).toBe(" My browser ");
    expect(host.view.result.current.busy).toBe(true);
    await act(async () => {
      access.resolve(
        json({
          status: "pending",
          csrfToken: "csrf",
          bootId: "boot",
          experimentalEnabled: false,
        }),
      );
      await request;
    });
    expect(host.view.result.current.access?.status).toBe("pending");
    expect(host.view.result.current.busy).toBe(false);
    expect(host.view.result.current.pairingError).toBeUndefined();
  });

  it("supports retrying preserved input after rejection and clears only the accepted code", async () => {
    const host = fixture();
    await ready(host);
    host.pairResponse.mockResolvedValueOnce(json({ error: "rate_limited" }, 429));
    await act(async () => submit(host));
    expect(host.view.result.current.pairingError).toBe("rate_limited");
    host.setStatus("approved");

    await act(async () => submit(host));

    expect(host.pairResponse).toHaveBeenCalledTimes(2);
    expect(host.view.result.current.access?.status).toBe("approved");
    expect(host.view.result.current.code).toBe("");
    expect(host.view.result.current.name).toBe(" My browser ");
    expect(host.view.result.current.pairingError).toBeUndefined();
  });

  it("keeps an accepted code cleared when the following status read fails", async () => {
    const host = fixture();
    await ready(host);
    host.readAccess.mockRejectedValue(new TypeError("Failed to fetch"));

    await act(async () => submit(host));

    expect(host.view.result.current.code).toBe("");
    expect(host.view.result.current.pairingError).toBeUndefined();
    expect(host.view.result.current.error).toBe(true);
    expect(host.view.result.current.busy).toBe(false);
  });

  it("clears the pairing error during a manual reconnect without losing the input", async () => {
    const host = fixture();
    await ready(host);
    host.pairResponse.mockResolvedValue(json({ error: "csrf_rejected" }, 403));
    await act(async () => submit(host));

    await act(async () => host.view.result.current.refresh(true));

    expect(host.view.result.current.pairingError).toBeUndefined();
    expect(host.view.result.current.code).toBe("12345678");
    expect(host.view.result.current.name).toBe(" My browser ");
  });

  it.each([false, true])("preserves access-ended handling for LAN=%s", async (lan) => {
    const host = fixture(lan);
    await ready(host);
    const reset = vi.spyOn(host.client, "reset");
    host.pairResponse.mockResolvedValue(json({ error: "access_ended" }, 401));

    await act(async () => submit(host));

    expect(host.view.result.current.access?.status).toBe("ended");
    expect(host.view.result.current.pairingError).toBeUndefined();
    expect(reset).toHaveBeenCalledTimes(lan ? 1 : 0);
  });

  it("preserves protocol incompatibility handling", async () => {
    const host = fixture();
    await ready(host);
    host.pairResponse.mockResolvedValue(json({ code: "incompatible_protocol" }, 409));

    await act(async () => submit(host));

    expect(host.view.result.current.incompatible).toBe(true);
    expect(host.view.result.current.error).toBe(true);
    expect(host.view.result.current.code).toBe("12345678");
    expect(host.view.result.current.pairingError).toBeUndefined();
  });
});
