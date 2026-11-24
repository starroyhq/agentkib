// @vitest-environment node
import { describe, expect, it } from "vitest";
import { webAdminReply } from "./admin-errors";

describe("desktop Web admin reply", () => {
  it.each([
    "account_login_required",
    "account_device_conflict",
    "account_claim_pending",
    "invalid_saved_configuration",
    "web_server_error",
    "invalid_relay_configuration",
    "pairing_expired",
    "web_state_save_failed",
  ])("preserves the fixed reason code %s for a rejected IPC operation", async (reason) => {
    const cause = new Error("private /tmp/web-access.json and credentials");
    await expect(
      webAdminReply(() => Promise.reject(new Error(reason, { cause }))),
    ).resolves.toEqual({ ok: false, reason });
  });

  it.each([
    new Error("account_login_required: private /tmp/web-access.json"),
    new Error("private relay failure"),
    "/tmp/private/configuration",
    { code: "invalid_relay_configuration", path: "/tmp/private/configuration" },
  ])("replaces unexpected error details with the fixed fallback code", async (error) => {
    await expect(webAdminReply(() => Promise.reject(error))).resolves.toEqual({
      ok: false,
      reason: "web_request_failed",
    });
  });
});
