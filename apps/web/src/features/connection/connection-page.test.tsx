import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectionScreen } from "./connection-page";
import { connectionCopy } from "./connection-copy";
import { dictionaries, type Locale } from "@/features/conversation/i18n";

afterEach(cleanup);

describe("ConnectionScreen", () => {
  it.each([
    ["zh-CN", "局域网直连", "电脑上的 AgentKib"],
    ["zh-Hant", "區域網路直連", "電腦上的 AgentKib"],
    ["en-US", "LAN direct connection", "AgentKib on your computer"],
    ["ja-JP", "LAN 直接接続", "コンピューター上の AgentKib"],
  ] as const)(
    "points to the current computer application and LAN setting in %s",
    (locale, setting, app) => {
      const onConnect = vi.fn();
      render(<ConnectionScreen initialLocale={locale} onConnect={onConnect} />);
      const help = screen.getByRole("button", { name: connectionCopy[locale].addressHelp });
      fireEvent.click(help);
      const steps = screen.getAllByRole("listitem");
      expect(steps).toHaveLength(3);
      expect(steps[0]).toHaveTextContent(setting);
      for (const step of steps) expect(step).toHaveTextContent(app);
      expect(document.getElementById("connection-address-help")).toHaveTextContent(setting);
      expect(document.getElementById("connection-address-help")).toHaveTextContent(app);
      const permission = screen.getByText(dictionaries[locale].lanPermission);
      expect(permission).toHaveTextContent(setting);
      expect(permission).toHaveTextContent(app);
      if (locale === "zh-CN") expect(steps[0]).toHaveTextContent("“局域网直连”");
      expect(screen.getByRole("checkbox")).not.toBeChecked();
      expect(screen.getByRole("button", { name: dictionaries[locale].connect })).toBeDisabled();
      expect(screen.getByRole("button", { name: dictionaries[locale].connect })).toHaveTextContent(
        app,
      );
      expect(document.body.textContent).not.toMatch(/桌面|デスクトップ|\bdesktop\b/i);
      expect(onConnect).not.toHaveBeenCalled();
    },
  );

  it.each(Object.keys(connectionCopy) as Locale[])(
    "keeps help and preferences optional without granting LAN consent in %s",
    (locale) => {
      const onConnect = vi.fn();
      render(<ConnectionScreen initialLocale={locale} onConnect={onConnect} />);
      const preferences = screen.getByRole("button", { name: dictionaries[locale].preferences });
      const help = screen.getByRole("button", { name: connectionCopy[locale].addressHelp });
      expect(preferences).toHaveAttribute("aria-expanded", "false");
      expect(help).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(preferences);
      fireEvent.click(help);
      expect(preferences).toHaveAttribute("aria-expanded", "true");
      expect(help).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText(dictionaries[locale].lanRisk)).toBeInTheDocument();
      expect(screen.getByRole("checkbox")).not.toBeChecked();
      expect(screen.getByRole("button", { name: dictionaries[locale].connect })).toBeDisabled();
      expect(onConnect).not.toHaveBeenCalled();
      fireEvent.click(help);
      expect(help).toHaveAttribute("aria-expanded", "false");
    },
  );

  it("requires consent and shows an error for an invalid address", () => {
    const onConnect = vi.fn();
    render(<ConnectionScreen onConnect={onConnect} />);

    const address = screen.getByLabelText("电脑的局域网地址");
    const connect = screen.getByRole("button", { name: "连接电脑上的 AgentKib" });
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
    fireEvent.click(screen.getByRole("button", { name: "Connect to AgentKib on your computer" }));

    expect(onConnect).toHaveBeenCalledWith("http://192.168.1.10:1422", "en-US", "dark");
  });
});
