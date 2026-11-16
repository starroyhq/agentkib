import { describe, expect, it } from "vitest";
import { continuationPreflightReason } from "./continuation-reason";

describe("continuationPreflightReason", () => {
  it("passes Devin CLI's refusals on, so clients can explain them and offer a way out", () => {
    for (const reason of [
      "devin-login-required",
      "devin-workspace-untrusted",
      "devin-cli-unavailable",
      "devin-run-failed",
      "devin-session-not-found",
      "session-open-elsewhere",
      "attachments-unsupported",
    ])
      expect(continuationPreflightReason(reason)).toBe(reason);
  });

  it("keeps any other owner diagnostic private", () => {
    expect(continuationPreflightReason("devin exited with code 3 in /private/path")).toBe(
      "control_preflight_rejected",
    );
    expect(continuationPreflightReason(undefined)).toBe("control_preflight_rejected");
  });
});
