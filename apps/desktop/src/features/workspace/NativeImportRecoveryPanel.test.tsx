// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n } from "@/core/i18n";
import type { NativeImportOperation } from "@/core/types";
import { NativeImportRecoveryPanel } from "./NativeImportRecoveryPanel";
vi.mock("@/core/api", () => ({
  api: {
    nativeImportOperations: vi.fn(),
    launchSessionHandoff: vi.fn(),
    cursorBridge: vi.fn(),
    cursorBridgeBundle: vi.fn(),
    revealCursorBridgeBundle: vi.fn(),
  },
}));
beforeAll(() => initializeI18n("en-US"));
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);
const operation: NativeImportOperation = {
  source_session_id: "source",
  status: "outcome-unknown",
  launch_request: {
    mode: "native-import",
    operation_id: "operation",
    plan_hash: "hash",
    workspace_id: "workspace",
    target_agent: "opencode",
  },
};

it("recovers a persisted unknown import with one reconciliation call and retains errors", async () => {
  vi.mocked(api.nativeImportOperations).mockResolvedValue([operation]);
  let reject!: (reason: Error) => void;
  vi.mocked(api.launchSessionHandoff).mockReturnValue(
    new Promise((_, next) => {
      reject = next;
    }),
  );
  render(<NativeImportRecoveryPanel workspaceId="workspace" />);
  const check = await screen.findByRole("button", { name: "Check import and continue" });
  fireEvent.click(check);
  fireEvent.click(check);
  expect(api.launchSessionHandoff).toHaveBeenCalledTimes(1);
  expect(api.launchSessionHandoff).toHaveBeenCalledWith(operation.launch_request);
  await act(async () => reject(new Error("Target not confirmed; preview again")));
  expect(await screen.findByRole("alert")).toHaveTextContent("Target not confirmed");
  expect(screen.getByText("Import result unknown")).toBeVisible();
  expect(screen.getByRole("button", { name: "Check import and continue" })).toBeEnabled();
});

it("ignores a previous workspace recovery list that resolves late", async () => {
  let resolve!: (value: NativeImportOperation[]) => void;
  vi.mocked(api.nativeImportOperations)
    .mockReturnValueOnce(
      new Promise((next) => {
        resolve = next;
      }),
    )
    .mockResolvedValueOnce([]);
  const { rerender } = render(<NativeImportRecoveryPanel workspaceId="workspace" />);
  await waitFor(() => expect(api.nativeImportOperations).toHaveBeenCalledWith("workspace"));
  rerender(<NativeImportRecoveryPanel workspaceId="other" />);
  await act(async () => resolve([operation]));
  await waitFor(() => expect(api.nativeImportOperations).toHaveBeenCalledWith("other"));
  expect(screen.queryByRole("button", { name: "Check import and continue" })).toBeNull();
});

it("reopens a fresh preview for a prepared operation without executing import recovery", async () => {
  const prepared = { ...operation, status: "prepared" as const };
  vi.mocked(api.nativeImportOperations).mockResolvedValue([prepared]);
  const review = vi.fn();
  render(
    <NativeImportRecoveryPanel
      workspaceId="workspace"
      readableSourceIds={["source"]}
      onReview={review}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Review again" }));
  expect(review).toHaveBeenCalledWith(prepared);
  expect(api.launchSessionHandoff).not.toHaveBeenCalled();
});

it("explains why a prepared import cannot be reviewed when its source is missing", async () => {
  vi.mocked(api.nativeImportOperations).mockResolvedValue([{ ...operation, status: "prepared" }]);
  render(<NativeImportRecoveryPanel workspaceId="workspace" onReview={vi.fn()} />);
  const review = await screen.findByRole("button", { name: "Review again" });
  expect(review).toBeDisabled();
  expect(review).toHaveAttribute(
    "title",
    "The original session is unavailable. Refresh the index or restore the source before reviewing again.",
  );
  expect(api.launchSessionHandoff).not.toHaveBeenCalled();
});

it("offers a fixed Cursor binding reconnect even when the original source is missing", async () => {
  const cursor = {
    ...operation,
    binding_id: "frozen-binding",
    launch_request: { ...operation.launch_request, target_agent: "cursor" as const },
  };
  vi.mocked(api.nativeImportOperations).mockResolvedValue([cursor]);
  vi.mocked(api.cursorBridge).mockImplementation(async (request) =>
    request.action === "connect"
      ? { challenge: "synthetic-reconnect-code", expires_in_seconds: 120 }
      : {
          supported: true,
          supportedVersions: ["3.22.12", "3.23.12"],
          bindings: [
            {
              id: "frozen-binding",
              profile: "explicit-profile",
              version: "3.22.12",
              connected: false,
            },
          ],
        },
  );
  render(
    <NativeImportRecoveryPanel
      workspaceId="workspace"
      workspace={
        {
          id: "workspace",
          path: "/synthetic/workspace",
          name: "synthetic",
        } as import("@/core/types").WorkspaceSummary
      }
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Reconnect selected window" }));
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Reconnect selected window" })).toHaveLength(2),
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Reconnect selected window" })[1]);
  await waitFor(() =>
    expect(api.cursorBridge).toHaveBeenCalledWith({
      action: "connect",
      workspaceId: "workspace",
      bindingId: "frozen-binding",
    }),
  );
  expect(screen.queryByRole("button", { name: "Connect a Cursor window" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Disconnect selected window" })).toBeNull();
  expect(api.launchSessionHandoff).not.toHaveBeenCalled();
});
