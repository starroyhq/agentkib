// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConversationImages,
  conversationImageCopy,
  clearMessageImageCache,
  type MessageImageLoader,
  type MessageImagePreview,
} from "@agentkib/session-ui";

const image = { id: "opaque-image", name: "screenshot.png" };
const data = { mimeType: "image/png", base64: "iVBORw0KGgo=" };
const create = vi.fn(() => "blob:attachment");
const revoke = vi.fn();
let observers: IntersectionObserverCallback[] = [];
const preview = ({ src, name, onClose }: MessageImagePreview) => (
  <div role="dialog" aria-modal="true">
    <img src={src} alt={name} />
    <button onClick={onClose}>Close</button>
  </div>
);
function visible(value: boolean, index = 0) {
  act(() => {
    observers[index]!(
      [{ isIntersecting: value } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  });
}
function gallery(load: MessageImageLoader) {
  return <ConversationImages images={[image]} load={load} locale="en-US" renderPreview={preview} />;
}

beforeEach(() => {
  clearMessageImageCache();
  observers = [];
  create.mockClear();
  revoke.mockClear();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  clearMessageImageCache();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("native attachment images", () => {
  it("loads near the viewport and keeps the decoded thumbnail warm after an offscreen preview closes", async () => {
    const load = vi.fn().mockResolvedValue(data);
    const view = render(gallery(load));
    expect(load).not.toHaveBeenCalled();
    expect(view.container.querySelector('[data-message-image-pending="true"]')).toBeInTheDocument();
    visible(true);
    const thumbnail = await screen.findByRole("img", { name: image.name });
    expect(load).toHaveBeenCalledOnce();
    expect(view.container.querySelector('[data-message-image-pending="true"]')).toBeInTheDocument();
    fireEvent.load(thumbnail);
    expect(view.container.querySelector('[data-message-image-pending="true"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View image: screenshot.png" }));
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    visible(false);
    expect(revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("img", { name: image.name })).toBe(thumbnail);
    expect(revoke).not.toHaveBeenCalled();
    view.unmount();
    expect(revoke).not.toHaveBeenCalled();
    clearMessageImageCache();
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("withdraws a revoked identity and ignores its late image result", async () => {
    let resolveOld!: (value: typeof data) => void;
    const previous = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const next = vi.fn().mockResolvedValue(data);
    Object.assign(previous, { cacheScope: "account:old" });
    Object.assign(next, { cacheScope: "account:next" });
    const view = render(gallery(previous));
    visible(true);
    await waitFor(() => expect(previous).toHaveBeenCalledOnce());
    const oldSignal = previous.mock.calls[0]![1] as AbortSignal;
    act(() => clearMessageImageCache("account:old"));
    view.rerender(gallery(next));
    expect(oldSignal.aborted).toBe(true);
    await screen.findByRole("img");
    await act(async () => {
      resolveOld(data);
    });
    expect(create).toHaveBeenCalledOnce();
    visible(false);
    expect(revoke).not.toHaveBeenCalled();
    act(() => clearMessageImageCache("account:next"));
    expect(revoke).toHaveBeenCalledOnce();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("keeps the same decoded image and never flashes loading when briefly scrolled away", async () => {
    const load = vi.fn().mockResolvedValue(data);
    const view = render(gallery(load));
    visible(true);
    const thumbnail = await screen.findByRole("img", { name: image.name });
    fireEvent.load(thumbnail);
    for (let index = 0; index < 3; index++) {
      visible(false);
      expect(screen.getByRole("img", { name: image.name })).toBe(thumbnail);
      visible(true);
      expect(screen.getByRole("img", { name: image.name })).toBe(thumbnail);
      expect(screen.queryByText("Loading image")).toBeNull();
      expect(view.container.querySelector('[data-message-image-pending="true"]')).toBeNull();
    }
    expect(load).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("shows warm media on a remount before the observer runs but waits for this DOM's load before read acknowledgement", async () => {
    const load = Object.assign(vi.fn().mockResolvedValue(data), { cacheScope: "owner:session" });
    const first = render(gallery(load));
    visible(true);
    fireEvent.load(await screen.findByRole("img", { name: image.name }));
    first.unmount();
    const replacement = Object.assign(vi.fn().mockResolvedValue(data), {
      cacheScope: "owner:session",
    });
    const second = render(gallery(replacement));
    const thumbnail = screen.getByRole("img", { name: image.name });
    expect(thumbnail).toHaveAttribute("src", "blob:attachment");
    expect(screen.queryByText("Loading image")).toBeNull();
    expect(second.container.querySelector('[data-message-image-pending="true"]')).toBeTruthy();
    visible(true, 1);
    fireEvent.load(thumbnail);
    expect(second.container.querySelector('[data-message-image-pending="true"]')).toBeNull();
    expect(load).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("preserves the displayed URL when a callback is recreated in the same approved scope", async () => {
    const load = Object.assign(vi.fn().mockResolvedValue(data), { cacheScope: "stable-owner" });
    const view = render(gallery(load));
    visible(true);
    const thumbnail = await screen.findByRole("img", { name: image.name });
    fireEvent.load(thumbnail);
    const replacement = Object.assign(vi.fn().mockResolvedValue(data), {
      cacheScope: "stable-owner",
    });
    view.rerender(gallery(replacement));
    expect(screen.getByRole("img", { name: image.name })).toBe(thumbnail);
    expect(screen.queryByText("Loading image")).toBeNull();
    expect(replacement).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("withdraws visible cleared media without a fake busy state and retries only when clicked", async () => {
    const load = Object.assign(vi.fn().mockResolvedValue(data), { cacheScope: "current-owner" });
    const view = render(gallery(load));
    visible(true);
    fireEvent.load(await screen.findByRole("img", { name: image.name }));
    act(() => clearMessageImageCache("current-owner"));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText("Loading image")).toBeNull();
    expect(screen.getByText("Image unavailable")).toBeVisible();
    const retry = screen.getByRole("button", { name: "Retry image: screenshot.png" });
    expect(retry).not.toHaveAttribute("aria-busy", "true");
    expect(view.container.querySelector('[data-message-image-pending="true"]')).toBeTruthy();
    expect(load).toHaveBeenCalledOnce();
    visible(false);
    visible(true);
    await act(async () => {});
    expect(load).toHaveBeenCalledOnce();
    fireEvent.click(retry);
    const replacement = await screen.findByRole("img", { name: image.name });
    expect(load).toHaveBeenCalledTimes(2);
    expect(view.container.querySelector('[data-message-image-pending="true"]')).toBeTruthy();
    fireEvent.load(replacement);
    expect(view.container.querySelector('[data-message-image-pending="true"]')).toBeNull();
    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    });
    expect(screen.getByRole("img", { name: image.name })).toBe(replacement);
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("does not loop or stay busy when a cleared authority rejects an explicit retry as cancelled", async () => {
    const load = Object.assign(
      vi
        .fn()
        .mockResolvedValueOnce(data)
        .mockRejectedValue(new DOMException("Scope changed", "AbortError")),
      { cacheScope: "ended-owner" },
    );
    render(gallery(load));
    visible(true);
    fireEvent.load(await screen.findByRole("img", { name: image.name }));
    act(() => clearMessageImageCache("ended-owner"));
    fireEvent.click(screen.getByRole("button", { name: "Retry image: screenshot.png" }));
    await screen.findByText("Image unavailable");
    expect(screen.queryByText("Loading image")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry image: screenshot.png" })).not.toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(load).toHaveBeenCalledTimes(2);
    visible(false);
    visible(true);
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not reread an offscreen withdrawn scope when it becomes visible again", async () => {
    const load = Object.assign(vi.fn().mockResolvedValue(data), { cacheScope: "withdrawn-owner" });
    render(gallery(load));
    visible(true);
    fireEvent.load(await screen.findByRole("img", { name: image.name }));
    visible(false);
    act(() => clearMessageImageCache("withdrawn-owner"));
    expect(screen.queryByRole("img")).toBeNull();
    visible(true);
    await act(async () => {});
    expect(load).toHaveBeenCalledOnce();
    expect(screen.getByText("Image unavailable")).toBeVisible();
    expect(screen.queryByText("Loading image")).toBeNull();
  });

  it("merges concurrent views without cancelling a request still needed by another view", async () => {
    let resolve!: (value: typeof data) => void;
    const load = Object.assign(
      vi.fn().mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
      { cacheScope: "shared-session" },
    );
    const first = render(gallery(load));
    render(gallery(load));
    visible(true);
    visible(true, 1);
    await waitFor(() => expect(load).toHaveBeenCalledOnce());
    const signal = load.mock.calls[0]![1] as AbortSignal;
    first.unmount();
    expect(signal.aborted).toBe(false);
    await act(async () => resolve(data));
    expect(await screen.findByRole("img", { name: image.name })).toHaveAttribute(
      "src",
      "blob:attachment",
    );
    expect(create).toHaveBeenCalledOnce();
  });

  it("withdraws an offscreen image when idle retention expires and reloads only on return", async () => {
    const load = vi.fn().mockResolvedValue(data);
    render(gallery(load));
    visible(true);
    fireEvent.load(await screen.findByRole("img", { name: image.name }));
    vi.useFakeTimers();
    visible(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    });
    expect(screen.queryByRole("img")).toBeNull();
    expect(load).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledOnce();
    visible(true);
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("img", { name: image.name })).toBeTruthy();
  });

  it("does not retry a failed image after viewport changes until the user retries", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("gone")).mockResolvedValue(data);
    const view = render(gallery(load));
    visible(true);
    await screen.findByText("Image unavailable");
    visible(false);
    visible(true);
    await screen.findByText("Image unavailable");
    expect(load).toHaveBeenCalledOnce();
    expect(view.container.querySelector('[data-message-image-pending="true"]')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry image: screenshot.png" }));
    await screen.findByRole("img");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("rejects active content instead of producing an image URL", async () => {
    const load = vi.fn().mockResolvedValue({ mimeType: "image/svg+xml", base64: "PHN2Zz4=" });
    render(gallery(load));
    visible(true);
    await screen.findByText("Image unavailable");
    expect(create).not.toHaveBeenCalled();
  });

  it("immediately releases undecodable images and does not revoke them twice", async () => {
    const load = vi.fn().mockResolvedValue(data);
    const view = render(gallery(load));
    visible(true);
    fireEvent.error(await screen.findByRole("img"));
    expect(screen.getByText("Image unavailable")).toBeVisible();
    expect(revoke).toHaveBeenCalledWith("blob:attachment");
    visible(false);
    view.unmount();
    expect(revoke).toHaveBeenCalledOnce();
  });

  it.each([
    ["zh-CN", "查看图片", "图片不可用"],
    ["zh-TW", "檢視圖片", "圖片無法使用"],
    ["en-US", "View image", "Image unavailable"],
    ["ja-JP", "画像を表示", "画像を表示できません"],
  ])("provides preview and failure labels in %s", (locale, title, error) => {
    expect(conversationImageCopy(locale)).toMatchObject({ preview: title, unavailable: error });
  });
});
