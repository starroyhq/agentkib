import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@agentkib/web-client";
import {
  pendingScope,
  rememberPending,
  readPending,
} from "@/features/conversation/features/sessions/pending-controls";
import { ManagedTasks } from "@/features/conversation/features/sessions/managed-tasks";
import { publishSessionInvalidation } from "@/features/conversation/features/sessions/session-events";
import type { WebClient } from "@agentkib/web-client";

const navigate = vi.fn();
let session: {
  client: {
    request: ReturnType<typeof vi.fn>;
    receipt: ReturnType<typeof vi.fn>;
    managedInspect: ReturnType<typeof vi.fn>;
  };
  origin: string;
  access: {
    protocolVersion: number;
    status: string;
    bootId: string;
    experimentalEnabled: boolean;
    device: { id: string; manage: boolean; send: boolean };
  };
  current: { id: string; agent: string };
  live: {
    sessionId: string;
    executionMode: string;
    status?: string;
    revision?: number;
    reason?: string;
  };
  capabilities: { sessionId: string; features: { adopt: { available: boolean } } };
  online: boolean;
  controlReady: boolean;
  busy: boolean;
  selected: string;
  refresh: ReturnType<typeof vi.fn>;
  locale: string;
};
vi.mock("@/features/conversation/features/sessions/session-context", () => ({
  useSession: () => session,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/features/conversation/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
const options = { available: true, workspaces: [{ id: "workspace", name: "Project" }], models: [] };
const mutations = () =>
  session.client.request.mock.calls.filter(([path]) => !path.startsWith("managed/options"));
describe("ManagedTasks", () => {
  beforeEach(() => {
    navigate.mockReset();
    sessionStorage.clear();
    session = {
      origin: "",
      client: {
        receipt: vi.fn(async (requestId: string) => ({ found: false, requestId })),
        managedInspect: vi.fn(async (sessionId: string) => ({
          sessionId,
          handoffFingerprint: "verified-history",
        })),
        request: vi.fn(async (path: string) =>
          path.startsWith("managed/options")
            ? options
            : { sessionId: "new-session", reconciled: true },
        ),
      },
      access: {
        status: "approved",
        protocolVersion: 2,
        bootId: "boot",
        experimentalEnabled: true,
        device: { id: "browser", manage: true, send: true },
      },
      current: { id: "original-session", agent: "codex" },
      live: {
        sessionId: "original-session",
        executionMode: "external",
        status: "idle",
        reason: "handoff-required",
      },
      capabilities: { sessionId: "original-session", features: { adopt: { available: true } } },
      online: true,
      controlReady: true,
      busy: false,
      selected: "original-session",
      refresh: vi.fn().mockResolvedValue(undefined),
      locale: "en-US",
    };
  });
  afterEach(cleanup);
  it.each(["external", "codex-managed", "claude-managed", "claude-follower"])(
    "hides Codex ownership controls and their obsolete options lookup (%s)",
    (executionMode) => {
      session.live.executionMode = executionMode;
      if (executionMode.startsWith("claude")) session.current.agent = "claude-code";
      render(<ManagedTasks renderContent={(content) => content} />);
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
      expect(session.client.request).not.toHaveBeenCalled();
    },
  );

  it.each(["adopt", "release", "reconcile"] as const)(
    "keeps a saved Codex %s fenced and checks its receipt while the operations panel is hidden",
    async (kind) => {
      const requestId = crypto.randomUUID();
      const scope = pendingScope("", "browser");
      rememberPending(scope, { requestId, sessionId: "original-session", kind });
      session.client.receipt.mockResolvedValue({ found: true, requestId, status: "unknown" });
      const panel = (active: boolean) => (
        <ManagedTasks
          renderContent={(content) => (active ? <div role="group">{content}</div> : null)}
        />
      );
      const view = render(panel(false));
      await waitFor(() => expect(session.client.receipt).toHaveBeenCalledWith(requestId));
      expect(readPending(scope)).toHaveLength(1);
      view.rerender(panel(true));
      expect(screen.getByText(/The previous outcome is unconfirmed/)).toBeInTheDocument();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
      expect(mutations()).toEqual([]);

      view.rerender(panel(false));
      session.client.receipt.mockResolvedValue({
        found: true,
        requestId,
        sessionId: "original-session",
        operation: kind,
        status: "accepted",
      });
      act(() =>
        publishSessionInvalidation(session.client as unknown as WebClient, "original-session", [
          "receipts",
        ]),
      );
      await waitFor(() => expect(readPending(scope)).toEqual([]));
      expect(session.refresh).toHaveBeenCalledWith(true);
      expect(session.client.request).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    },
  );

  it.each(["permission", "experimental", "agent"])(
    "hides execution management when %s is unavailable",
    (reason) => {
      session.current.agent = "claude-code";
      if (reason === "permission") session.access.device.manage = false;
      if (reason === "experimental") session.access.experimentalEnabled = false;
      if (reason === "agent") session.current.agent = "claude";
      render(<ManagedTasks renderContent={(content) => content} />);
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(session.client.request).not.toHaveBeenCalled();
    },
  );
  it.each(["adopt", "release", "reconcile"] as const)(
    "recovers a legacy prepared %s without replaying it",
    async (kind) => {
      const requestId = crypto.randomUUID();
      const scope = pendingScope("", "browser");
      rememberPending(scope, {
        requestId,
        workspaceId: "workspace",
        sessionId: "original-session",
        kind,
      });
      session.client.receipt.mockResolvedValue({
        found: true,
        requestId,
        status: "not-dispatched",
        recovery: "legacy-prepared",
        completionObserved: false,
      });
      render(<ManagedTasks renderContent={() => null} />);
      await waitFor(() => expect(readPending(scope)).toEqual([]));
      expect(mutations()).toHaveLength(0);
      expect(navigate).not.toHaveBeenCalled();
      expect(session.refresh).toHaveBeenCalledWith(true);
    },
  );
});
