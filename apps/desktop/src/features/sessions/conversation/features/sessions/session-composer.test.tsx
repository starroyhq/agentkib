// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { render } from "@/features/sessions/conversation/desktop-reader-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadedAttachment } from "@agentkib/web-client";
import {
  composerAddCopy,
  sessionContinuationCopy,
  offerNewSessionDraft,
  takeNewSessionDraft,
} from "@agentkib/session-ui";
import { SessionComposer } from "@/features/sessions/conversation/desktop-session-composer";
import { composerLayoutCopy } from "@agentkib/session-ui";
import { sessionCopy } from "../../session-copy";
import type { SessionResource } from "@agentkib/web-client";
import type { SessionPanels } from "@agentkib/session-ui";
import type { SessionController } from "../../desktop-session-controller";

const doubles = vi.hoisted(() => ({
  session: {} as Partial<SessionController>,
  panels: null as SessionPanels | null,
  control: vi.fn(),
  runSessionAction: vi.fn(),
  navigate: vi.fn(),
  upload: vi.fn(),
  resumeCommand: vi.fn(),
}));
vi.mock("../../desktop-session-navigation", () => ({ useSessionNavigate: () => doubles.navigate }));
vi.mock("../../desktop-session-context", () => ({
  useSession: () => {
    const [message, setMessage] = useState("");
    return { ...doubles.session, message, setMessage } as SessionController;
  },
}));
vi.mock("@agentkib/session-ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@agentkib/session-ui")>()),
  useSessionPanels: () => doubles.panels,
  SessionContextUsageGauge: () => null,
  SessionComposerControls: ({
    action,
    setResources,
  }: {
    action: ReactNode;
    setResources: (resources: SessionResource[]) => void;
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

async function expectUploadedFile(name: string) {
  const row = (await screen.findByText(name)).closest("li")!;
  await waitFor(() => expect(row).not.toHaveAttribute("aria-busy"));
  expect(within(row).queryByText("100%")).not.toBeInTheDocument();
}

describe("composer sending shortcuts", () => {
  beforeEach(() => {
    localStorage.removeItem("agentkib.send-while-running");
    vi.resetAllMocks();
    doubles.panels = null;
    doubles.control.mockResolvedValue(true);
    doubles.resumeCommand.mockResolvedValue({
      available: true,
      command: "CODEX_HOME='/host/codex' codex resume '00000000-0000-4000-8000-000000000001'",
      shell: "posix",
      runOn: "host",
    });
    doubles.runSessionAction.mockResolvedValue({ accepted: true });
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
      runSessionAction: doubles.runSessionAction,
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
    localStorage.removeItem("agentkib.send-while-running");
    vi.unstubAllGlobals();
  });

  it("submits Enter through the same form path as the send button", async () => {
    const { input, form } = renderComposer();
    expect(screen.getByRole("button", { name: "Send" })).toHaveClass("pointer-coarse:size-11");
    expect(screen.getByRole("button", { name: sessionCopy["en-US"].addContext })).toHaveClass(
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
    expect(doubles.runSessionAction).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "Second message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(doubles.control).toHaveBeenCalledTimes(2));
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

  it("shows terminal guidance only for the pending interaction and keeps the draft intact", () => {
    continuationFixture();
    doubles.session.current = {
      id: "session",
      agent: "claude-code",
    } as SessionController["current"];
    Object.assign(doubles.session.live!, {
      executionMode: "claude-follower",
      executionLocation: "terminal",
    });
    const approval = "Waiting for tool approval. Please handle it in the terminal.";
    const question = "Waiting for an answer. Please respond in the terminal.";
    const { rerender, input } = renderComposer();
    expect(screen.queryByText("Handle approvals and questions in the terminal")).toBeNull();
    expect(screen.queryByText(approval)).toBeNull();
    Object.assign(doubles.session.live!, {
      reason: "claude-terminal-approval",
      status: "awaiting-approval",
    });
    rerender(<SessionComposer />);
    expect(screen.getByText(approval)).toBeVisible();
    Object.assign(doubles.session.live!, {
      reason: "claude-terminal-question",
      status: "waiting-input",
    });
    rerender(<SessionComposer />);
    expect(screen.queryByText(approval)).toBeNull();
    expect(screen.getByText(question)).toBeVisible();
    // A stale reason can outlast the live status on reconnect.
    Object.assign(doubles.session.live!, { status: "idle" });
    rerender(<SessionComposer />);
    expect(screen.queryByText(question)).toBeNull();
    expect(input).toHaveValue("Draft message");
    expect(
      screen.queryByRole("button", { name: /Connect.*terminal|Manage terminal/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
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
    expect(doubles.runSessionAction).not.toHaveBeenCalled();
    expect(screen.queryByText(composerLayoutCopy["en-US"].sendShortcut)).not.toBeInTheDocument();
  });

  it.each(["", " \n "])("does not send an empty text draft (%j)", (message) => {
    const { input } = renderComposer(message);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(doubles.control).not.toHaveBeenCalled();
  });

  it("opens the native attachment picker from the shared menu only with scoped access", async () => {
    const copy = sessionCopy["en-US"];
    doubles.session.capabilities!.sessionId = "another-session";
    const { rerender } = renderComposer();
    const addContext = screen.getByRole("button", { name: copy.addContext });
    const fileInput = screen.getByLabelText(copy.attachment);
    const pickFiles = vi.spyOn(fileInput, "click");

    expect(addContext).toBeDisabled();
    expect(fileInput).toBeDisabled();
    expect(pickFiles).not.toHaveBeenCalled();

    doubles.session.capabilities!.sessionId = "session";
    rerender(<SessionComposer />);
    expect(addContext).toBeEnabled();
    fireEvent.click(addContext);
    const menu = await screen.findByRole("dialog", { name: copy.addContext });
    expect(pickFiles).not.toHaveBeenCalled();
    fireEvent.click(
      within(menu).getByRole("button", { name: composerAddCopy("en-US").attachment }),
    );
    expect(pickFiles).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(menu).not.toBeVisible());

    doubles.session.access!.device!.attachments = false;
    rerender(<SessionComposer />);
    expect(addContext).toBeDisabled();
    expect(fileInput).toBeDisabled();
  });

  it("uses the same attachment intake for desktop paste and drop as the file picker", async () => {
    const { input, form } = renderComposer();
    doubles.upload.mockImplementation(async (_sessionId: string, file: File) => ({
      ...attachment,
      id: file.name,
      name: file.name,
      mime: file.type,
      size: file.size,
    }));
    const screenshot = new File(["png"], "Screenshot.png", { type: "image/png" });
    const copied = new File(["pdf"], "Finder copy.pdf", { type: "application/pdf" });
    expect(
      fireEvent.paste(input, {
        clipboardData: { files: [], items: [{ kind: "file", getAsFile: () => screenshot }] },
      }),
    ).toBe(false);
    expect(fireEvent.drop(form, { dataTransfer: { files: [copied], types: ["Files"] } })).toBe(
      false,
    );

    await screen.findByText(copied.name);
    expect(doubles.upload.mock.calls.map(([, file]) => file)).toEqual([screenshot, copied]);
    expect(form).not.toHaveAttribute("data-attachment-rejected");
  });

  it("waits for uploads and permits an attachment-only message once ready", async () => {
    const upload = deferred<UploadedAttachment>();
    doubles.upload.mockReturnValue(upload.promise);
    const { input } = renderComposer("");
    fireEvent.change(screen.getByLabelText(sessionCopy["en-US"].attachment), {
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
    fireEvent.change(screen.getByLabelText(sessionCopy["en-US"].attachment), {
      target: { files: [new File(["abc"], "note.txt")] },
    });
    const error = await screen.findByText(sessionCopy["en-US"].uploadFailed, {
      selector: '[role="status"]',
    });
    expect(within(error.closest("li")!).getByRole("button", { name: "Retry" })).toBeEnabled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(doubles.control).not.toHaveBeenCalled();
  });

  it("does not send file references without message text or attachments", () => {
    grantWorkspaceReferences();
    const { input } = renderComposer("");
    fireEvent.click(screen.getByRole("button", { name: "Reference file" }));
    expect(screen.queryByText(composerLayoutCopy["en-US"].resourceNeedsMessage)).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText(composerLayoutCopy["en-US"].resourceNeedsMessage)).toBeVisible();
    expect(doubles.control).not.toHaveBeenCalled();
  });

  it("keeps resource references on the existing send path when text is present", async () => {
    grantWorkspaceReferences();
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

  it.each([
    [null, "steer", "queue-add", { metaKey: true }],
    ["queue", "queue-add", "steer", { ctrlKey: true }],
  ] as const)(
    "uses the stored preference %s for Send and alternates for one message",
    async (preference, action, alternate, modifier) => {
      if (preference) localStorage.setItem("agentkib.send-while-running", preference);
      doubles.session.access = {
        ...doubles.session.access,
        status: "approved",
        device: { ...doubles.session.access?.device, advancedControl: true },
      } as SessionController["access"];
      doubles.session.canSend = false;
      doubles.session.canStop = true;
      doubles.session.live = {
        sessionId: "session",
        revision: 1,
        sendEnabled: false,
        status: "running",
        executionLocation: "agentkib",
        turnId: "turn",
        approvals: [],
        questions: [],
      } as SessionController["live"];
      const { input } = renderComposer();
      const label = action === "steer" ? sessionCopy["en-US"].steer : sessionCopy["en-US"].queueAdd;
      const send = screen.getByRole("button", { name: label });
      expect(send).toBeEnabled();
      expect(screen.queryByRole("button", { name: sessionCopy["en-US"].advanced })).toBeNull();
      expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();

      if (preference) fireEvent.click(send);
      else fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() =>
        expect(doubles.runSessionAction).toHaveBeenCalledExactlyOnceWith(action, {
          text: "Draft message",
          ...(action === "steer" ? { turnId: "turn" } : {}),
        }),
      );
      await waitFor(() => expect(input).toHaveValue(""));
      expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();

      fireEvent.change(input, { target: { value: "Another follow-up" } });
      fireEvent.keyDown(input, { key: "Enter", ...modifier, repeat: true });
      fireEvent.keyDown(input, { key: "Enter", ...modifier, isComposing: true });
      fireEvent.keyDown(input, { key: "Enter", ...modifier, shiftKey: true });
      expect(doubles.runSessionAction).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(input, { key: "Enter", ...modifier });
      await waitFor(() =>
        expect(doubles.runSessionAction).toHaveBeenNthCalledWith(2, alternate, {
          text: "Another follow-up",
          ...(alternate === "steer" ? { turnId: "turn" } : {}),
        }),
      );
      await waitFor(() => expect(input).toHaveValue(""));
      expect(localStorage.getItem("agentkib.send-while-running")).toBe(preference);
      expect(doubles.control).not.toHaveBeenCalled();
    },
  );

  it.each(["devin", "antigravity"])(
    "only queues follow-ups for %s even with the steering preference",
    async (agent) => {
      localStorage.setItem("agentkib.send-while-running", "steer");
      doubles.session.current = { id: "session", agent } as SessionController["current"];
      doubles.session.access = {
        ...doubles.session.access,
        status: "approved",
        device: { ...doubles.session.access?.device, advancedControl: true },
      } as SessionController["access"];
      doubles.session.canSend = false;
      doubles.session.live = {
        ...doubles.session.live!,
        status: "running",
        turnId: "turn",
      };
      const { input } = renderComposer();
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(input).toHaveValue(""));
      fireEvent.change(input, { target: { value: "Another follow-up" } });
      fireEvent.keyDown(input, { key: "Enter", metaKey: true });
      await waitFor(() => expect(input).toHaveValue(""));
      expect(doubles.runSessionAction.mock.calls).toEqual([
        ["queue-add", { text: "Draft message" }],
        ["queue-add", { text: "Another follow-up" }],
      ]);
      expect(doubles.control).not.toHaveBeenCalled();
    },
  );

  it("keeps queueing available during compaction without sending or steering", async () => {
    doubles.session.access = {
      ...doubles.session.access,
      status: "approved",
      device: { ...doubles.session.access?.device, advancedControl: true },
    } as SessionController["access"];
    doubles.session.canSend = false;
    doubles.session.live = {
      sessionId: "session",
      revision: 1,
      sendEnabled: false,
      status: "running",
      executionLocation: "agentkib",
      activity: "compacting",
      approvals: [],
      questions: [],
    } as SessionController["live"];
    const { input } = renderComposer();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(doubles.runSessionAction).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    await waitFor(() =>
      expect(doubles.runSessionAction).toHaveBeenCalledExactlyOnceWith("queue-add", {
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

  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "omits the removed shortcut instruction in %s",
    (locale) => {
      doubles.session.locale = locale;
      const { input } = renderComposer();
      expect(screen.queryByText(composerLayoutCopy[locale].sendShortcut)).not.toBeInTheDocument();
      expect(input).not.toHaveAttribute("aria-describedby");
    },
  );
  function grantWorkspaceReferences() {
    Object.assign(doubles.session.access!.device!, { accessMode: "full", advancedControl: true });
    doubles.session.capabilities!.features.context = { available: true };
  }
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
  it.each([
    ["zh-CN", "这条会话正在 Codex 中使用。"],
    ["zh-Hant", "這段對話正在 Codex 中使用。"],
    ["en-US", "This session is in use in Codex."],
    ["ja-JP", "この会話は Codex で使用中です。"],
  ] as const)(
    "keeps an editable composer and a passive ownership hint in %s",
    (locale, busyHint) => {
      continuationFixture();
      externalOwner();
      doubles.session.locale = locale;
      const { input } = renderComposer("Keep the draft");
      expect(input).toBeEnabled();
      expect(screen.getByText(busyHint)).toBeVisible();
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
      expect(doubles.control).not.toHaveBeenCalled();
      expect(doubles.runSessionAction).not.toHaveBeenCalled();
    },
  );

  it("keeps the Codex follower composer enabled without the explanatory hint or busy bar", () => {
    continuationFixture();
    Object.assign(doubles.session.live!, {
      executionMode: "codex-follower",
      executionLocation: "external",
      sendEnabled: true,
    });
    doubles.session.capabilities!.features.steer = {
      available: false,
      reason: "follower-operation-unverified",
    };
    doubles.session.capabilities!.features["queue-add"] = {
      available: false,
      reason: "follower-operation-unverified",
    };
    const { input } = renderComposer();
    expect(
      screen.queryByText("Messages run in Codex, using the model and permissions set there"),
    ).not.toBeInTheDocument();
    expect(input).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: sessionCopy["en-US"].advanced }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/in use in Codex/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });
  it("shows stop and keeps unavailable follow-ups unsent during a followed turn", () => {
    continuationFixture();
    doubles.session.canStop = true;
    Object.assign(doubles.session.live!, {
      executionMode: "codex-follower",
      executionLocation: "external",
      status: "running",
      turnId: "followed-turn",
      sendEnabled: false,
      stopEnabled: true,
    });
    doubles.session.capabilities!.features.steer = {
      available: false,
      reason: "follower-operation-unverified",
    };
    doubles.session.capabilities!.features["queue-add"] = {
      available: false,
      reason: "follower-operation-unverified",
    };
    const { input } = renderComposer();
    expect(screen.getByRole("button", { name: "Stop" })).toBeVisible();
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(input).toHaveValue("Draft message");
    expect(doubles.runSessionAction).not.toHaveBeenCalled();
    expect(screen.queryByText(/in use in Codex/i)).not.toBeInTheDocument();
  });
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
    fireEvent.change(
      screen.getByLabelText(sessionCopy["en-US"].attachment, { selector: "input" }),
      {
        target: { files: [new File(["abc"], "note.txt", { type: "text/plain" })] },
      },
    );
    await expectUploadedFile("note.txt");
    fireEvent.submit(form);
    await act(async () => {});
    doubles.session.notice = "notDispatched";
    doubles.session.canSend = false;
    Object.assign(doubles.session.live!, {
      sendEnabled: false,
      executionLocation: "external",
      ownershipReason: "claude-owner-busy",
      reason: "claude-owner-busy",
    });
    rerender(<SessionComposer />);
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(input);
    expect(input).toHaveValue("Claude draft");
    expect(input).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByText("This session is in use in Claude Code.")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Continue in Claude Code" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("note.txt")).toBeVisible();
    expect(input.isConnected).toBe(true);
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
  it("keeps the input mounted and editable through external ownership, then restores only explicit sending", async () => {
    continuationFixture();
    const pending = deferred<boolean>();
    doubles.control.mockReturnValue(pending.promise);
    const { input, form, rerender } = renderComposer("Keep this draft");
    fireEvent.submit(form);
    await act(async () => pending.resolve(false));
    doubles.session.notice = "notDispatched";
    externalOwner();
    rerender(<SessionComposer />);
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(input);
    expect(input).toHaveValue("Keep this draft");
    expect(input).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Fork and continue" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue in Codex" })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "Draft edited while occupied" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.submit(form);
    expect(doubles.control).toHaveBeenCalledTimes(1);
    doubles.session.canSend = true;
    Object.assign(doubles.session.live!, {
      sendEnabled: true,
      executionLocation: null,
      ownershipReason: null,
      reason: undefined,
    });
    rerender(<SessionComposer />);
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(input);
    expect(input).toHaveValue("Draft edited while occupied");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    expect(doubles.control).toHaveBeenCalledTimes(1);
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
    expect(doubles.runSessionAction).not.toHaveBeenCalled();
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
    // The desktop app runs on the host, so the help does not point at another computer.
    expect(screen.getByText(/^Open a terminal \(use PowerShell on Windows\)/)).toBeVisible();
    expect(screen.queryByText(/On the computer running AgentKib/)).not.toBeInTheDocument();
    expect(doubles.control).not.toHaveBeenCalled();
    expect(doubles.runSessionAction).not.toHaveBeenCalled();
    expect(doubles.navigate).not.toHaveBeenCalled();
  });
  it("keeps ownership passive across selection changes without opening or copying another resume", () => {
    continuationFixture();
    externalOwner();
    const { input, rerender } = renderComposer("Keep owner draft");
    expect(input).toBeEnabled();
    expect(
      screen.queryByRole("button", {
        name: /Continue in Codex|Copy resume command|Fork and continue/,
      }),
    ).not.toBeInTheDocument();
    doubles.session.selected = "next-session";
    doubles.session.current = {
      id: "next-session",
      agent: "codex",
    } as SessionController["current"];
    Object.assign(doubles.session.live!, { sessionId: "next-session" });
    doubles.session.capabilities!.sessionId = "next-session";
    rerender(<SessionComposer />);
    expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(doubles.resumeCommand).not.toHaveBeenCalled();
    expect(doubles.control).not.toHaveBeenCalled();
    expect(doubles.runSessionAction).not.toHaveBeenCalled();
  });

  it("keeps a watch-only connected terminal on the ordinary composer without dispatching", () => {
    continuationFixture();
    doubles.session.current = {
      id: "session",
      agent: "claude-code",
    } as SessionController["current"];
    doubles.session.canSend = false;
    Object.assign(doubles.session.live!, {
      executionMode: "claude-follower",
      executionLocation: "terminal",
      terminalSend: false,
      sendEnabled: false,
      reason: undefined,
    });
    const { input, form } = renderComposer("Prepare the next message");
    expect(input).toBeEnabled();
    expect(screen.getByText(sessionContinuationCopy("en-US").terminalWatch)).toBeVisible();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.submit(form);
    expect(doubles.control).not.toHaveBeenCalled();
    expect(doubles.runSessionAction).not.toHaveBeenCalled();
    expect(doubles.resumeCommand).not.toHaveBeenCalled();
  });

  it("keeps the draft editable and send disabled while Claude's terminal model picker is open", () => {
    continuationFixture();
    doubles.session.current = { ...doubles.session.current!, agent: "claude-code" };
    Object.assign(doubles.session.live!, {
      executionMode: "claude-follower",
      executionLocation: "terminal",
      status: "idle",
      reason: "claude-model-picker-open",
      terminalSend: false,
      sendEnabled: false,
    });
    doubles.session.capabilities!.features.send = { available: false };
    doubles.session.canSend = false;
    const { input, form, rerender } = renderComposer("Keep this draft");
    expect(input).toBeEnabled();
    expect(
      screen.queryByText(sessionContinuationCopy("en-US").terminalWatch),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.submit(form);
    expect(doubles.control).not.toHaveBeenCalled();

    Object.assign(doubles.session.live!, {
      reason: undefined,
      terminalSend: true,
      sendEnabled: true,
    });
    doubles.session.capabilities!.features.send = { available: true };
    doubles.session.canSend = true;
    rerender(<SessionComposer />);
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Keep this draft");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("does not offer a forced ownership action even when management permission is absent", () => {
    continuationFixture();
    externalOwner();
    doubles.session.access!.device!.manage = false;
    doubles.session.forkContinuation = vi.fn();
    const { input } = renderComposer();
    expect(input).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: /Fork and continue|Continue in Codex/ }),
    ).not.toBeInTheDocument();
    expect(doubles.session.forkContinuation).not.toHaveBeenCalled();
  });

  it("keeps a staged goal when the executor cannot apply it and verifies it on explicit send", async () => {
    grantWorkspaceReferences();
    doubles.session.current = { ...doubles.session.current!, agent: "claude-code" };
    Object.assign(doubles.session.live!, {
      executionMode: "claude-follower",
      executionLocation: "terminal",
    });
    doubles.session.capabilities!.features["goal-set"] = { available: false };
    offerNewSessionDraft("session", {
      text: "Start work",
      files: [],
      goal: { objective: "Finish review" },
    });
    const { rerender } = render(<SessionComposer />);
    const input = screen.getByRole("textbox", { name: "Message" });
    expect(input).toHaveValue("Start work");
    fireEvent.change(input, { target: { value: "Review the final changes" } });
    fireEvent.submit(input.closest("form")!);
    expect(doubles.control).not.toHaveBeenCalled();
    Object.assign(doubles.session.live!, {
      executionMode: "claude-managed",
      executionLocation: "agentkib",
    });
    doubles.session.capabilities!.features["goal-draft"] = { available: true };
    rerender(<SessionComposer />);
    expect(input).toHaveValue("Review the final changes");
    expect(doubles.control).not.toHaveBeenCalled();
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(doubles.control).toHaveBeenCalledOnce());
    expect(doubles.control.mock.lastCall?.[5]).toEqual({ attachmentIds: [], requiresGoal: true });
  });

  it("retains prepared attachments and references when the terminal accepts only text", async () => {
    continuationFixture();
    grantWorkspaceReferences();
    doubles.session.current = { ...doubles.session.current!, agent: "claude-code" };
    doubles.upload.mockResolvedValue(attachment);
    const { input, form, rerender } = renderComposer();
    fireEvent.change(
      screen.getByLabelText(sessionCopy["en-US"].attachment, { selector: "input" }),
      {
        target: { files: [new File(["abc"], "note.txt", { type: "text/plain" })] },
      },
    );
    await expectUploadedFile("note.txt");
    fireEvent.click(screen.getByRole("button", { name: "Reference file" }));
    Object.assign(doubles.session.live!, {
      executionMode: "claude-follower",
      executionLocation: "terminal",
    });
    Object.assign(doubles.session.capabilities!.features, {
      attachments: { available: false },
      context: { available: false },
      resources: { available: true },
    });
    rerender(<SessionComposer />);
    expect(screen.getByText("note.txt")).toBeVisible();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.submit(form);
    expect(doubles.control).not.toHaveBeenCalled();
    Object.assign(doubles.session.live!, {
      executionMode: "claude-managed",
      executionLocation: "agentkib",
    });
    Object.assign(doubles.session.capabilities!.features, {
      attachments: { available: true },
      context: { available: true },
    });
    rerender(<SessionComposer />);
    expect(input).toHaveValue("Draft message");
    expect(doubles.control).not.toHaveBeenCalled();
    fireEvent.submit(form);
    await waitFor(() => expect(doubles.control).toHaveBeenCalledOnce());
    expect(doubles.control.mock.lastCall?.[5]).toEqual({
      attachmentIds: ["attachment"],
      resourceIds: ["file"],
    });
  });

  it("retains existing files and resource selections in the same composer while occupied", async () => {
    grantWorkspaceReferences();
    continuationFixture();
    doubles.session.forkContinuation = vi.fn();
    doubles.session.access!.device!.accessMode = "full";
    doubles.upload.mockResolvedValue(attachment);
    const file = new File(["abc"], "branch.txt", { type: "text/plain" });
    const { input, form, rerender } = renderComposer("Draft with context");
    fireEvent.change(
      screen.getByLabelText(sessionCopy["en-US"].attachment, { selector: "input" }),
      {
        target: { files: [file] },
      },
    );
    await expectUploadedFile("branch.txt");
    fireEvent.click(screen.getByRole("button", { name: "Reference file" }));
    externalOwner();
    rerender(<SessionComposer />);
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(input);
    expect(screen.getByText("branch.txt")).toBeVisible();
    expect(screen.getByRole("button", { name: "Reference file" })).toBeVisible();
    fireEvent.submit(form);
    expect(doubles.session.forkContinuation).not.toHaveBeenCalled();
    expect(doubles.control).not.toHaveBeenCalled();
    doubles.session.canSend = true;
    Object.assign(doubles.session.live!, {
      sendEnabled: true,
      executionLocation: null,
      ownershipReason: null,
      reason: undefined,
    });
    rerender(<SessionComposer />);
    fireEvent.submit(form);
    await waitFor(() => expect(doubles.control).toHaveBeenCalledTimes(1));
    expect(doubles.control.mock.lastCall?.[5]).toEqual({
      attachmentIds: ["attachment"],
      resourceIds: ["file"],
    });
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
    expect(
      await screen.findByText(sessionCopy["en-US"].uploadFailed, { selector: '[role="status"]' }),
    ).toBeVisible();
    expect(screen.getByText("branch.txt")).toBeVisible();
    expect(input).toHaveValue("Keep accompanying text");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(doubles.control).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: `${sessionCopy["en-US"].remove}: branch.txt` }),
    ).toBeEnabled();
  });
  it.each(["codex", "claude-code"] as const)(
    "retains failed transferred files through a %s ownership change, including duplicate names",
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
      await waitFor(() =>
        expect(
          screen.getAllByText(sessionCopy["en-US"].uploadFailed, { selector: '[role="status"]' }),
        ).toHaveLength(2),
      );
      expect(screen.getAllByText("branch.txt")).toHaveLength(2);
      expect(input).toHaveValue("Keep accompanying text");
      externalOwner();
      const reason = agent === "claude-code" ? "claude-owner-busy" : "codex-owner-busy";
      Object.assign(doubles.session.live!, { reason, ownershipReason: reason });
      rerender(<SessionComposer />);
      expect(screen.getByRole("textbox", { name: "Message" })).toBe(input);
      expect(screen.getAllByText("branch.txt")).toHaveLength(2);
      expect(input).toHaveValue("Keep accompanying text");
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
      expect(doubles.session.forkContinuation).not.toHaveBeenCalled();
      expect(doubles.control).not.toHaveBeenCalled();
      expect(doubles.runSessionAction).not.toHaveBeenCalled();
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
    expect(screen.getByText(sessionCopy["en-US"].resourceRemoved)).toBeVisible();
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
  it("sends a new session's first message with workspace references once, after its files upload", async () => {
    grantWorkspaceReferences();
    const file = new File(["abc"], "spec.md", { type: "text/markdown" });
    const upload = deferred<UploadedAttachment>();
    doubles.upload.mockReturnValue(upload.promise);
    offerNewSessionDraft("session", {
      text: "Add rate limiting",
      files: [file],
      resources: [{ id: "draft-resource", kind: "file", name: "README.md", available: true }],
    });
    const { rerender } = render(<SessionComposer />);
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Add rate limiting");
    expect(screen.getByText("spec.md")).toBeVisible();
    expect(doubles.control).not.toHaveBeenCalled();
    await act(async () => upload.resolve({ ...attachment, id: "spec" }));
    rerender(<SessionComposer />);
    await waitFor(() =>
      expect(doubles.control).toHaveBeenCalledExactlyOnceWith(
        "send",
        undefined,
        undefined,
        undefined,
        undefined,
        { attachmentIds: ["spec"], resourceIds: ["draft-resource"] },
      ),
    );
    rerender(<SessionComposer />);
    expect(doubles.control).toHaveBeenCalledOnce();
    expect(takeNewSessionDraft("session")).toBeUndefined();
  });
  it("leaves a new session's first message as the draft once it is edited before it can go", async () => {
    doubles.session.canSend = false;
    offerNewSessionDraft("session", { text: "Add rate limiting", files: [] });
    const { rerender } = render(<SessionComposer />);
    const input = screen.getByRole("textbox", { name: "Message" });
    expect(input).toHaveValue("Add rate limiting");
    fireEvent.change(input, { target: { value: "Add rate limiting per IP" } });
    doubles.session.canSend = true;
    rerender(<SessionComposer />);
    await act(async () => {});
    expect(doubles.control).not.toHaveBeenCalled();
    expect(input).toHaveValue("Add rate limiting per IP");
  });
  it("gives a first message opened long after it was written back unsent", async () => {
    offerNewSessionDraft("session", { text: "Add rate limiting", files: [] }, Date.now() - 120_000);
    render(<SessionComposer />);
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Add rate limiting");
    await act(async () => {});
    expect(doubles.control).not.toHaveBeenCalled();
  });
});
