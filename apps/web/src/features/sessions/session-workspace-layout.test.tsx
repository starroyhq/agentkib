import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { SessionWorkspace } from "./session-workspace";
import { useSessionPanels } from "@/features/conversation/features/sessions/session-panels";
import { dictionaries } from "@/features/conversation/i18n";
const fixture = vi.hoisted(() => ({
  pathname: "/sessions",
  selected: "",
  mounts: 0,
  files: true,
  modal: null as string | null,
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (v: { pathname: string }) => unknown }) =>
    select({ pathname: fixture.pathname }),
  useNavigate: () => vi.fn(),
  Outlet: () => {
    const panels = useSessionPanels();
    return <div data-testid="panels">{panels?.filesOpen ? "files-open" : "files-closed"}</div>;
  },
}));
vi.mock("@/features/conversation/features/sessions/session-context", () => ({
  useSession: () => ({
    t: dictionaries["zh-CN"],
    locale: "zh-CN",
    selected: fixture.selected,
    modal: fixture.modal,
    currentTitle: "测试会话",
    currentWorkspace: { name: "测试工作区" },
    online: true,
    controlReady: true,
    canSend: true,
    live: { status: "idle", approvals: [] },
    access: { experimentalEnabled: true, device: { send: true, files: fixture.files } },
    sessions: [],
    workspaces: [],
    pendingSessions: {},
    setModal: vi.fn(),
    refresh: vi.fn(),
    post: vi.fn(),
    leaveSession: vi.fn(),
  }),
}));
vi.mock("@agentkib/session-ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@agentkib/session-ui")>()),
  PendingCenter: () => {
    useEffect(() => {
      fixture.mounts++;
    }, []);
    return <button>pending-center</button>;
  },
}));
vi.mock("@/features/conversation/features/sessions/session-receipt-recovery", () => ({
  SessionReceiptRecovery: () => null,
}));
vi.mock("@/features/conversation/features/catalog/session-catalog", () => ({
  SessionCatalog: () => null,
}));
afterEach(() => {
  cleanup();
  fixture.pathname = "/sessions";
  fixture.selected = "";
  fixture.mounts = 0;
  fixture.files = true;
  fixture.modal = null;
});
describe("workspace navigation", () => {
  it("keeps one pending center mounted when entering and leaving a session", () => {
    const view = render(<SessionWorkspace />);
    fixture.pathname = "/sessions/s";
    fixture.selected = "s";
    view.rerender(<SessionWorkspace />);
    expect(screen.getAllByRole("button", { name: "pending-center" })).toHaveLength(1);
    expect(fixture.mounts).toBe(1);
    fixture.pathname = "/sessions";
    fixture.selected = "";
    view.rerender(<SessionWorkspace />);
    expect(fixture.mounts).toBe(1);
  });
  it("clears the file panel on host-selected session changes", async () => {
    fixture.pathname = "/sessions/s";
    fixture.selected = "s";
    const view = render(<SessionWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "文件与产物" }));
    expect(screen.getByTestId("panels")).toHaveTextContent("files-open");
    fixture.selected = "other";
    view.rerender(<SessionWorkspace />);
    await waitFor(() => expect(screen.getByTestId("panels")).toHaveTextContent("files-closed"));
  });
  it("does not expose file browsing without the existing permission", () => {
    fixture.pathname = "/sessions/s";
    fixture.selected = "s";
    fixture.files = false;
    render(<SessionWorkspace />);
    expect(screen.queryByRole("button", { name: "文件与产物" })).not.toBeInTheDocument();
  });
  it("releases the fullscreen file panel when a global approval opens", () => {
    fixture.pathname = "/sessions/s";
    fixture.selected = "s";
    const view = render(<SessionWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "文件与产物" }));
    expect(screen.getByTestId("panels")).toHaveTextContent("files-open");
    fixture.modal = "approval";
    view.rerender(<SessionWorkspace />);
    expect(screen.getByTestId("panels")).toHaveTextContent("files-closed");
  });
});
