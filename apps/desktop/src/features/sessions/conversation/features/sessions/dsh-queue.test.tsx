// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DshQueue } from "./dsh-queue";
import { useSession } from "./session-context";
import { publishSessionInvalidation } from "./session-events";

vi.mock("./session-context", () => ({ useSession: vi.fn() }));

type Session = ReturnType<typeof useSession>;
let state: Session;
const available = { available: true };
function session(
  features: Record<string, { available: boolean; reason?: string }>,
  data = [{ id: "item-1", status: "pending", text: "run the tests next" }],
) {
  return {
    selected: "session",
    locale: "en-US",
    busy: false,
    online: true,
    controlReady: true,
    access: { experimentalEnabled: true },
    live: { sessionId: "session", revision: 4 },
    capabilities: { sessionId: "session", features },
    client: { sessionQueue: vi.fn().mockResolvedValue({ sessionId: "session", data }) },
    codexAction: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as Session;
}

beforeEach(() => {
  state = session({
    "queue-list": available,
    "queue-update": available,
    "queue-delete": available,
    "queue-steer": available,
  });
  vi.mocked(useSession).mockImplementation(() => state);
});
afterEach(cleanup);

describe("DSH queued messages above the composer", () => {
  it("lists what waits for the next turn, steers one in or withdraws it", async () => {
    const user = userEvent.setup();
    render(<DshQueue />);
    const list = await screen.findByRole("list", { name: "Queued messages" });
    expect(list).toHaveTextContent("run the tests next");
    expect(state.client.sessionQueue).toHaveBeenCalledWith(
      "session",
      "deepseek-harness",
      expect.any(AbortSignal),
    );
    await user.click(screen.getByRole("button", { name: /Steer/ }));
    expect(state.codexAction).toHaveBeenLastCalledWith("queue-steer", {
      queuedSubmissionId: "item-1",
    });
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(state.codexAction).toHaveBeenLastCalledWith("queue-delete", {
      queuedSubmissionId: "item-1",
    });
  });

  it("edits a message from its menu", async () => {
    const user = userEvent.setup();
    render(<DshQueue />);
    await user.click(await screen.findByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit message" }));
    const input = screen.getByRole("textbox", { name: "Message text" });
    await user.clear(input);
    await user.type(input, "run the tests first");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(state.codexAction).toHaveBeenCalledExactlyOnceWith("queue-update", {
      queuedSubmissionId: "item-1",
      text: "run the tests first",
    });
  });

  it("reads the queue again when the host reports a queue change, not on every live update", async () => {
    const { rerender } = render(<DshQueue />);
    await screen.findByRole("list", { name: "Queued messages" });
    expect(state.client.sessionQueue).toHaveBeenCalledTimes(1);
    // Streamed text changes the live revision many times a second.
    state = { ...state, live: { sessionId: "session", revision: 99 } } as unknown as Session;
    rerender(<DshQueue />);
    expect(state.client.sessionQueue).toHaveBeenCalledTimes(1);
    publishSessionInvalidation(state.client, "session", ["queue"]);
    await vi.waitFor(() => expect(state.client.sessionQueue).toHaveBeenCalledTimes(2));
  });

  it("takes no room when nothing waits or the queue cannot be read here", async () => {
    state = session({ "queue-list": available }, []);
    const { container, rerender } = render(<DshQueue />);
    await vi.waitFor(() => expect(state.client.sessionQueue).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    state = session({ "queue-list": { available: false, reason: "dsh-runtime-offline" } });
    rerender(<DshQueue />);
    expect(container).toBeEmptyDOMElement();
    expect(state.client.sessionQueue).not.toHaveBeenCalled();
  });
});
