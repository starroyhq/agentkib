// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { render } from "@/features/conversation/web-reader-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composerAddCopy } from "@agentkib/session-ui";
import { SessionComposer } from "@/features/conversation/web-session-composer";
import { sessionCopy } from "../../session-copy";
import type { SessionController } from "../../web-session-controller";

const doubles = vi.hoisted(() => ({
  session: {} as Partial<SessionController>,
  control: vi.fn(),
  runSessionAction: vi.fn(),
  upload: vi.fn(),
}));
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
  SessionComposerControls: () => null,
}));

function renderComposer() {
  const view = render(<SessionComposer />);
  const input = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(input, { target: { value: "Original draft" } });
  return { ...view, input, form: input.closest("form")! };
}

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
  afterEach(cleanup);

  it("opens the restricted attachment picker from + only for the authorized session", async () => {
    const { rerender } = renderComposer();
    const copy = sessionCopy["en-US"];
    const input = screen.getByLabelText(copy.attachment);
    const pick = vi.spyOn(input, "click").mockImplementation(() => undefined);
    const add = screen.getByRole("button", { name: copy.addContext });
    fireEvent.click(add);
    fireEvent.click(
      await screen.findByRole("button", { name: composerAddCopy("en-US").attachment }),
    );
    expect(pick).toHaveBeenCalledOnce();
    expect(add).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(add);
    expect(
      await screen.findByRole("button", { name: composerAddCopy("en-US").attachment }),
    ).toBeEnabled();
    doubles.session.capabilities = { ...doubles.session.capabilities!, sessionId: "previous" };
    rerender(<SessionComposer />);
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute("title", copy.permission);
    expect(
      screen.queryByRole("button", { name: composerAddCopy("en-US").attachment }),
    ).not.toBeInTheDocument();
    expect(pick).toHaveBeenCalledOnce();
  });
});
