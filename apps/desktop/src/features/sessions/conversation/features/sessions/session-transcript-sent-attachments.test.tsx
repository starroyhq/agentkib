// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationEvent, ConversationSentAttachment } from "@agentkib/web-client";
import {
  SessionTranscript,
  clearMessageImageCache,
  formatAttachmentSize,
  sentAttachmentCopy,
} from "@agentkib/session-ui";
import sentAttachmentsFixture from "../../../../../../../../packages/runtime-protocol/test/fixtures/conversation-sent-attachments.json";

const props = {
  labels: {
    process: "Process",
    tools: "tools",
    failed: "failed",
    incomplete: "incomplete",
    details: "Details",
    attachments: "attachments",
    truncated: "truncated",
    unknownTool: "Tool",
  },
  locale: "en-US",
  earlierLabel: "Earlier",
};

const pngData = { mimeType: "image/png", base64: "iVBORw0KGgo=" };

let nextBlobUrl = 0;
const createObjectURL = vi.fn(() => `blob:sent-attachment-${++nextBlobUrl}`);
const revokeObjectURL = vi.fn();

beforeEach(() => {
  clearMessageImageCache();
  nextBlobUrl = 0;
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  vi.stubGlobal("IntersectionObserver", undefined);
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    },
  );
});

afterEach(() => {
  cleanup();
  clearMessageImageCache();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("sent message attachments", () => {
  it("renders protocol fixture images, files, unavailable entries and native images cleanly", async () => {
    const events = sentAttachmentsFixture.current.events as ConversationEvent[];
    const imageLoader = Object.assign(vi.fn().mockResolvedValue(pngData), {
      cacheScope: "fixture-scope",
    });

    const view = render(<SessionTranscript {...props} events={events} imageLoader={imageLoader} />);

    const sentRow = view.container.querySelector<HTMLElement>(
      '[data-event-id="user-message-with-attachments"]',
    )!;
    const strip = sentRow.querySelector('[data-slot="sent-attachment-strip"]')!;
    const bubble = sentRow.querySelector('[data-user-message-bubble="true"]')!;
    expect([...sentRow.children]).toEqual([strip, bubble]);

    const cards = strip.querySelectorAll('[data-slot="sent-attachment-card"]');
    expect(cards).toHaveLength(3);

    // 1. Readable image attachment loads via sessionImage loader and opens preview modal
    const screenshotImg = await within(sentRow).findByRole("img", { name: "screenshot.png" });
    expect(imageLoader).toHaveBeenCalledWith(
      "session-image-v1-00000000-0000-4000-8000-000000000001",
      expect.any(AbortSignal),
    );
    expect(cards[0]).toHaveAttribute("data-message-image-pending", "true");
    fireEvent.load(screenshotImg);
    expect(cards[0]).not.toHaveAttribute("data-message-image-pending");
    expect(cards[0]).toHaveAttribute("data-sent-attachment-state", "image");

    const previewButton = within(sentRow).getByRole("button", {
      name: "View image: screenshot.png",
    });
    previewButton.focus();
    fireEvent.click(previewButton);
    const modal = screen.getByRole("dialog", { name: "screenshot.png" });
    expect(within(modal).getByRole("img", { name: "screenshot.png" })).toHaveAttribute(
      "src",
      screenshotImg.getAttribute("src"),
    );
    fireEvent.click(within(modal).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(previewButton).toHaveFocus());

    // 2. Readable file attachment renders named file card with badge and byte size
    expect(cards[1]).toHaveAttribute("data-sent-attachment-state", "file");
    expect(cards[1]).toHaveTextContent("log.txt");
    expect(cards[1]).toHaveTextContent("TXT");
    expect(cards[1]).toHaveTextContent("122 B");

    // 3. Unavailable attachment preserves filename as muted file card without fetching
    expect(cards[2]).toHaveAttribute("data-sent-attachment-state", "unavailable");
    expect(cards[2]).toHaveTextContent("older-screenshot.png");
    expect(cards[2]).toHaveTextContent("PNG");
    expect(cards[2]).toHaveTextContent("22 KB");
    expect(within(cards[2] as HTMLElement).queryByRole("button")).toBeNull();

    // No redundant attachment count pill when structured attachments cover all items
    expect(sentRow).not.toHaveTextContent("attachments:");
    expect(sentRow).toHaveTextContent("请看看这两张图和记录。");

    // 4. Native image event in the same fixture still renders via ConversationImages
    const nativeRow = view.container.querySelector<HTMLElement>(
      '[data-event-id="user-message-with-native-image"]',
    )!;
    await within(nativeRow).findByRole("img");
    expect(imageLoader).toHaveBeenCalledWith(
      "session-image-v1-00000000-0000-4000-8000-000000000002",
      expect.any(AbortSignal),
    );
    expect(imageLoader).toHaveBeenCalledTimes(2);
  });

  it("renders attachment-only user messages without an empty text bubble", async () => {
    const imageLoader = Object.assign(vi.fn().mockResolvedValue(pngData), {
      cacheScope: "pure-attachments",
    });
    const event: ConversationEvent = {
      id: "attachment-only",
      kind: "user-message",
      timestamp: "2026-11-27T10:05:00.000Z",
      content: "",
      attachment_count: 0,
      attachments: [
        {
          name: "design.png",
          kind: "image",
          mimeType: "image/png",
          size: 4096,
          available: true,
          imageId: "img-only",
        },
        {
          name: "report.pdf",
          kind: "file",
          mimeType: "application/pdf",
          size: 1_572_864,
          available: true,
        },
      ],
      truncated: false,
    };

    const view = render(
      <SessionTranscript {...props} events={[event]} imageLoader={imageLoader} />,
    );
    const row = view.container.querySelector<HTMLElement>('[data-event-id="attachment-only"]')!;
    expect(row).toBeInTheDocument();
    const img = await within(row).findByRole("img", { name: "design.png" });
    fireEvent.load(img);
    expect(row).toHaveTextContent("report.pdf");
    expect(row).toHaveTextContent("1.5 MB");
    expect(row.querySelector('[data-user-message-bubble="true"]')).toBeNull();
    expect(row.querySelector('[data-slot="sent-attachment-strip"]')).toHaveClass("justify-end");
    expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();
  });

  it("keeps filename as a retryable file card on image load failure and retries only on click", async () => {
    const observers: IntersectionObserverCallback[] = [];
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
    const notifyVisible = (value: boolean) => {
      act(() => {
        observers[0]?.(
          [{ isIntersecting: value } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      });
    };

    const imageLoader = Object.assign(
      vi.fn().mockRejectedValueOnce(new Error("temporary")).mockResolvedValue(pngData),
      { cacheScope: "retry-scope" },
    );
    const event: ConversationEvent = {
      id: "retry-event",
      kind: "user-message",
      content: "Check image",
      attachment_count: 1,
      attachments: [
        {
          name: "diagram.png",
          kind: "image",
          mimeType: "image/png",
          size: 10240,
          available: true,
          imageId: "img-retry",
        },
      ],
      truncated: false,
    };

    const view = render(
      <SessionTranscript {...props} events={[event]} imageLoader={imageLoader} />,
    );
    expect(imageLoader).not.toHaveBeenCalled();

    notifyVisible(true);
    const retryButton = await screen.findByRole("button", { name: "Retry image: diagram.png" });
    expect(retryButton).toHaveTextContent("diagram.png");
    expect(retryButton).toHaveTextContent("Retry");
    expect(view.container.querySelector('[data-slot="sent-attachment-card"]')).toHaveAttribute(
      "data-sent-attachment-state",
      "retry",
    );

    // Scrolling away and back must not automatically retry a failed fetch
    notifyVisible(false);
    notifyVisible(true);
    await act(async () => {});
    expect(imageLoader).toHaveBeenCalledTimes(1);

    // Explicit click retries and restores the thumbnail
    fireEvent.click(retryButton);
    const img = await screen.findByRole("img", { name: "diagram.png" });
    fireEvent.load(img);
    expect(imageLoader).toHaveBeenCalledTimes(2);
    expect(view.container.querySelector('[data-slot="sent-attachment-card"]')).toHaveAttribute(
      "data-sent-attachment-state",
      "image",
    );
  });

  it("cancels stale loads and discards late bytes when image scope changes", async () => {
    let resolvePrevious!: (value: typeof pngData) => void;
    const previousLoader = Object.assign(
      vi.fn().mockImplementation(
        () =>
          new Promise<typeof pngData>((resolve) => {
            resolvePrevious = resolve;
          }),
      ),
      { cacheScope: "scope:old" },
    );
    const nextLoader = Object.assign(vi.fn().mockResolvedValue(pngData), {
      cacheScope: "scope:new",
    });
    const event: ConversationEvent = {
      id: "scope-change",
      kind: "user-message",
      content: "Scope test",
      attachment_count: 1,
      attachments: [
        {
          name: "scoped.png",
          kind: "image",
          mimeType: "image/png",
          size: 2048,
          available: true,
          imageId: "img-scoped",
        },
      ],
      truncated: false,
    };

    const view = render(
      <SessionTranscript {...props} events={[event]} imageLoader={previousLoader} />,
    );
    await waitFor(() => expect(previousLoader).toHaveBeenCalledOnce());
    const previousSignal = previousLoader.mock.calls[0]![1] as AbortSignal;

    act(() => clearMessageImageCache("scope:old"));
    view.rerender(<SessionTranscript {...props} events={[event]} imageLoader={nextLoader} />);

    expect(previousSignal.aborted).toBe(true);
    await screen.findByRole("img", { name: "scoped.png" });

    await act(async () => {
      resolvePrevious(pngData);
    });
    expect(createObjectURL).toHaveBeenCalledOnce();

    act(() => clearMessageImageCache("scope:new"));
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(screen.queryByRole("img", { name: "scoped.png" })).toBeNull();
  });

  it("shows a file card with filename when imageId or imageLoader is absent", () => {
    const attachments: ConversationSentAttachment[] = [
      {
        name: "missing-id.png",
        kind: "image",
        mimeType: "image/png",
        size: 8192,
        available: true,
      },
      {
        name: "no-loader.webp",
        kind: "image",
        mimeType: "image/webp",
        size: 3072,
        available: true,
        imageId: "img-unloaded",
      },
    ];
    const event: ConversationEvent = {
      id: "unpreviewable",
      kind: "user-message",
      content: "Check files",
      attachment_count: 2,
      attachments,
      truncated: false,
    };

    const view = render(<SessionTranscript {...props} events={[event]} />);
    const cards = view.container.querySelectorAll('[data-slot="sent-attachment-card"]');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveAttribute("data-sent-attachment-state", "unavailable");
    expect(cards[0]).toHaveTextContent("missing-id.png");
    expect(cards[1]).toHaveAttribute("data-sent-attachment-state", "unavailable");
    expect(cards[1]).toHaveTextContent("no-loader.webp");
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container).not.toHaveTextContent("attachments:");
  });

  it("preserves older host plain text and count-only behavior when attachments field is absent", () => {
    const previousEvents = sentAttachmentsFixture.previous.events as ConversationEvent[];
    const countOnly: ConversationEvent = {
      id: "older-count-only",
      kind: "user-message",
      content: "Count only message",
      attachment_count: 2,
      truncated: false,
    };

    const view = render(<SessionTranscript {...props} events={[...previousEvents, countOnly]} />);
    expect(view.container.querySelector('[data-slot="sent-attachment-strip"]')).toBeNull();
    expect(view.container).toHaveTextContent("请看看这张图。");
    expect(view.container.querySelector('a[href^="file:"]')).toBeNull();
    expect(screen.getByText("attachments: 2")).toBeVisible();
  });

  it("formats byte sizes and localizes copy across all supported locales", () => {
    expect(formatAttachmentSize(0)).toBeUndefined();
    expect(formatAttachmentSize(-5)).toBeUndefined();
    expect(formatAttachmentSize(122)).toBe("122 B");
    expect(formatAttachmentSize(1536)).toBe("1.5 KB");
    expect(formatAttachmentSize(2048)).toBe("2 KB");
    expect(formatAttachmentSize(58317)).toBe("57 KB");
    expect(formatAttachmentSize(1_572_864)).toBe("1.5 MB");
    expect(formatAttachmentSize(2 * 1024 * 1024 * 1024)).toBe("2 GB");

    expect(sentAttachmentCopy("zh-CN")).toEqual({ listLabel: "已发送的附件", retry: "重试" });
    expect(sentAttachmentCopy("zh-Hant")).toEqual({ listLabel: "已傳送的附件", retry: "重試" });
    expect(sentAttachmentCopy("en-US")).toEqual({ listLabel: "Sent attachments", retry: "Retry" });
    expect(sentAttachmentCopy("ja-JP")).toEqual({
      listLabel: "送信済みの添付ファイル",
      retry: "再試行",
    });
  });
});
