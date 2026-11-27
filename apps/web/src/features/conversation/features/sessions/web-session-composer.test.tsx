// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { render } from "@/features/conversation/web-reader-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreferencesDialog } from "@agentkib/session-ui";
import { dictionaries } from "@/features/conversation/i18n";
import { SessionComposer } from "@/features/conversation/web-session-composer";
import { sessionCopy, sessionReason } from "../../session-copy";
import type { SessionResource } from "@agentkib/web-client";
import type { SessionController } from "../../web-session-controller";

const doubles = vi.hoisted(() => ({
  session: {} as Partial<SessionController>,
  control: vi.fn(),
  runSessionAction: vi.fn(),
  navigate: vi.fn(),
  upload: vi.fn(),
  resumeCommand: vi.fn(),
}));
vi.mock("../../web-session-navigation", () => ({ useSessionNavigate: () => doubles.navigate }));
vi.mock("../../web-session-context", () => ({
  useSession: () => {
    const [message, setMessage] = useState("");
    return { ...doubles.session, message, setMessage } as SessionController;
  },
}));
vi.mock("@agentkib/session-ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@agentkib/session-ui")>()),
  useSessionPanels: () => null,
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

function renderComposer(message = "Draft message") {
  const view = render(<SessionComposer />);
  const input = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(input, { target: { value: message } });
  return { ...view, input, form: input.closest("form")! };
}

const followUpStorageKey = "agentkib.send-while-running";

describe("composer sending shortcuts", () => {
  beforeEach(() => {
    localStorage.removeItem(followUpStorageKey);
    vi.resetAllMocks();
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
    localStorage.removeItem(followUpStorageKey);
    vi.unstubAllGlobals();
  });

  it("submits Enter through the same form path as the send button", async () => {
    const { input, form } = renderComposer();
    expect(screen.getByRole("button", { name: "Send" })).toHaveClass(
      "size-8",
      "pointer-coarse:size-11",
    );
    expect(screen.getByRole("button", { name: sessionCopy["en-US"].addContext })).toHaveClass(
      "size-8",
      "pointer-coarse:size-11",
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

  it("keeps the send control visible and disables writing to Antigravity", async () => {
    doubles.session.current = {
      ...doubles.session.current!,
      agent: "antigravity",
    } as SessionController["current"];
    doubles.session.access = {
      ...doubles.session.access!,
      disabledSessionProviders: { antigravity: "antigravity-acp-disabled" },
    };
    doubles.session.live = { ...doubles.session.live!, reason: "antigravity-acp-disabled" };
    const { form, input } = renderComposer();
    expect(input).toBeDisabled();
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeVisible();
    expect(send).toBeDisabled();
    expect(screen.queryByText("antigravity-acp-disabled")).toBeNull();
    await act(async () => {
      fireEvent.click(send);
      fireEvent.submit(form);
    });
    expect(doubles.control).not.toHaveBeenCalled();
  });

  it.each(["codex", "claude-code", "deepseek-harness", "devin", "antigravity"] as const)(
    "pastes screenshots and copied files and accepts a file drop for an attachment-capable %s session",
    async (agent) => {
      doubles.session.current = { id: "session", agent } as SessionController["current"];
      doubles.upload.mockImplementation(async (_sessionId: string, file: File) => ({
        id: file.name,
        name: file.name,
        mime: file.type,
        size: file.size,
        version: "1",
      }));
      const { input, form } = renderComposer();
      const screenshot = new File(["image"], "Screenshot.png", { type: "image/png" });
      const copied = new File(["content"], "Finder copy.txt", { type: "text/plain" });
      const dropped = new File(["data"], "Dropped.txt", { type: "text/plain" });
      const imageItem = { kind: "file", getAsFile: () => screenshot };
      expect(
        fireEvent.paste(input, {
          clipboardData: { files: [], items: [imageItem], types: ["Files"] },
        }),
      ).toBe(false);
      expect(fireEvent.paste(input, { clipboardData: { files: [copied] } })).toBe(false);
      const dataTransfer = { files: [dropped], types: ["Files"], dropEffect: "none" };
      expect(fireEvent.dragOver(form, { dataTransfer })).toBe(false);
      expect(dataTransfer.dropEffect).toBe("copy");
      expect(fireEvent.drop(input, { dataTransfer })).toBe(false);

      await screen.findByText(dropped.name);
      expect(doubles.upload.mock.calls.map(([, file]) => file)).toEqual([
        screenshot,
        copied,
        dropped,
      ]);
      expect(form).not.toHaveAttribute("data-attachment-rejected");
    },
  );

  it("briefly highlights the disabled add button without inserting dropped or pasted files", () => {
    doubles.session.capabilities!.features.attachments = {
      available: false,
      reason: "session-busy",
    };
    const { input, form } = renderComposer();
    const add = screen.getByRole("button", { name: sessionCopy["en-US"].addContext });
    const file = new File(["attachment"], "file.txt");
    vi.useFakeTimers();
    try {
      expect(add).toBeDisabled();
      const text = { files: [], types: ["text/plain"], getData: () => "Normal text" };
      expect(fireEvent.paste(input, { clipboardData: text })).toBe(true);
      expect(form).not.toHaveAttribute("data-attachment-rejected");
      expect(fireEvent.paste(input, { clipboardData: { files: [file] } })).toBe(false);
      expect(form).toHaveAttribute("data-attachment-rejected");
      act(() => vi.advanceTimersByTime(600));
      expect(form).not.toHaveAttribute("data-attachment-rejected");
      expect(fireEvent.drop(form, { dataTransfer: { files: [file] } })).toBe(false);
      expect(form).toHaveAttribute("data-attachment-rejected");
      expect(add).toBeDisabled();
      expect(doubles.upload).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
    const button = screen.getByRole("button", { name: sessionCopy["en-US"].addContext });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", sessionCopy["en-US"].addContext);
  });

  function runningFixture(agent = "codex") {
    doubles.session.current = {
      id: "session",
      agent,
    } as SessionController["current"];
    doubles.session.access = {
      ...doubles.session.access,
      status: "approved",
      device: { ...doubles.session.access?.device, advancedControl: true },
    } as SessionController["access"];
    doubles.session.canSend = false;
    doubles.session.canStop = true;
    doubles.session.live = {
      ...doubles.session.live!,
      sendEnabled: false,
      status: "running",
      executionLocation: "agentkib",
      turnId: "turn",
    };
    if (agent !== "codex") {
      doubles.session.capabilities = {
        ...doubles.session.capabilities!,
        features: { "queue-add": { available: true } },
      };
    }
  }

  it("steers by default and queues one follow-up with Ctrl+Enter", async () => {
    runningFixture();
    const { input } = renderComposer("");
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();

    fireEvent.change(input, { target: { value: "First follow-up" } });
    expect(screen.getByRole("button", { name: sessionCopy["en-US"].steer })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
    expect(
      screen.queryByText("Queued messages run automatically after the current turn."),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input).toHaveValue(""));
    expect(doubles.runSessionAction).toHaveBeenCalledExactlyOnceWith("steer", {
      text: "First follow-up",
      turnId: "turn",
    });

    fireEvent.change(input, { target: { value: "Alternate follow-up" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(input).toHaveValue(""));
    expect(doubles.runSessionAction).toHaveBeenCalledTimes(2);
    expect(doubles.runSessionAction).toHaveBeenLastCalledWith("queue-add", {
      text: "Alternate follow-up",
    });
    expect(doubles.control).not.toHaveBeenCalled();
  });

  it("uses the saved queue preference and steers one follow-up with Command+Enter", async () => {
    localStorage.setItem(followUpStorageKey, "queue");
    runningFixture();
    const { input } = renderComposer("First follow-up");
    fireEvent.click(screen.getByRole("button", { name: sessionCopy["en-US"].queueAdd }));
    await waitFor(() => expect(input).toHaveValue(""));
    expect(doubles.runSessionAction).toHaveBeenCalledExactlyOnceWith("queue-add", {
      text: "First follow-up",
    });

    fireEvent.change(input, { target: { value: "Alternate follow-up" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    await waitFor(() => expect(input).toHaveValue(""));
    expect(doubles.runSessionAction).toHaveBeenCalledTimes(2);
    expect(doubles.runSessionAction).toHaveBeenLastCalledWith("steer", {
      text: "Alternate follow-up",
      turnId: "turn",
    });
    expect(localStorage.getItem(followUpStorageKey)).toBe("queue");
  });

  it.each(["devin", "antigravity"])("only queues while %s is running", async (agent) => {
    runningFixture(agent);
    const { input } = renderComposer("First follow-up");
    expect(
      screen.queryByRole("button", { name: sessionCopy["en-US"].steer }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: sessionCopy["en-US"].queueAdd }));
    await waitFor(() => expect(input).toHaveValue(""));
    expect(doubles.runSessionAction).toHaveBeenCalledExactlyOnceWith("queue-add", {
      text: "First follow-up",
    });

    fireEvent.change(input, { target: { value: "Alternate follow-up" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(input).toHaveValue(""));
    expect(doubles.runSessionAction).toHaveBeenCalledTimes(2);
    expect(doubles.runSessionAction).toHaveBeenLastCalledWith("queue-add", {
      text: "Alternate follow-up",
    });
  });

  it("preserves the stored follow-up preference in the Web settings and persists changes", () => {
    localStorage.setItem(followUpStorageKey, "queue");
    const labels = dictionaries["en-US"];
    const preferences = (
      <PreferencesDialog
        labels={labels}
        locale="en-US"
        theme="system"
        accent="blue"
        onLocaleChange={vi.fn()}
        onThemeChange={vi.fn()}
        onAccentChange={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const first = render(preferences);
    const sessionPreferences = within(
      screen.getByRole("group", { name: labels.sessionPreferences }),
    );
    const followUp = sessionPreferences.getByRole("combobox", { name: labels.sendWhileRunning });
    expect(followUp).toHaveValue("queue");
    const shortcuts = within(screen.getByRole("group", { name: labels.keyboardShortcuts }));
    expect(shortcuts.getByText(labels.alternateFollowUp)).toBeVisible();
    expect(shortcuts.getByText(/^(?:⌘|Ctrl\+)Enter$/)).toBeVisible();

    fireEvent.change(followUp, { target: { value: "steer" } });
    expect(followUp).toHaveValue("steer");
    expect(localStorage.getItem(followUpStorageKey)).toBe("steer");
    first.unmount();
    render(preferences);
    expect(screen.getByRole("combobox", { name: labels.sendWhileRunning })).toHaveValue("steer");
  });

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
  it("keeps the Codex follower composer enabled without a hint line and hides the busy bar and advanced menu", () => {
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
    // The header already says where it runs; no explanatory line sits over the composer.
    expect(screen.queryByText(/Messages run in Codex/)).not.toBeInTheDocument();
    expect(input).toBeEnabled();
    expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
    expect(screen.queryByText(/in use in Codex/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("shows only the objective read-only reason for an unsupported Codex version on Web", () => {
    continuationFixture();
    doubles.session.canSend = false;
    Object.assign(doubles.session.live!, {
      sendEnabled: false,
      reason: "codex-cli-version-too-old",
    });
    render(<SessionComposer />);
    expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
    expect(
      screen.getAllByText("Your Codex version is too old. Update it to continue here."),
    ).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Copy resume command" })).not.toBeInTheDocument();
    expect(screen.queryByText(/On the computer running AgentKib/)).not.toBeInTheDocument();
    expect(doubles.resumeCommand).not.toHaveBeenCalled();
    expect(doubles.control).not.toHaveBeenCalled();
    expect(doubles.runSessionAction).not.toHaveBeenCalled();
    expect(doubles.navigate).not.toHaveBeenCalled();
  });

  it("explains a usage limit a Devin turn met, without a continue to choose", () => {
    doubles.session.current = { id: "session", agent: "devin" } as SessionController["current"];
    doubles.session.live = {
      ...doubles.session.live,
      executionMode: "devin-print",
      status: "idle",
      usageLimit: {
        agent: "devin",
        resetsAt: null,
        kind: "weekly",
        scope: null,
        message: "Your weekly usage quota has been exhausted.",
        continueAt: null,
        manual: "reset-unknown",
        autoContinues: 0,
      },
    } as SessionController["live"];
    render(<SessionComposer />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "You've hit your weekly limit. Try again later.",
    );
    expect(screen.queryByRole("button", { name: /continue automatically/i })).toBeNull();
  });
  it("offers the continue after Devin's reset, once its /usage told when that is", () => {
    doubles.session.current = { id: "session", agent: "devin" } as SessionController["current"];
    const resetsAt = Date.now() + 3_600_000;
    const usageLimit = {
      agent: "devin" as const,
      resetsAt,
      kind: null,
      scope: null,
      message: "Your daily usage quota has been exhausted.",
      continueAt: resetsAt + 30_000,
      manual: null,
      autoContinues: 0,
    };
    doubles.session.live = {
      ...doubles.session.live,
      executionMode: "devin-print",
      status: "idle",
      usageLimit,
    } as SessionController["live"];
    const view = render(<SessionComposer />);
    expect(screen.getByRole("status")).toHaveTextContent("continues automatically after the reset");
    fireEvent.click(screen.getByRole("button", { name: "Don't continue automatically" }));
    expect(doubles.runSessionAction).toHaveBeenCalledWith("usage-limit-cancel");
    view.unmount();
    doubles.session.live = {
      ...doubles.session.live,
      usageLimit: { ...usageLimit, continueAt: null, manual: "cancelled" },
    } as SessionController["live"];
    render(<SessionComposer />);
    fireEvent.click(screen.getByRole("button", { name: "Continue automatically after the reset" }));
    expect(doubles.runSessionAction).toHaveBeenCalledWith("usage-limit-continue");
  });
  it("explains a Devin turn whose CLI process was ended", () => {
    doubles.session.current = { id: "session", agent: "devin" } as SessionController["current"];
    doubles.session.live = {
      ...doubles.session.live,
      executionMode: "devin-print",
      status: "idle",
      reason: "devin-run-stopped",
    } as SessionController["live"];
    render(<SessionComposer />);
    expect(screen.getByRole("status")).toHaveTextContent(
      sessionReason("en-US", "devin-run-stopped", "web").text,
    );
  });
});
