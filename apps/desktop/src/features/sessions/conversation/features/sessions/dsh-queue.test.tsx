// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  sessionProviderCapabilities,
  sessionProviderDeclaration,
  WebClient,
  type SessionQueue,
} from "@agentkib/web-client";
import {
  dispatchSessionAction,
  resolveSessionProvider,
  sessionQueuePanel,
  SessionSendQueue,
} from "@agentkib/session-ui";
import { render } from "../../desktop-reader-test-utils";
import { publishSessionInvalidation } from "@agentkib/conversation-state";

type Session = React.ComponentProps<typeof SessionSendQueue>["session"];
let state: Session;
const available = { available: true };
function session(
  features: Record<string, { available: boolean; reason?: string }>,
  data: SessionQueue["data"] = [{ id: "item-1", status: "pending", text: "run the tests next" }],
) {
  return {
    selected: "session",
    locale: "en-US",
    busy: false,
    online: true,
    controlReady: true,
    access: {
      status: "approved",
      experimentalEnabled: true,
      device: { id: "device", advancedControl: true, send: true },
    },
    live: { sessionId: "session", revision: 4 },
    capabilities: { sessionId: "session", features },
    client: { sessionQueue: vi.fn().mockResolvedValue({ sessionId: "session", data }) },
    runSessionAction: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as Session;
}

beforeEach(() => {
  state = session({
    "queue-list": available,
    "queue-update": available,
    "queue-delete": available,
    "queue-steer": available,
  });
});
afterEach(cleanup);

it("loads and edits the Antigravity queue through the managed session routes only", async () => {
  const client = new WebClient();
  const request = vi.spyOn(client, "request").mockResolvedValue({ data: [] });
  const body = { sessionId: "session", requestId: "request", bootId: "boot", expectedRevision: 4 };
  await client.sessionQueue("session", "antigravity");
  expect(request).toHaveBeenLastCalledWith(
    "managed/queue?sessionId=session&agent=antigravity",
    undefined,
    undefined,
  );
  await dispatchSessionAction(client, "antigravity", "queue-update", {
    ...body,
    queuedSubmissionId: "item",
    text: "New text",
  });
  expect(request).toHaveBeenLastCalledWith("managed/action", {
    ...body,
    agent: "antigravity",
    operation: "queue-update",
    queuedSubmissionId: "item",
    text: "New text",
  });
  // Antigravity is a managed Agent: the host decides whether it can steer (it cannot).
  await dispatchSessionAction(client, "antigravity", "steer", body);
  expect(request).toHaveBeenLastCalledWith(
    "managed/action",
    expect.objectContaining({ agent: "antigravity", operation: "steer" }),
  );
  await expect(dispatchSessionAction(client, "cursor", "steer", body)).rejects.toThrow(
    "operation_unavailable",
  );
  expect(request).toHaveBeenCalledTimes(3);
});

it.each(["devin", "antigravity"] as const)(
  "uses the shared session queue for %s and respects item status",
  async (agent) => {
    const user = userEvent.setup();
    state = session(
      {
        "queue-list": available,
        "queue-update": available,
        "queue-delete": available,
        "queue-steer": available,
        "queue-pause": available,
        "queue-resume": available,
      },
      [
        { id: "item-1", status: "pending", text: "run the tests next" },
        { id: "item-2", status: "dispatched", text: "already sent" },
      ],
    );
    state = {
      ...state,
      access: {
        ...state.access!,
        status: "approved",
        device: { advancedControl: true, send: true },
      },
    } as unknown as Session;
    const read = vi.mocked(state.client.sessionQueue);
    render(<SessionSendQueue session={state} agent={agent} />);
    await screen.findByText("run the tests next");
    expect(read).toHaveBeenCalledWith("session", agent, expect.any(AbortSignal));
    expect(screen.getAllByRole("button", { name: /Steer/ })[0]).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Remove" })[1]).toBeDisabled();
    await user.click(screen.getAllByRole("button", { name: "Edit message" })[0]!);
    const input = screen.getByRole("textbox", { name: "Message text" });
    await user.clear(input);
    await user.type(input, "run tests first");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(state.runSessionAction).toHaveBeenLastCalledWith("queue-update", {
      queuedSubmissionId: "item-1",
      text: "run tests first",
    });
    read.mockResolvedValue({ sessionId: "session", paused: true, data: [] });
    await user.click(screen.getByRole("button", { name: "Pause queue" }));
    expect(state.runSessionAction).toHaveBeenLastCalledWith("queue-pause", undefined);
    await user.click(await screen.findByRole("button", { name: "Resume queue" }));
    expect(state.runSessionAction).toHaveBeenLastCalledWith("queue-resume", undefined);
  },
);

it.each(["devin", "antigravity"] as const)(
  "hides the empty unpaused queue bar for %s",
  async (agent) => {
    state = session(
      {
        "queue-list": available,
        "queue-pause": available,
        "queue-resume": available,
      },
      [],
    );
    const { container } = render(<SessionSendQueue session={state} agent={agent} />);
    await vi.waitFor(() => {
      expect(state.client.sessionQueue).toHaveBeenCalledWith(
        "session",
        agent,
        expect.any(AbortSignal),
      );
    });
    expect(container).toBeEmptyDOMElement();
  },
);

it("moves a serial queued message up with a complete pending permutation", async () => {
  const user = userEvent.setup();
  state = session(
    {
      "queue-list": available,
      "queue-reorder": available,
    },
    [
      { id: "first", status: "pending", text: "First message" },
      { id: "sent", status: "dispatched", text: "Already sent" },
      { id: "second", status: "pending", text: "Second message" },
    ],
  );
  const provider = sessionProviderDeclaration("devin")!;
  state.capabilities!.provider = {
    ...provider,
    queue: { actions: ["list", "reorder", "pause", "resume"] },
  };
  render(<SessionSendQueue session={state} agent="devin" />);
  const [first, dispatched, second] = await screen.findAllByRole("button", { name: "Move up" });
  expect(first).toBeDisabled();
  expect(dispatched).toBeDisabled();
  expect(second).toBeEnabled();
  await user.click(second!);
  expect(state.runSessionAction).toHaveBeenCalledExactlyOnceWith("queue-reorder", {
    queuedSubmissionIds: ["second", "first"],
  });
});

it("routes a reorder from the basic composer to the managed queue", async () => {
  const client = new WebClient();
  const request = vi.spyOn(client, "request").mockResolvedValue({ accepted: true });
  const body = {
    sessionId: "session",
    requestId: "request",
    bootId: "boot",
    expectedRevision: 4,
    queuedSubmissionIds: ["second", "first"],
  };
  await dispatchSessionAction(client, "devin", "queue-reorder", body);
  expect(request).toHaveBeenCalledExactlyOnceWith("managed/action", {
    ...body,
    agent: "devin",
    operation: "queue-reorder",
  });
});

describe("DSH queued messages above the composer", () => {
  it("lists what waits for the next turn, steers one in or withdraws it", async () => {
    const user = userEvent.setup();
    render(<SessionSendQueue session={state} agent="deepseek-harness" />);
    const list = await screen.findByRole("list", { name: "Queued messages" });
    expect(list).toHaveTextContent("run the tests next");
    expect(state.client.sessionQueue).toHaveBeenCalledWith(
      "session",
      "deepseek-harness",
      expect.any(AbortSignal),
    );
    await user.click(screen.getByRole("button", { name: /Steer/ }));
    expect(state.runSessionAction).toHaveBeenLastCalledWith("queue-steer", {
      queuedSubmissionId: "item-1",
    });
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(state.runSessionAction).toHaveBeenLastCalledWith("queue-delete", {
      queuedSubmissionId: "item-1",
    });
  });

  it("keeps declared item actions visible when the host fences them", async () => {
    const user = userEvent.setup();
    state = session(
      {
        "queue-list": available,
        "queue-update": available,
        "queue-delete": { available: false, reason: "session-busy" },
        "queue-steer": available,
      },
      [
        {
          id: "item-1",
          text: "run the tests next",
          actions: { steer: { available: false, reason: "dsh-runtime-offline" } },
        },
      ],
    );
    render(<SessionSendQueue session={state} agent="deepseek-harness" />);
    await screen.findByText("run the tests next");
    const steer = screen.getByRole("button", { name: /Steer/ });
    const remove = screen.getByRole("button", { name: "Remove" });
    expect(steer).toBeDisabled();
    expect(steer).not.toHaveAttribute("title");
    expect(remove).toBeDisabled();
    expect(remove).not.toHaveAttribute("title");
    await user.click(steer);
    await user.click(remove);
    expect(state.runSessionAction).not.toHaveBeenCalled();
  });

  it("uses the declared queue actions and falls back when a legacy host omits them", () => {
    const declared = sessionProviderDeclaration("deepseek-harness")!;
    const selected = { id: "session", agent: "deepseek-harness" } as const;
    const legacy = sessionProviderCapabilities("deepseek-harness");
    const resolved = resolveSessionProvider(selected, { sessionId: selected.id, provider: legacy });
    expect(sessionQueuePanel(selected.agent, resolved)?.actions).toContain("steer");
    expect(sessionQueuePanel(selected.agent, { ...declared, queue: undefined })).toBeUndefined();
    expect(
      sessionQueuePanel("deepseek-harness", { ...declared, queue: { actions: ["list"] } }),
    ).toBeUndefined();
    expect(sessionQueuePanel("claude-code")).toBeUndefined();
  });

  it("edits a queued message from its row", async () => {
    const user = userEvent.setup();
    render(<SessionSendQueue session={state} agent="deepseek-harness" />);
    await user.click(await screen.findByRole("button", { name: "Edit message" }));
    const input = screen.getByRole("textbox", { name: "Message text" });
    await user.clear(input);
    await user.type(input, "run the tests first");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(state.runSessionAction).toHaveBeenCalledExactlyOnceWith("queue-update", {
      queuedSubmissionId: "item-1",
      text: "run the tests first",
    });
  });

  it("marks a message with images and keeps it out of editing", async () => {
    const user = userEvent.setup();
    state = session(
      {
        "queue-list": available,
        "queue-update": available,
        "queue-delete": available,
        "queue-steer": available,
      },
      [{ id: "item-1", status: "pending", text: "", hasAttachments: true }],
    );
    render(<SessionSendQueue session={state} agent="deepseek-harness" />);
    expect(await screen.findByRole("img", { name: /cannot be edited/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit message" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(state.runSessionAction).toHaveBeenLastCalledWith("queue-delete", {
      queuedSubmissionId: "item-1",
    });
  });

  it("reads the queue again when the host reports a queue change, not on every live update", async () => {
    const { rerender } = render(<SessionSendQueue session={state} agent="deepseek-harness" />);
    await screen.findByRole("list", { name: "Queued messages" });
    expect(state.client.sessionQueue).toHaveBeenCalledTimes(1);
    // Streamed text changes the live revision many times a second.
    state = { ...state, live: { sessionId: "session", revision: 99 } } as unknown as Session;
    rerender(<SessionSendQueue session={state} agent="deepseek-harness" />);
    expect(state.client.sessionQueue).toHaveBeenCalledTimes(1);
    publishSessionInvalidation(state.client, "session", ["queue"]);
    await vi.waitFor(() => expect(state.client.sessionQueue).toHaveBeenCalledTimes(2));
  });

  it("shows a message queued while the host still turned reads away", async () => {
    state = session({ "queue-list": available }, []);
    const { container } = render(<SessionSendQueue session={state} agent="deepseek-harness" />);
    await vi.waitFor(() => expect(state.client.sessionQueue).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
    // DSH reports the new message while the control that queued it is still being admitted.
    const read = vi.mocked(state.client.sessionQueue);
    read.mockRejectedValueOnce(new ApiError(409, "operation_busy"));
    read.mockResolvedValue({
      sessionId: "session",
      data: [{ id: "item-1", status: "pending", text: "run the tests next" }],
    } as never);
    publishSessionInvalidation(state.client, "session", ["queue"]);
    expect(await screen.findByRole("list", { name: "Queued messages" })).toHaveTextContent(
      "run the tests next",
    );
    // A settled control on this session is read again as well.
    publishSessionInvalidation(state.client, "session", ["receipts"]);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4));
  });

  it("takes no room when nothing waits and disables viewing if the queue cannot be read", async () => {
    state = session({ "queue-list": available }, []);
    const { container, rerender } = render(
      <SessionSendQueue session={state} agent="deepseek-harness" />,
    );
    await vi.waitFor(() => expect(state.client.sessionQueue).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    state = session({ "queue-list": { available: false, reason: "dsh-runtime-offline" } });
    rerender(<SessionSendQueue session={state} agent="deepseek-harness" />);
    expect(screen.getByRole("button", { name: "Queued messages" })).toBeDisabled();
    expect(state.client.sessionQueue).not.toHaveBeenCalled();
  });

  it("hides an already loaded queue immediately when the device loses queue access", async () => {
    const { rerender } = render(<SessionSendQueue session={state} agent="deepseek-harness" />);
    expect(await screen.findByText("run the tests next")).toBeVisible();
    const read = vi.mocked(state.client.sessionQueue);
    state = {
      ...state,
      access: { ...state.access!, device: { ...state.access!.device!, advancedControl: false } },
    };
    rerender(<SessionSendQueue session={state} agent="deepseek-harness" />);
    expect(screen.queryByText("run the tests next")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Queued messages" })).toBeDisabled();
    expect(read).toHaveBeenCalledOnce();
  });
});
