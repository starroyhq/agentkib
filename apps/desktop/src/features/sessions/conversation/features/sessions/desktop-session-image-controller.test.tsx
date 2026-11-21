// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  WebClient,
  type Access,
  type ConversationCatalog,
  type ConversationClientBridge,
} from "@agentkib/web-client";
import { clearMessageImageCache, messageImageCache, messageImageScope } from "@agentkib/session-ui";
import { useSessionController } from "./use-session-controller";
import {
  createSessionImageLoader,
  forgetSessionImages,
  restoreSessionImages,
  invalidateSessionImages,
} from "../../desktop-session-images";

const data = { mimeType: "image/png", base64: "iVBORw0KGgo=" };
const released = new Set<() => void>();
function fixture() {
  const state: {
    access: Access;
    catalog: ConversationCatalog;
    failure?: ApiError;
    accessGate?: Promise<Access>;
  } = {
    access: {
      status: "approved",
      protocolVersion: 2,
      csrfToken: "csrf",
      bootId: "boot",
      historySearchScope: "workspace-grant",
      experimentalEnabled: true,
      device: { id: "device", name: "Fixture", send: true, approve: true },
    },
    catalog: {
      indexEnabled: true,
      complete: true,
      workspaces: [{ id: "workspace", name: "Project", path: "/synthetic/project" }],
      sessions: [
        {
          id: "session",
          workspace_id: "workspace",
          agent: "claude-code",
          availability: "readable",
          archived: false,
          sidechain: false,
          title: "Conversation",
        },
      ],
    },
  };
  const streams = new Map<string, Parameters<ConversationClientBridge["stream"]>[1]>();
  const bridge: ConversationClientBridge = {
    request: async <Result,>(path: string) => {
      const operation = path.split("?")[0];
      let value: unknown;
      if (operation === "access") {
        if (state.accessGate) return (await state.accessGate) as Result;
        if (state.failure) throw state.failure;
        value = {
          ...state.access,
          device: state.access.device ? { ...state.access.device } : undefined,
        };
      } else if (operation === "catalog") value = state.catalog;
      else if (operation === "events")
        value = {
          events: [
            {
              id: "reply",
              kind: "agent-message",
              content: "Reply",
              attachment_count: 0,
              truncated: false,
            },
          ],
          warnings: [],
        };
      else if (operation === "live")
        value = {
          sessionId: "session",
          runtimeBootId: "runtime",
          status: "idle",
          revision: 1,
          approvals: [],
          questions: [],
          sendEnabled: false,
        };
      else if (operation === "logout") {
        state.access = { ...state.access, status: "ended", device: undefined };
        value = {};
      } else value = { sessionId: "session", status: "idle", features: {}, available: false };
      return value as Result;
    },
    stream: (id, handlers) => {
      streams.set(id, handlers);
      return () => {
        if (streams.get(id) === handlers) streams.delete(id);
      };
    },
    uploadAttachment: vi.fn(),
  };
  const client = new WebClient(undefined, { type: "same-origin" }, bridge);
  const images = vi.spyOn(client, "sessionImage").mockResolvedValue(data);
  return { state, client, images, streams };
}
async function start(disconnect?: () => void) {
  const host = fixture();
  const view = renderHook(() =>
    useSessionController({
      client: host.client,
      disconnect,
      embedded: true,
      initialLocale: "en-US",
    }),
  );
  await waitFor(() => expect(view.result.current.sessions).toHaveLength(1));
  await act(async () => {
    await view.result.current.choose("session");
  });
  await waitFor(() => expect(view.result.current.page?.events[0]?.id).toBe("reply"));
  return { ...host, ...view };
}
async function warm(host: Awaited<ReturnType<typeof start>>) {
  const version = host.result.current.imageRequestVersion();
  const loader = createSessionImageLoader(
    host.client,
    host.result.current.access,
    "session",
    host.result.current.indexEnabled,
    () => host.result.current.imageRequestVersion() === version,
  );
  expect(loader.cacheScope).toBeTruthy();
  const scope = messageImageScope(loader);
  const release = messageImageCache.acquire(scope, "image", loader);
  released.add(release);
  await waitFor(() => expect(messageImageCache.snapshot(scope, "image").phase).toBe("ready"));
  return { scope, loader };
}
beforeEach(() => {
  invalidateSessionImages();
  clearMessageImageCache();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:controller-image");
      static revokeObjectURL = vi.fn();
    },
  );
});
afterEach(() => {
  cleanup();
  for (const release of released) release();
  released.clear();
  clearMessageImageCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("controller image-cache boundaries", () => {
  it("retains decoded images through leaving a conversation and an ordinary history refresh", async () => {
    const host = await start();
    const image = await warm(host);
    act(() => host.result.current.leaveSession());
    expect(messageImageCache.snapshot(image.scope, "image").phase).toBe("ready");
    await act(async () => {
      await host.result.current.choose("session");
      await host.result.current.refresh(false, true);
    });
    const again = await warm(host);
    expect(again.scope).toBe(image.scope);
    expect(host.images).toHaveBeenCalledOnce();
  });

  it("preserves bytes on controller unmount but verifies access before a new controller reuses them", async () => {
    const host = await start();
    const image = await warm(host);
    host.unmount();
    expect(messageImageCache.snapshot(image.scope, "image").phase).toBe("ready");
    let finish!: (value: Access) => void;
    host.state.accessGate = new Promise((resolve) => {
      finish = resolve;
    });
    const next = renderHook(() =>
      useSessionController({ client: host.client, embedded: true, initialLocale: "en-US" }),
    );
    expect(next.result.current.access).toBeUndefined();
    expect(
      createSessionImageLoader(host.client, next.result.current.access, "session", true, () => true)
        .cacheScope,
    ).toBeUndefined();
    await act(async () => {
      finish({ ...host.state.access });
    });
    await waitFor(() => expect(next.result.current.sessions).toHaveLength(1));
    await act(async () => {
      await next.result.current.choose("session");
    });
    const resumed = await warm({ ...host, ...next });
    expect(resumed.scope).toBe(image.scope);
    expect(host.images).toHaveBeenCalledOnce();
  });

  it("keeps incomplete-source images but clears a confirmed removed conversation", async () => {
    const host = await start();
    const image = await warm(host);
    host.state.catalog = {
      ...host.state.catalog,
      complete: false,
      incompleteSources: [{ workspaceId: "workspace", agent: "claude-code" }],
      sessions: [],
    };
    await act(async () => {
      await host.result.current.refresh(false, true);
    });
    expect(messageImageCache.snapshot(image.scope, "image").phase).toBe("ready");
    host.state.catalog = {
      ...host.state.catalog,
      complete: true,
      incompleteSources: [],
      sessions: [],
    };
    await act(async () => {
      await host.result.current.refresh(false, true);
    });
    expect(messageImageCache.snapshot(image.scope, "image").phase).toBe("idle");
  });

  it("restores a newly readable catalog row without accepting its old image success or denial", async () => {
    const host = await start();
    const first = await warm(host);
    let success!: (value: typeof data) => void, failure!: (error: Error) => void;
    host.images
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            success = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failure = reject;
          }),
      );
    const oldSuccess = first.loader("old-success", new AbortController().signal);
    const oldFailure = first.loader("old-failure", new AbortController().signal);
    const original = host.state.catalog.sessions[0];
    host.state.catalog = {
      ...host.state.catalog,
      sessions: [{ ...original, availability: "metadata-only" }],
    };
    await act(async () => {
      await host.result.current.refresh(false, true);
    });
    expect(
      createSessionImageLoader(host.client, host.result.current.access, "session", true, () => true)
        .cacheScope,
    ).toBeUndefined();
    host.state.catalog = {
      ...host.state.catalog,
      sessions: [{ ...original, availability: "readable" }],
    };
    await act(async () => {
      await host.result.current.refresh(false, true);
    });
    const next = await warm(host);
    expect(next.scope).not.toBe(first.scope);
    success(data);
    failure(new ApiError(403, "forbidden"));
    await expect(oldSuccess).rejects.toMatchObject({ name: "AbortError" });
    await expect(oldFailure).rejects.toMatchObject({ name: "AbortError" });
    expect(messageImageCache.snapshot(next.scope, "image").phase).toBe("ready");
    expect(host.images).toHaveBeenCalledTimes(4);
  });

  it("finishes an access read while an unrelated session is withdrawn and restored", async () => {
    const host = await start();
    const read = vi.spyOn(host.client, "access");
    let finish!: (value: Access) => void;
    host.state.accessGate = new Promise((resolve) => {
      finish = resolve;
    });
    let pending!: Promise<void>;
    act(() => {
      pending = host.result.current.refresh(false, true);
    });
    createSessionImageLoader(host.client, host.result.current.access, "other", true, () => true);
    forgetSessionImages(host.client, "other");
    restoreSessionImages(host.client, "other");
    await act(async () => {
      finish({ ...host.state.access });
      await pending;
    });
    expect(read).toHaveBeenCalledOnce();
    expect(host.result.current.access?.status).toBe("approved");
    expect(host.result.current.page?.events[0]?.id).toBe("reply");
  });

  it("rechecks current access after a true authority boundary instead of leaving its read unfinished", async () => {
    const host = await start();
    const read = vi.spyOn(host.client, "access");
    let finish!: (value: Access) => void;
    const before = host.state.access;
    host.state.accessGate = new Promise((resolve) => {
      finish = resolve;
    });
    let pending!: Promise<void>;
    act(() => {
      pending = host.result.current.refresh(false, true);
    });
    invalidateSessionImages(host.client);
    host.state.accessGate = undefined;
    host.state.access = { ...before, historySearchScope: "current-grant" };
    await act(async () => {
      finish(before);
      await pending;
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(host.result.current.access?.historySearchScope).toBe("current-grant");
    expect(host.result.current.page?.events[0]?.id).toBe("reply");
  });

  it("clears bytes when indexing is disabled and does not authorize them with old access", async () => {
    const host = await start();
    const image = await warm(host);
    host.state.catalog = { ...host.state.catalog, indexEnabled: false };
    await act(async () => {
      await host.result.current.refresh(false, true);
    });
    expect(host.result.current.indexEnabled).toBe(false);
    expect(messageImageCache.snapshot(image.scope, "image").phase).toBe("idle");
    expect(
      createSessionImageLoader(
        host.client,
        host.result.current.access,
        "session",
        false,
        () => true,
      ).cacheScope,
    ).toBeUndefined();
  });
});
