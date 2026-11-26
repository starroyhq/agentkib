import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ControlReceipt, WebClient } from "@agentkib/web-client";
import { render } from "../conversation/web-reader-test-utils";
import { SessionOutcomeAction } from "../../../../../packages/session-ui/src/conversation/sessions/session-outcome-action";
import { readPendingControlReceipt } from "../../../../../packages/session-ui/src/session-control-receipts";

afterEach(cleanup);

const pending = {
  requestId: "11111111-1111-4111-8111-111111111111",
  sessionId: "session",
  kind: "send",
} as const;

it.each([
  ["en-US", "Continue", "Previous result unconfirmed"],
  ["zh-CN", "继续", "上次结果不明"],
  ["zh-Hant", "繼續", "上次結果不明"],
  ["ja-JP", "続ける", "前回の結果は未確認"],
] as const)(
  "shows the chosen recovery in the send slot in %s without submitting the form",
  (locale, label, reason) => {
    const submit = vi.fn();
    const continueOutcome = vi.fn();
    const eligible = vi.fn(() => false);
    const composer = () => (
      <form onSubmit={submit}>
        <SessionOutcomeAction
          session={{
            locale,
            busy: false,
            selectedOutcomes: [pending],
            canContinueOutcome: eligible,
            continueOutcome,
          }}
          actions={["send"]}
          fallback={<button disabled>Send</button>}
        />
        <button type="button">Stop</button>
      </form>
    );
    const view = render(composer());
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();

    eligible.mockReturnValue(true);
    view.rerender(composer());
    const recovery = screen.getByRole("button", { name: label });
    expect(recovery).toHaveAttribute("title", reason);
    expect(recovery).toHaveAttribute("type", "button");
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    fireEvent.click(recovery);
    expect(continueOutcome).toHaveBeenCalledExactlyOnceWith(pending.requestId);
    expect(submit).not.toHaveBeenCalled();
  },
);

const accepted = {
  found: true,
  requestId: pending.requestId,
  sessionId: pending.sessionId,
  operation: pending.kind,
  status: "accepted",
  completionObserved: false,
} satisfies ControlReceipt;

it.each([
  ["missing", { found: false, requestId: pending.requestId }],
  ["unknown", { ...accepted, status: "unknown" }],
  ["another session", { ...accepted, sessionId: "other" }],
  ["another operation", { ...accepted, operation: "stop" }],
  ["another identity", { ...accepted, requestId: "22222222-2222-4222-8222-222222222222" }],
  [
    "contradictory legacy marker",
    { ...accepted, recovery: "legacy-prepared" } as unknown as ControlReceipt,
  ],
] satisfies [string, ControlReceipt][])(
  "does not settle a stored identity from a %s receipt",
  async (_case, value) => {
    const receipt = vi.fn(async () => value);
    const request = vi.fn();
    const client = { receipt, request } as unknown as WebClient;
    await expect(readPendingControlReceipt(client, pending)).resolves.toBeUndefined();
    expect(receipt).toHaveBeenCalledExactlyOnceWith(pending.requestId);
    expect(request).not.toHaveBeenCalled();
  },
);

it.each([
  ["accepted", accepted],
  ["not dispatched", { ...accepted, status: "not-dispatched" }],
  [
    "legacy prepared",
    {
      found: true,
      requestId: pending.requestId,
      status: "not-dispatched",
      recovery: "legacy-prepared",
      completionObserved: false,
    },
  ],
] satisfies [string, ControlReceipt][])(
  "accepts exact %s proof without issuing another operation",
  async (_case, value) => {
    const receipt = vi.fn(async () => value);
    const request = vi.fn();
    const client = { receipt, request } as unknown as WebClient;
    await expect(readPendingControlReceipt(client, pending)).resolves.toEqual(value);
    expect(receipt).toHaveBeenCalledExactlyOnceWith(pending.requestId);
    expect(request).not.toHaveBeenCalled();
  },
);
