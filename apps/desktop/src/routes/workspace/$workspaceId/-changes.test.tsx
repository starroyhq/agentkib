// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import type { ChangeSet, SessionHandoffLaunchRequest } from "@/core/types";
import { Changes } from "./changes";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => () => ({}),
    useNavigate: vi.fn(),
    useParams: vi.fn(),
  };
});

const changeSet: ChangeSet = {
  id: "changeset-native-session",
  project_root: "/workspace",
  created_at: "2026-09-01T00:00:00Z",
  requires_home_approval: true,
  changes: [
    {
      target: "/agent-home/sessions/import.jsonl",
      scope: "agent-home",
      before: "",
      after: "{}\n",
      risk: "high",
      validator: "jsonl",
    },
  ],
};

const launchRequest: SessionHandoffLaunchRequest = {
  mode: "native-session",
  workspace_id: "workspace",
  target_agent: "codex",
  target_session_id: "session",
  target_path: "/agent-home/sessions/import.jsonl",
  capabilities: {
    source_agent: "codex",
    target_agent: "codex",
    source_read: { status: "supported" },
    source_parse: { status: "supported" },
    native_resume: { status: "supported" },
    file_handoff: { status: "supported" },
    windowed_context: { status: "supported" },
    mcp_setup: { status: "supported" },
    interactive_launch: { status: "supported" },
  },
};

describe("Changes", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("allows a native handoff after Agent Home approval", () => {
    render(
      <Changes
        changeSet={changeSet}
        origin="handoff"
        launchRequest={launchRequest}
        onPlanHome={vi.fn()}
        onApplied={vi.fn()}
        onLaunchCompleted={vi.fn()}
        onRejected={vi.fn()}
        onApplyingChange={vi.fn()}
      />,
    );

    const applyOnly = screen.getByRole("button", { name: "Apply only" }) as HTMLButtonElement;
    const applyAndContinue = screen.getByRole("button", {
      name: "Apply and continue in Codex",
    }) as HTMLButtonElement;
    expect(applyOnly.disabled).toBe(true);
    expect(applyAndContinue.disabled).toBe(true);

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "I authorize changes to the Agent Home files listed above",
      }),
    );

    expect(applyOnly.disabled).toBe(false);
    expect(applyAndContinue.disabled).toBe(false);
  });
});
