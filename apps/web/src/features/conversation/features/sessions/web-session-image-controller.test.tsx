// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  WebClient,
  type Access,
  type ConversationCatalog,
  type ConversationClientBridge,
} from "@agentkib/web-client";
import {
  ConversationImages,
  clearMessageImageCache,
  messageImageCache,
  messageImageScope,
  useSessionImageLoader,
} from "@agentkib/session-ui";
import { useSessionController } from "../../web-session-controller";
import {
  createSessionImageLoader,
  invalidateSessionImages,
  webSessionImages,
} from "../../web-session-images";

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
  it("clears all image bytes for logout before another approved access can reuse them", async () => {
    const host = await start();
    const image = await warm(host);
    await act(async () => {
      await host.result.current.post("logout", {});
    });
    expect(messageImageCache.snapshot(image.scope, "image").phase).toBe("idle");
    expect(host.result.current.access?.status).toBe("ended");
  });

  it("invalidates cache before the explicit disconnect callback runs", async () => {
    const disconnect = vi.fn();
    const host = await start(disconnect);
    const image = await warm(host);
    act(() => host.result.current.disconnect?.());
    expect(disconnect).toHaveBeenCalledOnce();
    expect(messageImageCache.snapshot(image.scope, "image").phase).toBe("idle");
  });

  it("clears image authority when the active access stream ends", async () => {
    const host = await start();
    const image = await warm(host);
    await waitFor(() => expect(host.streams.has("session")).toBe(true));
    act(() => host.streams.get("session")!.event("access-ended", "{}"));
    expect(messageImageCache.snapshot(image.scope, "image").phase).toBe("idle");
    expect(host.result.current.access?.status).toBe("ended");
  });

  it("shows unavailable after a current image 403 and retries HTTP only after explicit access refresh", async () => {
    const host = fixture();
    host.images.mockRejectedValue(new ApiError(403, "forbidden"));
    let controller!: ReturnType<typeof useSessionController>;
    let refreshing: Promise<void> | undefined;
    function Reader({ showImages }: { showImages: boolean }) {
      // The production reader is not compiler-memoized; observe its scope reads on every render.
      "use no memo";
      const current = useSessionController({
        client: host.client,
        embedded: true,
        initialLocale: "en-US",
      });
      useLayoutEffect(() => {
        controller = current;
      }, [current]);
      const { client, access, selected, indexEnabled, imageRequestVersion } = current;
      const loader = useSessionImageLoader({
        images: webSessionImages,
        client,
        access,
        sessionId: selected,
        indexEnabled,
        requestVersion: imageRequestVersion,
      });
      return (
        <>
          <p>{access?.status}</p>
          <button
            onClick={() => {
              refreshing = current.refresh(true, true);
            }}
          >
            Refresh access
          </button>
          {showImages && (
            <ConversationImages
              images={[{ id: "image", name: "Screenshot.png" }]}
              load={loader}
              locale="en-US"
              renderPreview={() => null}
            />
          )}
        </>
      );
    }
    const view = render(<Reader showImages={false} />);
    await waitFor(() => expect(controller.sessions).toHaveLength(1));
    await act(async () => {
      await controller.choose("session");
    });
    await waitFor(() => expect(controller.page?.events[0]?.id).toBe("reply"));
    const failedScope = createSessionImageLoader(
      host.client,
      controller.access,
      "session",
      true,
      () => true,
    ).cacheScope!;
    view.rerender(<Reader showImages />);
    await waitFor(() => {
      expect(host.images).toHaveBeenCalledOnce();
      expect(screen.getByText("Image unavailable")).toBeTruthy();
      expect(screen.queryByText("Loading image")).toBeNull();
    });
    expect(screen.getByText("approved")).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Retry image: Screenshot.png" });
    expect(retry.getAttribute("aria-busy")).not.toBe("true");
    fireEvent.click(retry);
    await waitFor(() =>
      expect(messageImageCache.snapshot(failedScope, "image").phase).toBe("idle"),
    );
    await screen.findByText("Image unavailable");
    expect(host.images).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Refresh access" }));
    await act(async () => {
      await refreshing;
    });
    await waitFor(() => {
      expect(host.images).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Image unavailable")).toBeTruthy();
      expect(screen.queryByText("Loading image")).toBeNull();
    });
    expect(host.images).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403])(
    "clears previous bytes after a current controller %s access failure",
    async (status) => {
      const host = await start();
      const image = await warm(host);
      host.state.failure = new ApiError(status, "forbidden");
      await act(async () => {
        await host.result.current.refresh(false, true);
      });
      expect(messageImageCache.snapshot(image.scope, "image").phase).toBe("idle");
      expect(
        createSessionImageLoader(
          host.client,
          host.result.current.access,
          "session",
          true,
          () => true,
        ).cacheScope,
      ).toBeUndefined();
    },
  );

  it("invalidates a changed workspace grant when the selected Web session becomes visible", async () => {
    const host = await start();
    const image = await warm(host);
    host.state.access = { ...host.state.access, historySearchScope: "new-workspace-grant" };
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() =>
      expect(messageImageCache.snapshot(image.scope, "image").phase).toBe("idle"),
    );
    expect(host.result.current.selected).toBe("session");
    const next = createSessionImageLoader(
      host.client,
      host.result.current.access,
      "session",
      true,
      () => true,
    );
    expect(next.cacheScope).toBeTruthy();
    expect(next.cacheScope).not.toBe(image.loader.cacheScope);
  });
});
