// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import { McpPortField } from "./McpPortField";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe("McpPortField", () => {
  beforeEach(async () => {
    await initializeI18n("en-US");
  });
  afterEach(cleanup);

  it.each(["en-US", "zh-CN", "zh-Hant", "ja-JP"] as const)(
    "labels invalid input and explains saving in %s",
    async (locale) => {
      await initializeI18n(locale);
      const onCommit = vi.fn();
      render(<McpPortField port={47653} onCommit={onCommit} />);
      const input = screen.getByRole("spinbutton", { name: tr("mcp.port") });
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.blur(input);
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByRole("alert")).toHaveTextContent(tr("mcp.portInvalid"));
      expect(input).toHaveAccessibleDescription(expect.stringContaining(tr("mcp.portHint")));
      expect(input).toHaveAccessibleDescription(expect.stringContaining(tr("mcp.portInvalid")));
      expect(onCommit).not.toHaveBeenCalled();
    },
  );

  it.each(["0", "-1", "65536", "2.5"])("rejects invalid port %s", (value) => {
    const onCommit = vi.fn();
    render(<McpPortField port={47653} onCommit={onCommit} />);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value } });
    fireEvent.keyDown(screen.getByRole("spinbutton"), { key: "Enter" });
    expect(screen.getByRole("alert")).toHaveTextContent(tr("mcp.portInvalid"));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it.each([1, 65535])("commits boundary %s once across Enter and blur", async (port) => {
    const request = deferred<number>();
    const onCommit = vi.fn().mockReturnValue(request.promise);
    render(<McpPortField port={47653} onCommit={onCommit} />);
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: String(port) } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(port);
    expect(input).toBeDisabled();
    await act(async () => request.resolve(port));
    expect(input).toBeEnabled();
    expect(screen.getByText(tr("mcp.portCurrent", { port }))).toBeVisible();
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("synchronizes a clean value and keeps the same focused control", () => {
    const onCommit = vi.fn();
    const view = render(<McpPortField port={47653} onCommit={onCommit} />);
    const input = screen.getByRole("spinbutton");
    input.focus();
    view.rerender(<McpPortField port={49000} onCommit={onCommit} />);
    expect(screen.getByRole("spinbutton")).toBe(input);
    expect(input).toHaveValue(49000);
    expect(input).toHaveFocus();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("preserves a dirty draft on external refresh and Esc restores the latest port", () => {
    const onCommit = vi.fn();
    const view = render(<McpPortField port={47653} onCommit={onCommit} />);
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "49000" } });
    view.rerender(<McpPortField port={48000} onCommit={onCommit} />);
    expect(input).toHaveValue(49000);
    expect(screen.getByText(tr("mcp.portCurrent", { port: 48000 }))).toBeVisible();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue(48000);
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("clears validation after correction and allows committing", async () => {
    const onCommit = vi.fn().mockResolvedValue(49000);
    render(<McpPortField port={47653} onCommit={onCommit} />);
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: "49000" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-invalid", "true");
    fireEvent.blur(input);
    await waitFor(() => expect(input).toBeEnabled());
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(49000);
  });

  it("keeps an unconfirmed save for retry without automatic writes", async () => {
    const onCommit = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(49000);
    render(<McpPortField port={47653} onCommit={onCommit} />);
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "49000" } });
    fireEvent.blur(input);
    await screen.findByText(tr("mcp.portUnconfirmed"));
    expect(input).toHaveValue(49000);
    expect(screen.getByText(tr("mcp.portCurrent", { port: 47653 }))).toBeVisible();
    expect(onCommit).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(screen.queryByText(tr("mcp.portUnconfirmed"))).not.toBeInTheDocument(),
    );
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("acknowledges matching runtime refresh after a readback failure", async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    const view = render(<McpPortField port={47653} onCommit={onCommit} />);
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "49000" } });
    fireEvent.blur(input);
    await screen.findByText(tr("mcp.portUnconfirmed"));
    view.rerender(<McpPortField port={49000} onCommit={onCommit} />);
    expect(screen.queryByText(tr("mcp.portUnconfirmed"))).not.toBeInTheDocument();
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("shows an unconfirmed result if its host rejects", async () => {
    const onCommit = vi.fn().mockRejectedValue(new Error("connection lost"));
    render(<McpPortField port={47653} onCommit={onCommit} />);
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "49000" } });
    fireEvent.blur(input);
    await screen.findByText(tr("mcp.portUnconfirmed"));
    expect(input).toHaveValue(49000);
    expect(input).toBeEnabled();
  });

  it("does not commit when disabled or after Esc discards an invalid draft", () => {
    const onCommit = vi.fn();
    const view = render(<McpPortField port={47653} disabled onCommit={onCommit} />);
    fireEvent.blur(screen.getByRole("spinbutton"));
    expect(onCommit).not.toHaveBeenCalled();
    view.rerender(<McpPortField port={47653} onCommit={onCommit} />);
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue(47653);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("settles an in-flight commit after unmount without another request", async () => {
    const request = deferred<number>();
    const onCommit = vi.fn().mockReturnValue(request.promise);
    const view = render(<McpPortField port={47653} onCommit={onCommit} />);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "49000" } });
    fireEvent.blur(screen.getByRole("spinbutton"));
    view.unmount();
    await act(async () => request.resolve(49000));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
