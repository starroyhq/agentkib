import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectionScreen } from "./connection-page";

afterEach(cleanup);

describe("ConnectionScreen", () => {
  it("requires consent and shows an error for an invalid address", () => {
    const onConnect = vi.fn();
    render(<ConnectionScreen onConnect={onConnect} />);

    const address = screen.getByLabelText("电脑的局域网地址");
    const connect = screen.getByRole("button", { name: "连接桌面 AgentKib" });
    expect(connect).toBeDisabled();

    fireEvent.change(address, { target: { value: "https://example.com" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(connect);

    expect(onConnect).not.toHaveBeenCalled();
    expect(address).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toBeVisible();
  });

  it("passes a valid private LAN address and preferences to the caller", () => {
    const onConnect = vi.fn();
    render(<ConnectionScreen onConnect={onConnect} />);

    fireEvent.change(screen.getByLabelText("电脑的局域网地址"), {
      target: { value: "http://192.168.1.10:1422" },
    });
    fireEvent.change(screen.getByLabelText("语言"), { target: { value: "en-US" } });
    fireEvent.change(screen.getByLabelText("Appearance"), { target: { value: "dark" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Connect to desktop AgentKib" }));

    expect(onConnect).toHaveBeenCalledWith("http://192.168.1.10:1422", "en-US", "dark");
  });
});
