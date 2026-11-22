import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { render } from "@/features/conversation/web-reader-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadedAttachment } from "@agentkib/web-client";
import { dictionaries } from "@/features/conversation/i18n";
import { SessionComposer } from "@/features/conversation/web-session-composer";
import { useSession } from "@/features/conversation/web-session-context";

vi.mock("@/features/conversation/web-session-context", () => ({
  useSession: vi.fn(),
}));
vi.mock("@agentkib/session-ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@agentkib/session-ui")>()),
  CodexComposerControls: () => null,
}));

let state: ReturnType<typeof useSession>;
const createObjectURL = vi.fn<(blob: Blob) => string>();
const revokeObjectURL = vi.fn<(url: string) => void>();
const uploaded: UploadedAttachment = {
  id: "opaque-id",
  name: "image.png",
  mime: "image/png",
  size: 3,
  version: "v1",
};

beforeEach(() => {
  let nextUrl = 0;
  createObjectURL.mockReset().mockImplementation(() => `blob:local-preview-${++nextUrl}`);
  revokeObjectURL.mockReset();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    },
  );
  state = {
    selected: "first",
    access: { status: "approved", protocolVersion: 2, device: { attachments: true } },
    locale: "zh-CN",
    t: dictionaries["zh-CN"],
    message: "",
    setMessage: vi.fn(),
    control: vi.fn().mockResolvedValue(true),
    codexAction: vi.fn(),
    capabilities: { sessionId: "first", features: { attachments: { available: true } } },
    canSend: true,
    canStop: false,
    busy: false,
    online: true,
    controlReady: true,
    client: {
      uploadAttachment: vi.fn().mockResolvedValue(uploaded),
      request: vi.fn().mockResolvedValue({}),
    },
  } as unknown as ReturnType<typeof useSession>;
  vi.mocked(useSession).mockImplementation(() => state);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function choose(file = new File(["image-bytes"], "image.png", { type: "image/png" })) {
  fireEvent.change(screen.getByLabelText("添加附件", { selector: "input" }), {
    target: { files: [file] },
  });
  return file;
}

describe("local attachment preview", () => {
  it("shows a local thumbnail and enlarged image before sending only the opaque ID", async () => {
    render(<SessionComposer />);
    const file = choose();
    expect(createObjectURL).toHaveBeenCalledWith(file);
    const preview = screen.getByRole("button", { name: "预览附件: image.png" });
    expect(preview.querySelector("img")).toHaveAttribute("src", "blob:local-preview-1");
    preview.focus();
    fireEvent.click(preview);
    const dialog = screen.getByRole("dialog", { name: "预览附件: image.png" });
    expect(within(dialog).getByRole("img", { name: "image.png" })).toHaveAttribute(
      "src",
      "blob:local-preview-1",
    );
    expect(dialog.querySelector("iframe, object, embed, script")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(preview).toHaveFocus());
    await screen.findByText("100%");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:local-preview-1"),
    );
    expect(state.control).toHaveBeenCalledWith("send", undefined, undefined, undefined, undefined, {
      attachmentIds: ["opaque-id"],
    });
    expect(screen.queryByRole("button", { name: "预览附件: image.png" })).not.toBeInTheDocument();
  });

  it("revokes a removed thumbnail while preserving other selected attachments", async () => {
    render(<SessionComposer />);
    choose();
    choose(new File(["second"], "second.jpg", { type: "image/jpeg" }));
    await waitFor(() => expect(screen.getAllByText("100%")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "移除附件: image.png" }));
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:local-preview-1");
    expect(screen.getByRole("button", { name: "预览附件: second.jpg" })).toBeVisible();
    expect(state.client.request).toHaveBeenCalledWith("attachments/delete", {
      sessionId: "first",
      attachmentId: "opaque-id",
      version: "v1",
    });
  });

  it.each(["unmount", "switch", "revoke"])(
    "aborts uploads and releases open previews on %s, ignoring late upload completion",
    async (action) => {
      let resolve!: (value: UploadedAttachment) => void;
      let signal: AbortSignal | undefined;
      vi.mocked(state.client.uploadAttachment).mockImplementation(
        (_id, _file, _progress, nextSignal) => {
          signal = nextSignal;
          return new Promise((done) => {
            resolve = done;
          });
        },
      );
      const view = render(<SessionComposer />);
      choose();
      fireEvent.click(screen.getByRole("button", { name: "预览附件: image.png" }));
      if (action === "unmount") view.unmount();
      else {
        state =
          action === "switch"
            ? { ...state, selected: "second" }
            : {
                ...state,
                access: {
                  ...state.access!,
                  device: { ...state.access!.device!, attachments: false },
                },
              };
        view.rerender(<SessionComposer />);
      }
      expect(signal?.aborted).toBe(true);
      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:local-preview-1");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      await act(async () => resolve(uploaded));
      expect(screen.queryByRole("button", { name: "预览附件: image.png" })).not.toBeInTheDocument();
      expect(screen.queryByText("100%")).not.toBeInTheDocument();
    },
  );

  it("discards a failed upload preview and lets the user select a fresh file", async () => {
    vi.mocked(state.client.uploadAttachment).mockRejectedValueOnce(new Error("upload failed"));
    render(<SessionComposer />);
    choose();
    await waitFor(() =>
      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:local-preview-1"),
    );
    expect(screen.queryByRole("button", { name: "预览附件: image.png" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "移除附件: image.png" }));
    choose();
    await screen.findByText("100%");
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "预览附件: image.png" }).querySelector("img"),
    ).toHaveAttribute("src", "blob:local-preview-2");
  });

  it("releases an undecodable image without preventing an otherwise valid attachment send", async () => {
    render(<SessionComposer />);
    choose();
    fireEvent.error(
      screen.getByRole("button", { name: "预览附件: image.png" }).querySelector("img")!,
    );
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:local-preview-1");
    await screen.findByText("100%");
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  });

  it.each(["image/svg+xml", "text/html"])(
    "does not create an executable preview for %s",
    async (mime) => {
      render(<SessionComposer />);
      choose(
        new File(["<script>fetch('https://example.invalid')</script>"], "document", { type: mime }),
      );
      await screen.findByText("100%");
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: /预览附件/ })).not.toBeInTheDocument();
      expect(document.querySelector("iframe, object, embed")).toBeNull();
    },
  );

  it("retains the preview for an unknown send result and clears it only after acceptance", async () => {
    vi.mocked(state.control).mockResolvedValue(undefined);
    const view = render(<SessionComposer />);
    choose();
    await screen.findByText("100%");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(state.control).toHaveBeenCalledOnce());
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "预览附件: image.png" })).toBeVisible();
    state = { ...state, notice: "accepted" };
    view.rerender(<SessionComposer />);
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:local-preview-1");
    expect(screen.queryByRole("button", { name: "预览附件: image.png" })).not.toBeInTheDocument();
  });

  it("does not clear the next conversation's preview when an earlier send resolves late", async () => {
    let finish!: (accepted: true | undefined) => void;
    vi.mocked(state.control).mockImplementationOnce(
      () =>
        new Promise<true | undefined>((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<SessionComposer />);
    choose();
    await screen.findByText("100%");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    state = {
      ...state,
      selected: "second",
      capabilities: { ...state.capabilities!, sessionId: "second" },
    };
    view.rerender(<SessionComposer />);
    choose(new File(["next"], "next.png", { type: "image/png" }));
    await screen.findByText("100%");
    await act(async () => finish(true));
    expect(screen.getByRole("button", { name: "预览附件: next.png" })).toBeVisible();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:local-preview-1");
    expect(state.setMessage).not.toHaveBeenCalled();
  });
});
