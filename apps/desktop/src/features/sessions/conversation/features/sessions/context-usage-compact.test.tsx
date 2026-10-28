// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextUsageGauge } from "./context-usage";
import { useSession } from "./session-context";
import { contextUsageCopy } from "./context-usage-copy";
import { codexCopy } from "./codex-copy";

vi.mock("./session-context", () => ({ useSession: vi.fn() }));
let state: ReturnType<typeof useSession>;
let control: ReturnType<typeof vi.fn>;
let codexAction: ReturnType<typeof vi.fn>;
const copy = contextUsageCopy["en-US"];
beforeEach(() => {
  control = vi.fn();
  codexAction = vi.fn();
  state = {
    selected: "s",
    locale: "en-US",
    online: true,
    canSend: true,
    current: { id: "s", agent: "claude-code" },
    access: {
      bootId: "boot",
      device: { id: "device", accessMode: "full", advancedControl: true, send: true },
    },
    client: {},
    page: {
      events: [{ id: "u", kind: "user-message", content: "hi", attachment_count: 0 }],
      warnings: [],
    },
    live: {
      sessionId: "s",
      status: "idle",
      revision: 1,
      executionMode: "claude-managed",
      approvals: [],
      usage: { available: true, state: "ready", reportId: 1, usedTokens: 20, contextWindow: 100 },
    },
    control,
    codexAction,
  } as unknown as ReturnType<typeof useSession>;
  vi.mocked(useSession).mockImplementation(() => state);
});
afterEach(cleanup);
const openDialog = () =>
  fireEvent.click(
    screen.getByRole("button", { name: codexCopy["en-US"].contextUsage, hidden: true }),
  );
const compact = () => screen.queryByRole("button", { name: copy.compactAction });

describe("compacting a managed Claude session on the desktop", () => {
  it("sends /compact as a message of its own and closes the dialog", () => {
    render(<ContextUsageGauge />);
    openDialog();
    expect(screen.getByRole("dialog")).toHaveTextContent(copy.compactDetail);
    fireEvent.click(compact()!);
    expect(control).toHaveBeenCalledExactlyOnceWith(
      "send",
      undefined,
      undefined,
      undefined,
      undefined,
      { command: "/compact" },
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("waits for the running turn to end", () => {
    state.canSend = false;
    state.live = { ...state.live!, status: "running" };
    render(<ContextUsageGauge />);
    openDialog();
    expect(compact()).toBeDisabled();
    expect(screen.getByRole("dialog")).toHaveTextContent(copy.compactAfterTurn);
  });

  it.each([
    [
      "a Codex session whose host offers no compaction",
      () => {
        state.current = { id: "s", agent: "codex" } as typeof state.current;
        state.live = { ...state.live!, executionMode: "codex-managed" };
      },
    ],
    [
      "a terminal-connected session",
      () => {
        state.live = { ...state.live!, executionMode: "claude-follower" };
      },
    ],
    [
      "a device that cannot send",
      () => {
        state.access = { ...state.access!, device: { ...state.access!.device!, send: false } };
      },
    ],
  ])("is not offered for %s", (_label, change) => {
    change();
    render(<ContextUsageGauge />);
    openDialog();
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(compact()).not.toBeInTheDocument();
  });
});

describe("compacting a managed Codex session on the desktop", () => {
  beforeEach(() => {
    state.current = { id: "s", agent: "codex" } as typeof state.current;
    state.live = { ...state.live!, executionMode: "codex-managed" };
    state.capabilities = {
      sessionId: "s",
      executionMode: "codex-managed",
      status: "idle",
      features: { compact: { available: true } },
    } as typeof state.capabilities;
  });

  it("starts Codex's own compaction and closes the dialog", () => {
    render(<ContextUsageGauge />);
    openDialog();
    expect(screen.getByRole("dialog")).toHaveTextContent(copy.compactDetailCodex);
    fireEvent.click(compact()!);
    expect(codexAction).toHaveBeenCalledExactlyOnceWith("compact");
    expect(control).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("waits for the running turn to end", () => {
    state.canSend = false;
    state.live = { ...state.live!, status: "running" };
    state.capabilities = {
      ...state.capabilities!,
      features: { compact: { available: false, reason: "session-busy" } },
    };
    render(<ContextUsageGauge />);
    openDialog();
    expect(compact()).toBeDisabled();
    expect(screen.getByRole("dialog")).toHaveTextContent(copy.compactAfterTurn);
  });
});
