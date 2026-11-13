// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import { RemoteErrorDetails } from "./RemoteErrorDetails";

beforeAll(() => initializeI18n("en-US"));
afterEach(cleanup);

describe("remote error feedback", () => {
  it.each([
    ["REMOTE_PAIRING_INVALID", "pairing"],
    ["REMOTE_OFFLINE", "offline"],
    ["REMOTE_DISCONNECTED", "disconnected"],
    ["REMOTE_REVOKED", "revoked"],
    ["REMOTE_IDENTITY_CHANGED", "identity"],
    ["REMOTE_SHARING_DISABLED", "sharing"],
    ["REMOTE_INDEX_DISABLED", "index"],
    ["REMOTE_PROTOCOL_MISMATCH", "protocol"],
    ["REMOTE_LIMIT", "limit"],
    ["REMOTE_REQUEST_FAILED", "request"],
    ["pairing expired", "pairing"],
    ["pairing not approved", "approval"],
    ["Invalid pairing code", "pairing"],
    ["cannot pair with this device", "self"],
    ["private IPv4 address required", "address"],
    ["Remote address must be an IPv4 address with a valid port", "address"],
    ["select a local network interface", "interface"],
    ["enable sharing first", "enableSharing"],
    ["Address already in use (os error 48)", "portBusy"],
    ["Connection refused (os error 61)", "offline"],
    ["host limit reached", "limit"],
    ["REMOTE_PAIRING_INVALID_EXTRA", "request"],
    ["Unexpected internal failure", "request"],
  ])("explains %s and hides technical diagnostics by default", (code, suffix) => {
    const message = `Error invoking remote method 'agentkib:remote:request': RuntimeRequestError: AgentKib command failed: ${code}`;
    render(<RemoteErrorDetails error={new Error(message)} />);
    expect(screen.getByText(tr(`remote.error.${suffix}`))).toBeVisible();
    expect(screen.queryByText(message)).toBeNull();
    const disclosure = screen.getByRole("button", { name: tr("errors.details") });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(disclosure);
    expect(screen.getByText(message)).toBeVisible();
  });

  it("retranslates real IPC errors in four languages without replacing the error", async () => {
    const error = new Error("RuntimeRequestError: REMOTE_PAIRING_INVALID");
    const { container } = render(<RemoteErrorDetails error={error} />);
    const summary = container.querySelector("p");
    const translations = new Set<string>();
    try {
      for (const locale of ["zh-CN", "zh-Hant", "ja-JP", "en-US"] as const) {
        await act(() => changeLocale(locale));
        const expected = tr("remote.error.pairing");
        expect(expected).not.toBe("remote.error.pairing");
        translations.add(expected);
        expect(summary).toHaveTextContent(expected);
        expect(container.textContent).not.toContain("REMOTE_PAIRING_INVALID");
      }
      expect(translations.size).toBe(4);
    } finally {
      await act(() => changeLocale("en-US"));
    }
  });

  it("retains structured translations and hides details until expanded", () => {
    render(
      <RemoteErrorDetails
        error={{
          key: "remote.listening",
          params: { address: "192.168.1.20:42987" },
          detail: "Private diagnostic",
        }}
      />,
    );
    expect(screen.getByText("Listening: 192.168.1.20:42987")).toBeVisible();
    expect(screen.queryByText(/Private diagnostic/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: tr("errors.details") }));
    expect(screen.getByText(/Private diagnostic/)).toBeVisible();
  });

  it("bounds diagnostics and closes the disclosure when the error changes", () => {
    const { container, rerender } = render(<RemoteErrorDetails error={"x".repeat(8000)} />);
    fireEvent.click(screen.getByRole("button", { name: tr("errors.details") }));
    expect(container.querySelector("pre")?.textContent).toHaveLength(4096);
    rerender(<RemoteErrorDetails error="REMOTE_REVOKED" />);
    expect(screen.getByRole("button", { name: tr("errors.details") })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByText("REMOTE_REVOKED")).toBeNull();
  });
});
