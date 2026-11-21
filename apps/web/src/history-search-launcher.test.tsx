import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebClient, type Access, type HistorySearchStatus } from "@agentkib/web-client";
import { HistorySearchLauncher } from "@agentkib/session-ui";
import { render } from "@/features/conversation/web-reader-test-utils";

afterEach(cleanup);

const title = "Search conversation content";
const queryLabel = "Search messages and tool records";
const status: HistorySearchStatus = {
  enabled: true,
  generation: "generation",
  bytes: 0,
  limitBytes: 10000,
  budgetExceeded: false,
  coverage: {
    total: 0,
    ready: 0,
    building: 0,
    partial: 0,
    stale: 0,
    unavailable: 0,
    limitations: [],
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const grant: Access = {
    protocolVersion: 2,
    status: "approved",
    csrfToken: "test-csrf",
    bootId: "boot",
    experimentalEnabled: true,
    device: { id: "owner", name: "Desktop", send: true, approve: true },
    historySearch: true,
    historySearchScope: "registered-workspaces-1",
  };
  const accessResponses: Array<Response | Promise<Response>> = [];
  const transport = vi.fn<typeof fetch>(async (input) => {
    const path = String(input);
    if (path.endsWith("/access")) return accessResponses.shift() ?? Response.json({ ...grant });
    if (path.endsWith("/catalog"))
      return Response.json({ sessions: [], workspaces: [], indexEnabled: true });
    if (path.endsWith("/history/status")) return Response.json(status);
    if (path.endsWith("/history/search"))
      return Response.json({ status, hits: [], nextCursor: null, limited: false });
    throw new Error(`Unexpected request: ${path}`);
  });
  const calls = (path: string) =>
    transport.mock.calls.filter(([input]) => String(input).endsWith(`/${path}`));
  return { client: new WebClient(transport), grant, accessResponses, calls };
}

async function closeDialog() {
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

describe("HistorySearchLauncher", () => {
  it("refreshes registered workspace scope on every standalone opening without remounting", async () => {
    const f = fixture();
    render(<HistorySearchLauncher client={f.client} locale="en-US" />);
    for (let opening = 1; opening <= 3; opening++) {
      f.grant.historySearchScope = `registered-workspaces-${opening}`;
      fireEvent.click(await screen.findByRole("button", { name: title }));
      await waitFor(() => expect(f.calls("history/status")).toHaveLength(opening));
      expect(screen.getByRole("textbox", { name: queryLabel })).toBeInTheDocument();
      await closeDialog();
    }
  });

  it("keeps the panel scope fence and can reopen with the new scope after it closes", async () => {
    const f = fixture();
    render(<HistorySearchLauncher client={f.client} locale="en-US" />);
    fireEvent.click(await screen.findByRole("button", { name: title }));
    await waitFor(() => expect(f.calls("history/status")).toHaveLength(1));
    f.grant.historySearchScope = "registered-workspaces-2";
    const query = screen.getByRole("textbox", { name: queryLabel });
    fireEvent.change(query, { target: { value: "history" } });
    fireEvent.submit(query.closest("form")!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(f.calls("history/search")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: title }));
    await waitFor(() => expect(f.calls("history/status")).toHaveLength(2));
    expect(screen.getByRole("textbox", { name: queryLabel })).toBeInTheDocument();
  });

  it("waits for fresh access before the provider callback and ignores repeated pending clicks", async () => {
    const f = fixture();
    const onOpen = vi.fn();
    render(<HistorySearchLauncher client={f.client} locale="en-US" onOpen={onOpen} />);
    const button = await screen.findByRole("button", { name: title });
    const next = deferred<Response>();
    f.accessResponses.push(next.promise);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(f.calls("access")).toHaveLength(2);
    expect(button).toBeDisabled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => {
      next.resolve(Response.json({ ...f.grant, historySearchScope: "registered-workspaces-2" }));
    });
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    expect(button).toBeEnabled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(f.calls("history/status")).toHaveLength(0);
  });

  it.each(["ended", "capability", "forbidden"])(
    "does not open after access is revoked through %s",
    async (revocation) => {
      const f = fixture();
      const onOpen = vi.fn();
      render(<HistorySearchLauncher client={f.client} locale="en-US" onOpen={onOpen} />);
      const button = await screen.findByRole("button", { name: title });
      f.accessResponses.push(
        revocation === "forbidden"
          ? Response.json({ code: "access_ended" }, { status: 403 })
          : Response.json({
              ...f.grant,
              ...(revocation === "ended" ? { status: "ended" } : { historySearch: undefined }),
            }),
      );
      fireEvent.click(button);
      await waitFor(() => expect(screen.queryByRole("button", { name: title })).toBeNull());
      expect(onOpen).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(f.calls("history/status")).toHaveLength(0);
    },
  );

  it("allows retrying a failed access refresh without opening from the cached grant", async () => {
    const f = fixture();
    const onOpen = vi.fn();
    render(<HistorySearchLauncher client={f.client} locale="en-US" onOpen={onOpen} />);
    const button = await screen.findByRole("button", { name: title });
    f.accessResponses.push(Response.json({ code: "temporarily_unavailable" }, { status: 503 }));
    fireEvent.click(button);
    await screen.findByRole("alert");
    expect(button).toBeEnabled();
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(f.calls("access")).toHaveLength(3);
  });

  it("discards a previous client's pending opening even when its transport ignores abort", async () => {
    const previous = fixture();
    const current = fixture();
    const onOpen = vi.fn();
    const view = render(
      <HistorySearchLauncher client={previous.client} locale="en-US" onOpen={onOpen} />,
    );
    const next = deferred<Response>();
    previous.accessResponses.push(next.promise);
    fireEvent.click(await screen.findByRole("button", { name: title }));
    view.rerender(<HistorySearchLauncher client={current.client} locale="en-US" onOpen={onOpen} />);
    await waitFor(() => expect(current.calls("access")).toHaveLength(1));
    await act(async () => {
      next.resolve(Response.json(previous.grant));
    });
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: title }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    expect(current.calls("access")).toHaveLength(2);
  });

  it("discards a replaced client's late initial grant", async () => {
    const previous = fixture();
    const current = fixture();
    const next = deferred<Response>();
    previous.accessResponses.push(next.promise);
    const view = render(<HistorySearchLauncher client={previous.client} locale="en-US" />);
    view.rerender(<HistorySearchLauncher client={current.client} locale="en-US" />);
    await screen.findByRole("button", { name: title });
    await act(async () => {
      next.resolve(Response.json({ ...previous.grant, status: "ended" }));
    });
    fireEvent.click(screen.getByRole("button", { name: title }));
    await waitFor(() => expect(current.calls("history/status")).toHaveLength(1));
  });

  it("does not invoke the provider callback after unmounting during an access refresh", async () => {
    const f = fixture();
    const onOpen = vi.fn();
    const view = render(<HistorySearchLauncher client={f.client} locale="en-US" onOpen={onOpen} />);
    const next = deferred<Response>();
    f.accessResponses.push(next.promise);
    fireEvent.click(await screen.findByRole("button", { name: title }));
    view.unmount();
    await act(async () => {
      next.resolve(Response.json(f.grant));
    });
    expect(onOpen).not.toHaveBeenCalled();
  });
});
