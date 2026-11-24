// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  ApprovalRule,
  ApprovalRuleList,
  SessionApprovalAuditEntry,
} from "@agentkib/web-client";
import type {
  DesktopConversationBridge,
  DesktopConversationResponse,
} from "@/core/conversation-bridge";
import { initializeI18n } from "@/core/i18n";
import { ApprovalOversightSettings } from "./ApprovalOversightSettings";

const workspaces = [{ id: "project-1", name: "Test project" }];
const globalRule: ApprovalRule = {
  id: "global-allow",
  agent: "codex",
  scope: "global",
  source: "~/.codex/rules/default.rules",
  content: "git status",
  revocable: false,
};
const projectRule: ApprovalRule = {
  id: "local-allow",
  agent: "claude-code",
  scope: "project",
  source: ".claude/settings.local.json",
  content: "Read(src/**)",
  revocable: true,
};
const providers: ApprovalRuleList["providers"] = {
  codex: { list: true, revoke: false },
  "claude-code": { list: true, revoke: true },
  "deepseek-harness": { list: false, revoke: false },
  devin: { list: true, revoke: false },
  antigravity: { list: true, revoke: false },
};
const entry: SessionApprovalAuditEntry = {
  id: "decision-1",
  sessionId: "session-1",
  agent: "codex",
  workspaceId: "project-1",
  kind: "approval",
  summary: "Run a command",
  risk: { level: "high", reason: "native-tool" },
  decision: { kind: "allow", scope: "once" },
  source: { kind: "phone", deviceId: "paired-phone", deviceName: "Test phone" },
  time: "2026-11-24T08:00:00.000Z",
  result: "executed",
};

const previous = window.desktopConversation;
beforeAll(() => initializeI18n("en-US"));
afterEach(() => {
  cleanup();
  window.desktopConversation = previous;
});

function respond(body: unknown, status = 200): DesktopConversationResponse {
  return { body, status };
}

function fixture({
  supported = true,
  full = true,
  intercept,
}: {
  supported?: boolean;
  full?: boolean;
  intercept?: DesktopConversationBridge["request"];
} = {}) {
  let revoked = false;
  const request = vi.fn<DesktopConversationBridge["request"]>(async (route, body) => {
    if (intercept) {
      const response = await intercept(route, body);
      if (response.status !== 0) return response;
    }
    if (route === "access")
      return respond({
        status: "approved",
        protocolVersion: 2,
        csrfToken: "test",
        bootId: "boot",
        ...(supported ? { approvalAuditVersion: 1, approvalRulesVersion: 1 } : {}),
        device: { id: "desktop-local", name: "Desktop", accessMode: "full", settings: full },
      });
    if (route === "approval-rules") return respond({ providers, rules: [globalRule] });
    if (route === "approval-rules?workspaceId=project-1")
      return respond({ providers, rules: revoked ? [] : [projectRule] });
    if (route === "approval-rules/revoke") {
      revoked = true;
      return respond({ revoked: true });
    }
    if (route === "approval-audit")
      return respond({ entries: [entry], nextCursor: "opaque-cursor" });
    if (route === "approval-audit?before=opaque-cursor")
      return respond({
        entries: [
          {
            ...entry,
            id: "decision-2",
            summary: "Ask a question",
            decision: { kind: "answer", scope: "unknown" },
            result: "unknown",
          },
        ],
      });
    return respond({ error: "unexpected_test_request" }, 404);
  });
  window.desktopConversation = {
    request,
    upload: vi.fn(),
    subscribe: vi.fn(),
    acknowledge: vi.fn(),
    unsubscribe: vi.fn(),
    onEvent: vi.fn(),
    onUnavailable: vi.fn(),
    onControlChanged: vi.fn(),
  };
  render(<ApprovalOversightSettings workspaces={workspaces} />);
  return { request };
}

describe("desktop approval oversight", () => {
  it("loads scopes on demand and requires explicit confirmation before a rule write", async () => {
    const { request } = fixture();
    const user = userEvent.setup();
    expect(request).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Auto-allow rules" }));
    expect(await screen.findByText("git status")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Revoke" }).disabled).toBe(true);
    const scope = screen.getByRole("combobox", { name: "Rule scope" });
    await user.selectOptions(scope, "project-1");
    await screen.findByText("Read(src/**)");
    expect(screen.queryByText("git status")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(".claude/settings.local.json")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(request.mock.calls.some(([route]) => route === "approval-rules/revoke")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Revoke" }),
    );
    expect(await screen.findByText("Rule revoked.")).toBeTruthy();
    expect(await screen.findByText("No saved rules in this scope.")).toBeTruthy();
    const routes = request.mock.calls.map(([route]) => route);
    const revokeIndex = routes.indexOf("approval-rules/revoke");
    expect(routes[revokeIndex - 1]).toBe("access");
    expect(request.mock.calls[revokeIndex]?.[1]).toEqual({
      agent: "claude-code",
      ruleId: "local-allow",
      workspaceId: "project-1",
    });
  });

  it("does not send an oversight request to an older host", async () => {
    const { request } = fixture({ supported: false });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Auto-allow rules" }));
    await screen.findByText("Approval data is unavailable on this host version.");
    await user.click(screen.getByRole("button", { name: "Approval history" }));
    await waitFor(() => {
      expect(
        screen.getAllByText("Approval data is unavailable on this host version."),
      ).toHaveLength(2);
    });
    expect(request.mock.calls.map(([route]) => route)).toEqual(["access", "access"]);
  });

  it("allows a read retry and uses the host's opaque cursor for older decisions", async () => {
    let retry = false;
    const { request } = fixture({
      intercept: async (route) => {
        if (route === "approval-audit" && !retry) {
          retry = true;
          return respond({ error: "fake_test_failure" }, 503);
        }
        return respond(undefined, 0);
      },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Approval history" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not read");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Run a command")).toBeTruthy();
    expect(screen.getByText("High risk")).toBeTruthy();
    expect(screen.getByText("Executed")).toBeTruthy();
    expect(screen.getByText("Phone · Test phone · paired-phone")).toBeTruthy();
    expect(screen.getByText("session-1")).toBeTruthy();
    expect(screen.getByText("project-1")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Load older records" }));
    expect(await screen.findByText("Ask a question")).toBeTruthy();
    expect(screen.getByText("Outcome unknown")).toBeTruthy();
    expect(screen.getByText("Run a command")).toBeTruthy();
    expect(request.mock.calls.map(([route]) => route)).toContain(
      "approval-audit?before=opaque-cursor",
    );
    expect(screen.queryByRole("button", { name: "Load older records" })).toBeNull();
  });

  it("makes the revoke control read only when access is restricted", async () => {
    const { request } = fixture({ full: false });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Auto-allow rules" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Rule scope" }), "project-1");
    await screen.findByText("Read(src/**)");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Revoke" }).disabled).toBe(true);
    expect(request.mock.calls.some(([route]) => route === "approval-rules/revoke")).toBe(false);
  });

  it("submits a confirmed revocation only once while its response is pending", async () => {
    let finish!: (value: DesktopConversationResponse) => void;
    const pending = new Promise<DesktopConversationResponse>((done) => {
      finish = done;
    });
    const { request } = fixture({
      intercept: async (route) =>
        route === "approval-rules/revoke" ? pending : respond(undefined, 0),
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Auto-allow rules" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Rule scope" }), "project-1");
    await screen.findByText("Read(src/**)");
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    const action = within(screen.getByRole("alertdialog")).getByRole("button", { name: "Revoke" });
    fireEvent.click(action);
    fireEvent.click(action);
    await waitFor(() => {
      expect(
        request.mock.calls.filter(([route]) => route === "approval-rules/revoke"),
      ).toHaveLength(1);
    });
    await act(async () => finish(respond({ error: "approval-rule-write-unconfirmed" }, 409)));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Revocation could not be confirmed",
    );
    expect(await screen.findByText("Read(src/**)")).toBeTruthy();
  });
});
