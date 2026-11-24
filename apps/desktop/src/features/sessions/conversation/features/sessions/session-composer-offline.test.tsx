// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { render } from "@/features/sessions/conversation/desktop-reader-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadedAttachment } from "@agentkib/web-client";
import { SessionComposer } from "@/features/sessions/conversation/desktop-session-composer";
import { sessionCopy } from "../../session-copy";
import type { SessionController } from "../../desktop-session-controller";

const doubles = vi.hoisted(() => ({
  session: {} as Partial<SessionController>,
  control: vi.fn(),
  runSessionAction: vi.fn(),
  upload: vi.fn(),
}));
vi.mock("../../desktop-session-context", () => ({
  useSession: () => {
    const [message, setMessage] = useState("");
    return { ...doubles.session, message, setMessage } as SessionController;
  },
}));
vi.mock("@agentkib/session-ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@agentkib/session-ui")>()),
  useSessionPanels: () => null,
  SessionContextUsageGauge: () => null,
  SessionComposerControls: () => null,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function renderComposer() {
  const view = render(<SessionComposer />);
  const input = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(input, { target: { value: "Original draft" } });
  return { ...view, input, form: input.closest("form")! };
}

function disconnected() {
  doubles.session.online = false;
  doubles.session.controlReady = false;
  doubles.session.canSend = false;
}

function reconnected(canSend = true) {
  doubles.session.online = true;
  doubles.session.controlReady = true;
  doubles.session.canSend = canSend;
}

function attemptSend(input: HTMLElement, form: HTMLFormElement) {
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.submit(form);
}

function expectNoDispatch() {
  expect(doubles.control).not.toHaveBeenCalled();
  expect(doubles.runSessionAction).not.toHaveBeenCalled();
}

const attachment: UploadedAttachment = {
  id: "attachment",
  name: "note.txt",
  mime: "text/plain",
  size: 3,
  version: "1",
};

describe("composer drafts across connection changes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    doubles.control.mockResolvedValue(true);
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
        device: { send: true, attachments: true, advancedControl: true },
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
        request: vi.fn(),
      } as unknown as SessionController["client"],
    };
  });
  afterEach(() => {
    cleanup();
    localStorage.removeItem("agentkib.send-while-running");
  });

  it.each(["codex", "claude-code"])(
    "keeps the %s draft editable and focused offline, then requires an explicit send after recovery",
    async (agent) => {
      doubles.session.current = { id: "session", agent } as SessionController["current"];
      const { input, form, rerender } = renderComposer();
      input.focus();
      disconnected();
      rerender(<SessionComposer />);
      expect(screen.getByRole("textbox", { name: "Message" })).toBe(input);
      expect(input).toBeEnabled();
      expect(input).toHaveFocus();
      expect(input).toHaveValue("Original draft");
      fireEvent.change(input, { target: { value: "Draft edited offline\n第二行" } });
      expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true })).toBe(true);
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
      attemptSend(input, form);
      expectNoDispatch();

      doubles.session.online = true;
      rerender(<SessionComposer />);
      expect(input).toBeEnabled();
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
      attemptSend(input, form);
      expectNoDispatch();

      reconnected();
      rerender(<SessionComposer />);
      expect(input).toHaveValue("Draft edited offline\n第二行");
      expect(input).toHaveFocus();
      expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
      expectNoDispatch();
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(input).toHaveValue(""));
      expect(doubles.control).toHaveBeenCalledExactlyOnceWith(
        "send",
        undefined,
        undefined,
        undefined,
        undefined,
        { attachmentIds: [] },
      );
    },
  );

  it.each([
    ["offline", { online: false }],
    ["not control ready", { controlReady: false }],
  ] as const)("retains the %s gate even when send eligibility is stale", (_label, state) => {
    Object.assign(doubles.session, state);
    const { input, form } = renderComposer();
    expect(input).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    attemptSend(input, form);
    expectNoDispatch();
  });

  it("still locks the editor and submission while a different operation is busy offline", () => {
    disconnected();
    doubles.session.busy = true;
    const { input, form } = renderComposer();
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    attemptSend(input, form);
    expectNoDispatch();
  });

  it("keeps drafts editable but unsendable while only a settings write is outstanding", () => {
    doubles.session.settingsOnlyBlocked = true;
    doubles.session.busy = true;
    doubles.session.controlReady = false;
    doubles.session.canSend = false;
    const { input, form } = renderComposer();
    expect(input).toBeEnabled();
    expect(input).toHaveValue("Original draft");
    fireEvent.change(input, { target: { value: "Edited during settings write" } });
    expect(input).toHaveValue("Edited during settings write");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    attemptSend(input, form);
    expectNoDispatch();
  });

  it("keeps a pending or unconfirmed send locked until a not-dispatched outcome allows offline editing", async () => {
    const pending = deferred<boolean | undefined>();
    doubles.control.mockReturnValueOnce(pending.promise);
    const { input, form, rerender } = renderComposer();
    fireEvent.keyDown(input, { key: "Enter" });
    disconnected();
    rerender(<SessionComposer />);
    expect(input).toBeDisabled();
    expect(input).toHaveValue("Original draft");
    attemptSend(input, form);
    expect(doubles.control).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(undefined));
    doubles.session.notice = "uncertain";
    rerender(<SessionComposer />);
    expect(input).toBeDisabled();
    attemptSend(input, form);
    expect(doubles.control).toHaveBeenCalledTimes(1);
    doubles.session.notice = "notDispatched";
    rerender(<SessionComposer />);
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "Recovered unsent draft" } });
    attemptSend(input, form);
    expect(doubles.control).toHaveBeenCalledTimes(1);
    reconnected();
    rerender(<SessionComposer />);
    expect(input).toHaveValue("Recovered unsent draft");
    expect(doubles.control).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(doubles.control).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("clears an acknowledged send after disconnect without submitting it again", async () => {
    const pending = deferred<boolean | undefined>();
    doubles.control.mockReturnValueOnce(pending.promise);
    const { input, form, rerender } = renderComposer();
    fireEvent.keyDown(input, { key: "Enter" });
    disconnected();
    rerender(<SessionComposer />);
    await act(async () => pending.resolve(undefined));
    doubles.session.notice = "accepted";
    rerender(<SessionComposer />);
    expect(input).toBeEnabled();
    expect(input).toHaveValue("");
    attemptSend(input, form);
    expect(doubles.control).toHaveBeenCalledTimes(1);
  });

  it("keeps readonly sessions unsendable after reconnect while allowing local drafts", () => {
    disconnected();
    doubles.session.access = {
      ...doubles.session.access,
      device: { send: false, attachments: false },
    } as SessionController["access"];
    const { input, form, rerender } = renderComposer();
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "Local readonly draft" } });
    reconnected(false);
    rerender(<SessionComposer />);
    expect(input).toHaveValue("Local readonly draft");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    attemptSend(input, form);
    expectNoDispatch();
  });

  it.each(["running", "compacting"])(
    "keeps %s follow-ups and submission disabled offline",
    async (activity) => {
      localStorage.setItem("agentkib.send-while-running", "queue");
      doubles.session.access = { ...doubles.session.access!, status: "approved" };
      disconnected();
      doubles.session.live = {
        sessionId: "session",
        revision: 1,
        sendEnabled: false,
        status: "running",
        executionMode: "codex-managed",
        executionLocation: "agentkib",
        ...(activity === "compacting" ? { activity: "compacting" } : {}),
        approvals: [],
        questions: [],
      } as SessionController["live"];
      const { input, form, rerender } = renderComposer();
      expect(input).toBeEnabled();
      fireEvent.change(input, { target: { value: "Next turn draft" } });
      attemptSend(input, form);
      fireEvent.keyDown(input, { key: "Enter", metaKey: true });
      expectNoDispatch();

      reconnected(false);
      rerender(<SessionComposer />);
      expect(input).toHaveValue("Next turn draft");
      expect(screen.getByRole("button", { name: sessionCopy["en-US"].queueAdd })).toBeEnabled();
      attemptSend(input, form);
      await waitFor(() =>
        expect(doubles.runSessionAction).toHaveBeenCalledExactlyOnceWith("queue-add", {
          text: "Next turn draft",
        }),
      );
      expect(doubles.control).not.toHaveBeenCalled();
    },
  );

  it("preserves the upload readiness gate and attachment when a draft is edited offline", async () => {
    const upload = deferred<UploadedAttachment>();
    doubles.upload.mockReturnValue(upload.promise);
    const { input, form, rerender } = renderComposer();
    fireEvent.change(screen.getByLabelText(sessionCopy["en-US"].attachment), {
      target: { files: [new File(["abc"], "note.txt", { type: "text/plain" })] },
    });
    disconnected();
    rerender(<SessionComposer />);
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "Attachment explanation" } });
    attemptSend(input, form);
    expectNoDispatch();
    reconnected();
    rerender(<SessionComposer />);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    attemptSend(input, form);
    expectNoDispatch();
    await act(async () => upload.resolve(attachment));
    expect(input).toHaveValue("Attachment explanation");
    expectNoDispatch();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(doubles.control).toHaveBeenCalledExactlyOnceWith(
        "send",
        undefined,
        undefined,
        undefined,
        undefined,
        { attachmentIds: [attachment.id] },
      ),
    );
  });
});
