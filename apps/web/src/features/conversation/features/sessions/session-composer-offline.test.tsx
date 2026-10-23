// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadedAttachment } from "@agentkib/web-client";
import { SessionComposer } from "./session-composer";
import { codexCopy } from "./codex-copy";
import type { SessionController } from "./use-session-controller";

const doubles = vi.hoisted(() => ({
  session: {} as Partial<SessionController>,
  control: vi.fn(),
  codexAction: vi.fn(),
  upload: vi.fn(),
}));
vi.mock("./session-context", () => ({
  useSession: () => {
    const [message, setMessage] = useState("");
    return { ...doubles.session, message, setMessage } as SessionController;
  },
}));
vi.mock("./session-panels", () => ({ useSessionPanels: () => null }));
vi.mock("./context-usage", () => ({ ContextUsageGauge: () => null }));
vi.mock("../history/history-search-controls", () => ({ HistoryReferenceChips: () => null }));
vi.mock("./codex-session-controls", () => ({ CodexComposerControls: () => null }));

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
  expect(doubles.codexAction).not.toHaveBeenCalled();
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
      codexAction: doubles.codexAction,
      client: {
        uploadAttachment: doubles.upload,
        request: vi.fn(),
      } as unknown as SessionController["client"],
    };
  });
  afterEach(cleanup);

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
    "keeps %s advanced actions and submission disabled offline",
    async (activity) => {
      disconnected();
      doubles.session.live = {
        sessionId: "session",
        revision: 1,
        sendEnabled: false,
        status: "running",
        ...(activity === "compacting" ? { activity: "compacting" } : {}),
        approvals: [],
        questions: [],
      } as SessionController["live"];
      const { input, form, rerender } = renderComposer();
      expect(input).toBeEnabled();
      fireEvent.change(input, { target: { value: "Next turn draft" } });
      attemptSend(input, form);
      fireEvent.click(screen.getByRole("button", { name: codexCopy["en-US"].advanced }));
      const steer = await screen.findByRole("menuitem", { name: codexCopy["en-US"].steer });
      const queue = screen.getByRole("menuitem", { name: codexCopy["en-US"].queueAdd });
      expect(steer).toHaveAttribute("aria-disabled", "true");
      expect(queue).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(steer);
      fireEvent.click(queue);
      expectNoDispatch();
      fireEvent.keyDown(queue, { key: "Escape" });
      reconnected(false);
      rerender(<SessionComposer />);
      expect(input).toHaveValue("Next turn draft");
      attemptSend(input, form);
      expectNoDispatch();
      fireEvent.click(screen.getByRole("button", { name: codexCopy["en-US"].advanced }));
      const recoveredQueue = await screen.findByRole("menuitem", {
        name: codexCopy["en-US"].queueAdd,
      });
      if (activity === "compacting")
        expect(screen.getByRole("menuitem", { name: codexCopy["en-US"].steer })).toHaveAttribute(
          "aria-disabled",
          "true",
        );
      fireEvent.click(recoveredQueue);
      await waitFor(() =>
        expect(doubles.codexAction).toHaveBeenCalledExactlyOnceWith("queue-add", {
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
    fireEvent.change(screen.getByLabelText(codexCopy["en-US"].attachment), {
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
