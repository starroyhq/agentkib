// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadedAttachment } from "@agentkib/web-client";
import { SessionComposer } from "./session-composer";
import { composerLayoutCopy } from "./composer-layout-copy";
import { codexCopy } from "./codex-copy";
import type { CodexResource } from "./codex-session-controls";
import type { SessionController } from "./use-session-controller";

const doubles = vi.hoisted(() => ({
  session: {} as Partial<SessionController>,
  control: vi.fn(),
  codexAction: vi.fn(),
  navigate: vi.fn(),
  upload: vi.fn(),
  resumeCommand: vi.fn(),
}));
vi.mock("./session-navigation", () => ({ useSessionNavigate: () => doubles.navigate }));
vi.mock("./session-context", () => ({
  useSession: () => {
    const [message, setMessage] = useState("");
    return { ...doubles.session, message, setMessage } as SessionController;
  },
}));
vi.mock("./session-panels", () => ({ useSessionPanels: () => null }));
vi.mock("./context-usage", () => ({ ContextUsageGauge: () => null }));
vi.mock("../history/history-search-controls", () => ({ HistoryReferenceChips: () => null }));
vi.mock("./codex-session-controls", () => ({
  CodexComposerControls: ({
    action,
    advancedActions,
    setResources,
  }: {
    action: ReactNode;
    advancedActions: ReactNode;
    setResources: (resources: CodexResource[]) => void;
  }) => (
    <>
      <button
        type="button"
        onClick={() =>
          setResources([{ id: "file", kind: "file", name: "README", available: true }])
        }
      >
        Reference file
      </button>
      {advancedActions}
      {action}
    </>
  ),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function renderComposer(message = "Draft message") {
  const view = render(<SessionComposer />);
  const input = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(input, { target: { value: message } });
  return { ...view, input, form: input.closest("form")! };
}

const attachment: UploadedAttachment = {
  id: "attachment",
  name: "note.txt",
  mime: "text/plain",
  size: 3,
  version: "1",
};

describe("composer sending shortcuts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    doubles.control.mockResolvedValue(true);
    doubles.resumeCommand.mockResolvedValue({
      available: true,
      command: "CODEX_HOME='/host/codex' codex resume '00000000-0000-4000-8000-000000000001'",
      shell: "posix",
      runOn: "host",
    });
    doubles.codexAction.mockResolvedValue({ accepted: true });
    doubles.session = {
      selected: "session",
      current: { id: "session", agent: "codex" } as SessionController["current"],
      locale: "en-US",
      t: { message: "Message", send: "Send", stop: "Stop" } as SessionController["t"],
      online: true,
      busy: false,
      controlReady: true,
      canSend: true,
      canStop: false,
      live: {
        sessionId: "session",
        revision: 1,
        sendEnabled: true,
        status: "idle",
        approvals: [],
        questions: [],
      } as SessionController["live"],
      access: {
        protocolVersion: 2,
        experimentalEnabled: true,
        device: { send: true, attachments: true },
      } as SessionController["access"],
      capabilities: {
        sessionId: "session",
        features: {
          attachments: { available: true },
          steer: { available: true },
          "queue-add": { available: true },
        },
      } as SessionController["capabilities"],
      control: doubles.control,
      codexAction: doubles.codexAction,
      client: {
        uploadAttachment: doubles.upload,
        codexResumeCommand: doubles.resumeCommand,
        claudeResumeCommand: doubles.resumeCommand,
        request: vi.fn(),
      } as unknown as SessionController["client"],
    };
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("submits Enter through the same form path as the send button", async () => {
    const { input, form } = renderComposer();
    expect(screen.getByRole("button", { name: "Send" })).toHaveClass("size-11");
    expect(screen.getByRole("button", { name: codexCopy["en-US"].attachment })).toHaveClass(
      "size-11",
    );
    const requestSubmit = vi.spyOn(form, "requestSubmit");
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    await waitFor(() => expect(input).toHaveValue(""));
    expect(requestSubmit).toHaveBeenCalledTimes(1);
    expect(doubles.control).toHaveBeenCalledExactlyOnceWith(
      "send",
      undefined,
      undefined,
      undefined,
      undefined,
      { attachmentIds: [] },
    );
    expect(doubles.codexAction).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "Second message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(doubles.control).toHaveBeenCalledTimes(2));
  });

  it("explains an unavailable attachment button in words, not its reason code", () => {
    doubles.session = {
      ...doubles.session,
      capabilities: {
        ...doubles.session.capabilities!,
        features: { attachments: { available: false, reason: "session-busy" } },
      },
    };
    renderComposer();
    const button = screen.getByRole("button", { name: codexCopy["en-US"].attachment });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      "title",
      "This operation requires an idle session. Wait for the current turn to finish.",
    );
  });

  it("keeps coarse-pointer Enter as a newline and sends only with the button", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    const { input } = renderComposer();
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true);
    expect(doubles.control).not.toHaveBeenCalled();
    expect(screen.queryByText(composerLayoutCopy["en-US"].sendShortcut)).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "Line one\nLine two" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(doubles.control).toHaveBeenCalledTimes(1));
  });

  it("leaves Shift+Enter available for the browser's newline input", () => {
    const { input } = renderComposer();
    expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true })).toBe(true);
    fireEvent.change(input, { target: { value: "Draft message\n" } });
    expect(input).toHaveValue("Draft message\n");
    expect(doubles.control).not.toHaveBeenCalled();
  });

  it.each(["ctrlKey", "metaKey", "altKey"])("leaves %s combinations unchanged", (modifier) => {
    const { input } = renderComposer();
    expect(fireEvent.keyDown(input, { key: "Enter", [modifier]: true })).toBe(true);
    expect(doubles.control).not.toHaveBeenCalled();
  });

  it("does not submit native IME composition or keyCode 229", async () => {
    const { input } = renderComposer("中文草稿");
    expect(fireEvent.keyDown(input, { key: "Enter", isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(input, { key: "Enter", keyCode: 229 })).toBe(true);
    fireEvent.compositionStart(input);
    expect(fireEvent.keyDown(input, { key: "Enter", isComposing: false, keyCode: 13 })).toBe(true);
    expect(doubles.control).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    // WebKit may clear isComposing before the confirming key's keydown.
    expect(fireEvent.keyDown(input, { key: "Enter", isComposing: false, keyCode: 229 })).toBe(true);
    expect(doubles.control).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });
    await waitFor(() => expect(doubles.control).toHaveBeenCalledTimes(1));
  });

  it("does not send a held Enter key repeatedly", async () => {
    const { input } = renderComposer();
    expect(fireEvent.keyDown(input, { key: "Enter", repeat: true })).toBe(false);
    expect(doubles.control).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(doubles.control).toHaveBeenCalledTimes(1));
  });

  it.each([
    ["not permitted", { canSend: false }],
    ["offline", { online: false, canSend: false }],
    ["busy", { busy: true, canSend: false }],
    [
      "compacting",
      {
        canSend: false,
        live: {
          sessionId: "session",
          status: "idle",
          activity: "compacting",
          approvals: [],
          questions: [],
        },
      },
    ],
    [
      "running",
      {
        canSend: false,
        canStop: true,
        live: { sessionId: "session", status: "running", approvals: [], questions: [] },
      },
    ],
  ] as [string, Partial<SessionController>][])("preserves the %s send gate", (_name, overrides) => {
    doubles.session = { ...doubles.session, ...overrides };
    const { input } = renderComposer();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(doubles.control).not.toHaveBeenCalled();
    expect(doubles.codexAction).not.toHaveBeenCalled();
    expect(screen.queryByText(composerLayoutCopy["en-US"].sendShortcut)).not.toBeInTheDocument();
  });

  it.each(["", " \n "])("does not send an empty text draft (%j)", (message) => {
    const { input } = renderComposer(message);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(doubles.control).not.toHaveBeenCalled();
  });

  it("waits for uploads and permits an attachment-only message once ready", async () => {
    const upload = deferred<UploadedAttachment>();
    doubles.upload.mockReturnValue(upload.promise);
    const { input } = renderComposer("");
    fireEvent.change(screen.getByLabelText(codexCopy["en-US"].attachment), {
      target: { files: [new File(["abc"], "note.txt", { type: "text/plain" })] },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(doubles.control).not.toHaveBeenCalled();
    await act(async () => upload.resolve(attachment));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(doubles.control).toHaveBeenCalledWith(
        "send",
        undefined,
        undefined,
        undefined,
        undefined,
        { attachmentIds: [attachment.id] },
      ),
    );
  });

  it("keeps failed attachments from dispatching a text message", async () => {
    doubles.upload.mockRejectedValue(new Error("upload failed"));
    const { input } = renderComposer();
    fireEvent.change(screen.getByLabelText(codexCopy["en-US"].attachment), {
      target: { files: [new File(["abc"], "note.txt")] },
    });
    await screen.findByRole("alert");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(doubles.control).not.toHaveBeenCalled();
  });

  it("does not send file references without message text or attachments", () => {
    doubles.session.access = {
      ...doubles.session.access,
      device: { ...doubles.session.access?.device, accessMode: "full" },
    } as SessionController["access"];
    const { input } = renderComposer("");
    fireEvent.click(screen.getByRole("button", { name: "Reference file" }));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText(composerLayoutCopy["en-US"].resourceNeedsMessage)).toBeVisible();
    expect(doubles.control).not.toHaveBeenCalled();
  });

  it("keeps resource references on the existing send path when text is present", async () => {
    doubles.session.access = {
      ...doubles.session.access,
      device: { ...doubles.session.access?.device, accessMode: "full" },
    } as SessionController["access"];
    const { input } = renderComposer();
    fireEvent.click(screen.getByRole("button", { name: "Reference file" }));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(doubles.control).toHaveBeenCalledWith(
        "send",
        undefined,
        undefined,
        undefined,
        undefined,
        { attachmentIds: [], resourceIds: ["file"] },
      ),
    );
  });

  it.each(["steer", "queue-add"] as const)(
    "keeps %s behind the existing advanced action",
    async (action) => {
      doubles.session.access = {
        ...doubles.session.access,
        device: { ...doubles.session.access?.device, advancedControl: true },
      } as SessionController["access"];
      doubles.session.canSend = false;
      doubles.session.canStop = true;
      doubles.session.live = {
        sessionId: "session",
        revision: 1,
        sendEnabled: false,
        status: "running",
        turnId: "turn",
        approvals: [],
        questions: [],
      } as SessionController["live"];
      const { input } = renderComposer();
      fireEvent.keyDown(input, { key: "Enter" });
      expect(doubles.control).not.toHaveBeenCalled();
      expect(doubles.codexAction).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Stop" })).toHaveClass("size-11");
      expect(screen.getByRole("button", { name: codexCopy["en-US"].advanced })).toHaveClass(
        "size-11",
      );
      fireEvent.click(screen.getByRole("button", { name: codexCopy["en-US"].advanced }));
      fireEvent.click(
        await screen.findByRole("menuitem", {
          name: action === "steer" ? codexCopy["en-US"].steer : codexCopy["en-US"].queueAdd,
        }),
      );
      await waitFor(() =>
        expect(doubles.codexAction).toHaveBeenCalledWith(action, {
          text: "Draft message",
          ...(action === "steer" ? { turnId: "turn" } : {}),
        }),
      );
      expect(doubles.control).not.toHaveBeenCalled();
    },
  );

  it("keeps queueing available during compaction without sending or steering", async () => {
    doubles.session.access = {
      ...doubles.session.access,
      device: { ...doubles.session.access?.device, advancedControl: true },
    } as SessionController["access"];
    doubles.session.canSend = false;
    doubles.session.live = {
      sessionId: "session",
      revision: 1,
      sendEnabled: false,
      status: "running",
      activity: "compacting",
      approvals: [],
      questions: [],
    } as SessionController["live"];
    const { input } = renderComposer();
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: codexCopy["en-US"].advanced }));
    const steer = await screen.findByRole("menuitem", { name: codexCopy["en-US"].steer });
    expect(steer).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("menuitem", { name: codexCopy["en-US"].queueAdd }));
    await waitFor(() =>
      expect(doubles.codexAction).toHaveBeenCalledExactlyOnceWith("queue-add", {
        text: "Draft message",
      }),
    );
    expect(doubles.control).not.toHaveBeenCalled();
  });

  it("locks concurrent Enter and form submissions before React rerenders", async () => {
    const request = deferred<boolean>();
    doubles.control.mockReturnValueOnce(request.promise);
    const { input, form } = renderComposer();
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.submit(form);
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(doubles.control).toHaveBeenCalledTimes(1);
    expect(input).toBeDisabled();
    await act(async () => request.resolve(true));
    expect(input).toBeEnabled();
    expect(input).toHaveValue("");
  });

  it("preserves a draft while the outcome is unknown and retries only after not-dispatched", async () => {
    doubles.control.mockResolvedValueOnce(undefined);
    const { input, rerender } = renderComposer();
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {});
    fireEvent.keyDown(input, { key: "Enter" });
    expect(doubles.control).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue("Draft message");
    expect(input).toBeDisabled();
    doubles.session.notice = "notDispatched";
    rerender(<SessionComposer />);
    expect(input).toBeEnabled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(doubles.control).toHaveBeenCalledTimes(2));
  });

  it("does not let a previous session's response clear a newer pending draft", async () => {
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    doubles.control.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { input, rerender } = renderComposer();
    fireEvent.keyDown(input, { key: "Enter" });
    doubles.session.selected = "second-session";
    rerender(<SessionComposer />);
    fireEvent.change(input, { target: { value: "New session draft" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(doubles.control).toHaveBeenCalledTimes(2);
    await act(async () => first.resolve(true));
    expect(input).toBeDisabled();
    expect(input).toHaveValue("New session draft");
    await act(async () => second.resolve(true));
    expect(input).toBeEnabled();
    expect(input).toHaveValue("");
  });

  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "omits the removed shortcut instruction in %s",
    (locale) => {
      doubles.session.locale = locale;
      const { input } = renderComposer();
      expect(screen.queryByText(composerLayoutCopy[locale].sendShortcut)).not.toBeInTheDocument();
      expect(input).not.toHaveAttribute("aria-describedby");
    },
  );
  function continuationFixture() {
    doubles.session.access!.status = "approved";
    doubles.session.access!.device!.id = "device";
    doubles.session.access!.device!.manage = true;
    doubles.session.capabilities!.features.fork = { available: true };
    doubles.session.capabilities!.features.send = { available: true };
    Object.assign(doubles.session.live!, {
      executionMode: "codex-managed",
      executionLocation: null,
      ownershipReason: null,
      reason: undefined,
    });
  }
  function externalOwner() {
    doubles.session.canSend = false;
    Object.assign(doubles.session.live!, {
      sendEnabled: false,
      executionLocation: "external",
      ownershipReason: "codex-owner-busy",
      reason: "codex-owner-busy",
    });
  }
  it("checks Claude on focus and keeps the composer directly available after background retirement", () => {
    continuationFixture();
    doubles.session.current = {
      id: "session",
      agent: "claude-code",
    } as SessionController["current"];
    Object.assign(doubles.session.live!, { executionMode: "claude-managed", status: "released" });
    doubles.session.checkContinuation = vi.fn(async () => {});
    const { input } = renderComposer();
    expect(input).toHaveAttribute("placeholder", "Continue this session…");
    fireEvent.focus(input);
    expect(doubles.session.checkContinuation).toHaveBeenCalledOnce();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });
  it("preserves a Claude draft and uploaded attachment through an owner conflict", async () => {
    continuationFixture();
    doubles.session.current = {
      id: "session",
      agent: "claude-code",
    } as SessionController["current"];
    Object.assign(doubles.session.live!, { executionMode: "claude-managed" });
    doubles.upload.mockResolvedValue(attachment);
    doubles.control.mockResolvedValue(false);
    const { input, form, rerender } = renderComposer("Claude draft");
    fireEvent.change(screen.getByLabelText(codexCopy["en-US"].attachment, { selector: "input" }), {
      target: { files: [new File(["abc"], "note.txt", { type: "text/plain" })] },
    });
    await screen.findByText("100%");
    fireEvent.submit(form);
    await act(async () => {});
    doubles.session.canSend = false;
    Object.assign(doubles.session.live!, {
      sendEnabled: false,
      executionLocation: "external",
      ownershipReason: "claude-owner-busy",
      reason: "claude-owner-busy",
    });
    rerender(<SessionComposer />);
    expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue in Claude Code" })).toBeEnabled();
    expect(input.isConnected).toBe(false);
    Object.assign(doubles.session.live!, {
      sendEnabled: true,
      executionLocation: null,
      ownershipReason: null,
      reason: undefined,
    });
    doubles.session.canSend = true;
    doubles.session.notice = "notDispatched";
    rerender(<SessionComposer />);
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Claude draft");
    expect(screen.getByText("note.txt")).toBeVisible();
    fireEvent.submit(screen.getByRole("textbox", { name: "Message" }).closest("form")!);
    await act(async () => {});
    expect(doubles.control).toHaveBeenCalledTimes(2);
    expect(doubles.control.mock.lastCall?.[5]).toEqual({ attachmentIds: ["attachment"] });
  });
  it("checks continuation on focus without presenting resume or handoff confirmation", () => {
    continuationFixture();
    doubles.session.checkContinuation = vi.fn(async () => {});
    const { input } = renderComposer();
    expect(input).toHaveAttribute("placeholder", "Continue this session…");
    fireEvent.focus(input);
    expect(doubles.session.checkContinuation).toHaveBeenCalledOnce();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText("Resume execution")).not.toBeInTheDocument();
  });
  it("preserves a rejected send draft through the owner choice and restores input after release", async () => {
    continuationFixture();
    const pending = deferred<boolean>();
    doubles.control.mockReturnValue(pending.promise);
    const { input, form, rerender } = renderComposer("Keep this draft");
    fireEvent.submit(form);
    await act(async () => pending.resolve(false));
    externalOwner();
    rerender(<SessionComposer />);
    expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fork and continue" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Continue in Codex" }));
    expect(screen.queryByRole("button", { name: "Fork and continue" })).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "This session is view only in AgentKib. You can continue here once it's closed in Codex.",
      ),
    ).toBeVisible();
    doubles.session.canSend = true;
    Object.assign(doubles.session.live!, {
      sendEnabled: true,
      executionLocation: null,
      ownershipReason: null,
      reason: undefined,
    });
    rerender(<SessionComposer />);
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Keep this draft");
    expect(doubles.control).toHaveBeenCalledTimes(1);
    expect(input.isConnected).toBe(false);
  });
  it("offers the host Claude command for unsupported platforms without dispatching", async () => {
    continuationFixture();
    doubles.session.current = {
      id: "session",
      agent: "claude-code",
    } as SessionController["current"];
    doubles.session.canSend = false;
    Object.assign(doubles.session.live!, {
      executionMode: "claude-managed",
      sendEnabled: false,
      reason: "platform-unsupported",
    });
    render(<SessionComposer />);
    expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
    expect(
      screen.getAllByText("Continuing Claude Code sessions here isn't supported on Windows yet"),
    ).toHaveLength(1);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Copy resume command" })).toBeEnabled(),
    );
    expect(doubles.resumeCommand).toHaveBeenCalledExactlyOnceWith(
      "session",
      expect.any(AbortSignal),
    );
    expect(doubles.control).not.toHaveBeenCalled();
    expect(doubles.codexAction).not.toHaveBeenCalled();
  });
  it("offers a verified host command for an unsupported Codex version without dispatching", async () => {
    continuationFixture();
    doubles.session.canSend = false;
    Object.assign(doubles.session.live!, {
      sendEnabled: false,
      reason: "codex-cli-version-too-old",
    });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<SessionComposer />);
    expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
    expect(
      screen.getAllByText("Your Codex version is too old. Update it to continue here."),
    ).toHaveLength(1);
    const button = screen.getByRole("button", { name: "Copy resume command" });
    await waitFor(() => expect(button).toBeEnabled());
    expect(doubles.resumeCommand).toHaveBeenCalledWith("session", expect.any(AbortSignal));
    fireEvent.click(button);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "CODEX_HOME='/host/codex' codex resume '00000000-0000-4000-8000-000000000001'",
      ),
    );
    expect(screen.getByText(/On the computer running AgentKib/)).toBeVisible();
    expect(doubles.control).not.toHaveBeenCalled();
    expect(doubles.codexAction).not.toHaveBeenCalled();
    expect(doubles.navigate).not.toHaveBeenCalled();
  });
  it("goes back to the existing owner without offering a second resume", () => {
    continuationFixture();
    externalOwner();
    const { rerender } = render(<SessionComposer />);
    fireEvent.click(screen.getByRole("button", { name: "Continue in Codex" }));
    expect(
      screen.getByText(
        "This session is view only in AgentKib. You can continue here once it's closed in Codex.",
      ),
    ).toBeVisible();
    // The session is already open there; running the resume command again would add a writer.
    expect(screen.queryByRole("button", { name: "Copy resume command" })).not.toBeInTheDocument();
    expect(doubles.resumeCommand).not.toHaveBeenCalled();
    doubles.session.selected = "next-session";
    doubles.session.current = {
      id: "next-session",
      agent: "codex",
    } as SessionController["current"];
    Object.assign(doubles.session.live!, { sessionId: "next-session" });
    doubles.session.capabilities!.sessionId = "next-session";
    rerender(<SessionComposer />);
    // The choice belongs to the session it was made for.
    expect(screen.getByRole("button", { name: "Continue in Codex" })).toBeEnabled();
    expect(doubles.resumeCommand).not.toHaveBeenCalled();
    expect(doubles.control).not.toHaveBeenCalled();
    expect(doubles.codexAction).not.toHaveBeenCalled();
  });
  it("opens the fork returned by the guarded controller action", async () => {
    continuationFixture();
    externalOwner();
    doubles.session.forkContinuation = vi.fn(async () => "forked-session");
    render(<SessionComposer />);
    fireEvent.click(screen.getByRole("button", { name: "Fork and continue" }));
    await waitFor(() =>
      expect(doubles.navigate).toHaveBeenCalledWith({
        to: "/sessions/$sessionId",
        params: { sessionId: "forked-session" },
      }),
    );
    expect(doubles.session.forkContinuation).toHaveBeenCalledOnce();
    expect(doubles.control).not.toHaveBeenCalled();
  });
  it("allows returning to Codex when management permission disables forking", () => {
    continuationFixture();
    externalOwner();
    doubles.session.access!.device!.manage = false;
    render(<SessionComposer />);
    expect(screen.getByRole("button", { name: "Fork and continue" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Continue in Codex" })).toBeEnabled();
  });
  it("passes original files and resource selections to an occupied-session fork without sending", async () => {
    continuationFixture();
    doubles.session.forkContinuation = vi.fn(async () => "forked");
    doubles.session.access!.device!.accessMode = "full";
    doubles.upload.mockResolvedValue(attachment);
    const file = new File(["abc"], "branch.txt", { type: "text/plain" });
    const { rerender } = renderComposer("");
    fireEvent.change(screen.getByLabelText(codexCopy["en-US"].attachment, { selector: "input" }), {
      target: { files: [file] },
    });
    await screen.findByText("100%");
    fireEvent.click(screen.getByRole("button", { name: "Reference file" }));
    externalOwner();
    rerender(<SessionComposer />);
    fireEvent.click(screen.getByRole("button", { name: "Fork and continue" }));
    await waitFor(() =>
      expect(doubles.session.forkContinuation).toHaveBeenCalledWith({
        files: [file],
        resources: [{ id: "file", kind: "file", name: "README", available: true }],
      }),
    );
    expect(doubles.control).not.toHaveBeenCalled();
  });
  it("uploads a transferred attachment to the branch once and permits an attachment-only draft after completion", async () => {
    const file = new File(["abc"], "branch.txt", { type: "text/plain" });
    const upload = deferred<UploadedAttachment>();
    doubles.upload.mockReturnValue(upload.promise);
    doubles.session.takeContinuationDraft = vi
      .fn()
      .mockReturnValueOnce({ files: [file], resources: [], historyReferences: [] });
    const { input, rerender } = renderComposer("");
    expect(doubles.upload).toHaveBeenCalledExactlyOnceWith(
      "session",
      file,
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(screen.getByText("branch.txt")).toBeVisible();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(doubles.control).not.toHaveBeenCalled();
    await act(async () => upload.resolve({ ...attachment, id: "branch-attachment" }));
    rerender(<SessionComposer />);
    expect(doubles.upload).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(doubles.control).toHaveBeenCalledWith(
        "send",
        undefined,
        undefined,
        undefined,
        undefined,
        { attachmentIds: ["branch-attachment"] },
      ),
    );
  });
  it("keeps a transferred file visible and blocks sending after target upload failure", async () => {
    const file = new File(["abc"], "branch.txt");
    doubles.upload.mockRejectedValue(new Error("upload failed"));
    doubles.session.takeContinuationDraft = vi
      .fn()
      .mockReturnValueOnce({ files: [file], resources: [], historyReferences: [] });
    const { input } = renderComposer("Keep accompanying text");
    await screen.findByRole("alert");
    expect(screen.getByText("branch.txt")).toBeVisible();
    expect(input).toHaveValue("Keep accompanying text");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(doubles.control).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: `${codexCopy["en-US"].remove}: branch.txt` }),
    ).toBeEnabled();
  });
  it.each(["codex", "claude-code"] as const)(
    "keeps failed branch files for a later %s fork, including distinct files with the same name",
    async (agent) => {
      continuationFixture();
      doubles.session.current = { ...doubles.session.current!, agent };
      Object.assign(doubles.session.live!, {
        executionMode: agent === "claude-code" ? "claude-managed" : "codex-managed",
      });
      const files = [new File(["first"], "branch.txt"), new File(["second"], "branch.txt")];
      doubles.upload.mockRejectedValue(new Error("upload failed"));
      doubles.session.takeContinuationDraft = vi
        .fn()
        .mockReturnValueOnce({ files, resources: [], historyReferences: [] });
      doubles.session.forkContinuation = vi.fn(async () => "next-branch");
      const { input, rerender } = renderComposer("Keep accompanying text");
      await screen.findByRole("alert");
      expect(screen.getAllByText("branch.txt")).toHaveLength(2);
      expect(input).toHaveValue("Keep accompanying text");
      externalOwner();
      const reason = agent === "claude-code" ? "claude-owner-busy" : "codex-owner-busy";
      Object.assign(doubles.session.live!, { reason, ownershipReason: reason });
      rerender(<SessionComposer />);
      fireEvent.click(screen.getByRole("button", { name: "Fork and continue" }));
      await waitFor(() =>
        expect(doubles.session.forkContinuation).toHaveBeenCalledExactlyOnceWith({
          files,
          resources: [],
        }),
      );
      expect(doubles.control).not.toHaveBeenCalled();
      expect(doubles.codexAction).not.toHaveBeenCalled();
    },
  );
  it("retains transferred resource descriptors for reselection and never dispatches source context IDs", () => {
    const take = vi.fn().mockReturnValueOnce({
      files: [],
      resources: [
        {
          id: "source-resource",
          kind: "file",
          name: "README",
          available: true,
          navigationId: "source-directory",
        },
      ],
      historyReferences: [],
    });
    doubles.session.takeContinuationDraft = take;
    const { input, rerender } = renderComposer("Keep resource draft");
    expect(screen.getByText(codexCopy["en-US"].resourceRemoved)).toBeVisible();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(doubles.control).not.toHaveBeenCalled();
    rerender(<SessionComposer />);
    expect(take).toHaveBeenCalledTimes(1);
  });
  it("ignores a transferred upload completing after another session is selected", async () => {
    const file = new File(["abc"], "old-branch.txt");
    const upload = deferred<UploadedAttachment>();
    doubles.upload.mockReturnValue(upload.promise);
    doubles.session.takeContinuationDraft = vi
      .fn()
      .mockReturnValueOnce({ files: [file], resources: [], historyReferences: [] });
    const { input, rerender } = renderComposer("Original branch draft");
    expect(screen.getByText("old-branch.txt")).toBeVisible();
    doubles.session.selected = "other";
    doubles.session.current = { ...doubles.session.current!, id: "other" };
    doubles.session.capabilities = { ...doubles.session.capabilities!, sessionId: "other" };
    rerender(<SessionComposer />);
    fireEvent.change(input, { target: { value: "New selection draft" } });
    await act(async () => upload.resolve(attachment));
    expect(screen.queryByText("old-branch.txt")).not.toBeInTheDocument();
    expect(input).toHaveValue("New selection draft");
    expect(doubles.control).not.toHaveBeenCalled();
  });
  it("waits for other controls to finish before consuming and uploading the branch draft", async () => {
    const file = new File(["abc"], "waiting.txt");
    const take = vi
      .fn()
      .mockReturnValueOnce({ files: [file], resources: [], historyReferences: [] });
    doubles.session.takeContinuationDraft = take;
    doubles.session.busy = true;
    doubles.upload.mockResolvedValue(attachment);
    const { rerender } = renderComposer("");
    expect(take).not.toHaveBeenCalled();
    expect(doubles.upload).not.toHaveBeenCalled();
    doubles.session.busy = false;
    rerender(<SessionComposer />);
    await screen.findByText("waiting.txt");
    expect(doubles.upload).toHaveBeenCalledExactlyOnceWith(
      "session",
      file,
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(doubles.control).not.toHaveBeenCalled();
  });
});
