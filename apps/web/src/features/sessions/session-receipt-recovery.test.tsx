import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionReceiptRecovery, type SessionReceiptRecoveryProps } from "@agentkib/session-ui";
import { render } from "../conversation/web-reader-test-utils";

afterEach(cleanup);

function panel(session: SessionReceiptRecoveryProps["session"], open = true) {
  return (
    <SessionReceiptRecovery
      session={session}
      renderContent={(content) => (open ? <section>{content}</section> : null)}
    />
  );
}

it.each(["adopt", "release", "reconcile"] as const)(
  "offers Continue for a saved %s only once the grace period ends and the panel is open",
  (kind) => {
    const saved = { requestId: crypto.randomUUID(), sessionId: "session", kind };
    const continueOutcome = vi.fn();
    const session = {
      locale: "en-US",
      busy: false,
      selectedOutcomes: [saved],
      canContinueOutcome: () => false,
      continueOutcome,
    } satisfies SessionReceiptRecoveryProps["session"];
    const view = render(panel(session));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    const expired = { ...session, canContinueOutcome: () => true };
    view.rerender(panel(expired, false));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    view.rerender(panel(expired));
    const choice = screen.getByRole("button", { name: "Continue" });
    expect(choice).toHaveAttribute("title", "Previous result unconfirmed");
    fireEvent.click(choice);
    expect(continueOutcome).toHaveBeenCalledExactlyOnceWith(saved.requestId);

    view.rerender(panel({ ...expired, selectedOutcomes: [] }));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  },
);

it("leaves composer and interaction recovery in their own controls", () => {
  const selectedOutcomes = (
    ["send", "stop", "approve", "answer", "settings", "open-model-picker"] as const
  ).map((kind) => ({ requestId: crypto.randomUUID(), sessionId: "session", kind }));
  render(
    panel({
      selectedOutcomes,
      locale: "en-US",
      busy: false,
      canContinueOutcome: () => true,
      continueOutcome: vi.fn(),
    }),
  );
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
});
