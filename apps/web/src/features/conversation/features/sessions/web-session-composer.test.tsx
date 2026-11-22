// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useState, type ReactNode } from "react";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { render } from "@/features/conversation/web-reader-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    advancedActions,
    setResources,
  }: {
    action: ReactNode;
    advancedActions: ReactNode;
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
      {advancedActions}
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
    vi.unstubAllGlobals();
  });

  it("submits Enter through the same form path as the send button", async () => {
    const { input, form } = renderComposer();
    expect(screen.getByRole("button", { name: "Send" })).toHaveClass(
      "size-8",
      "pointer-coarse:size-11",
    );
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
    expect(button).toHaveAttribute(
      "title",
      "This operation requires an idle session. Wait for the current turn to finish.",
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
      expect(screen.getByRole("button", { name: "Stop" })).toHaveClass(
        "size-8",
        "pointer-coarse:size-11",
        "rounded-full",
        "text-white",
      );
      expect(screen.getByRole("button", { name: sessionCopy["en-US"].advanced })).toHaveClass(
        "size-11",
      );
      // Enter while the turn runs takes this device's running choice, which queues by default.
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() =>
        expect(doubles.runSessionAction).toHaveBeenCalledExactlyOnceWith("queue-add", {
          text: "Draft message",
        }),
      );
      await waitFor(() => expect(input).toBeEnabled());
      expect(input).toHaveValue("");
      expect(doubles.control).not.toHaveBeenCalled();
      doubles.runSessionAction.mockClear();
      fireEvent.change(input, { target: { value: "Draft message" } });
      fireEvent.click(screen.getByRole("button", { name: sessionCopy["en-US"].advanced }));
      fireEvent.click(
        await screen.findByRole("menuitem", {
          name: action === "steer" ? sessionCopy["en-US"].steer : sessionCopy["en-US"].queueAdd,
        }),
      );
      await waitFor(() =>
        expect(doubles.runSessionAction).toHaveBeenCalledWith(action, {
          text: "Draft message",
          ...(action === "steer" ? { turnId: "turn" } : {}),
        }),
      );
      expect(doubles.control).not.toHaveBeenCalled();
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
    expect(
      screen.queryByRole("button", { name: sessionCopy["en-US"].advanced }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/in use in Codex/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
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
