// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionReceiptRecovery, type SessionReceiptRecoveryProps } from "@agentkib/session-ui";
import { render } from "../../desktop-reader-test-utils";

afterEach(cleanup);

it("disables only the recovery action while busy and continues the stored operation by identity", () => {
  const receipt = {
    requestId: crypto.randomUUID(),
    sessionId: "session",
    kind: "reconcile",
  } as const;
  const continueOutcome = vi.fn();
  const recovery = (busy: boolean) => {
    const session: SessionReceiptRecoveryProps["session"] = {
      selectedOutcomes: [receipt],
      locale: "en-US",
      busy,
      canContinueOutcome: () => true,
      continueOutcome,
    };
    return (
      <div>
        <button type="button">View session</button>
        <SessionReceiptRecovery session={session} renderContent={(content) => content} />
      </div>
    );
  };
  const view = render(recovery(true));
  const button = screen.getByRole("button", { name: "Continue" });
  expect(button).toBeDisabled();
  expect(screen.getByRole("button", { name: "View session" })).toBeEnabled();
  fireEvent.click(button);
  expect(continueOutcome).not.toHaveBeenCalled();

  view.rerender(recovery(false));
  expect(button).toBeEnabled();
  fireEvent.click(button);
  expect(continueOutcome).toHaveBeenCalledExactlyOnceWith(receipt.requestId);
  expect(screen.queryByRole("button", { name: "Reconcile outcome" })).not.toBeInTheDocument();
});
