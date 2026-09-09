import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { HostedConnection } from "./HostedConnection";
import { PairingLayout } from "./PairingLayout";
import { dictionaries } from "./i18n";

afterEach(cleanup);

it("keeps connection help, consent and error associated with the address", () => {
  render(<HostedConnection />);
  const address = screen.getByLabelText("电脑的局域网地址");
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
  expect(screen.getByRole("button", { name: "连接桌面 AgentKib" })).toBeDisabled();
  fireEvent.change(address, { target: { value: "http://8.8.8.8:1422" } });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "连接桌面 AgentKib" }));
  expect(address).toHaveAttribute("aria-invalid", "true");
  expect(address).toHaveAttribute("aria-describedby", "connection-address-help connection-error");
  expect(screen.getByRole("alert")).toBeVisible();
});

it("localizes the desktop guide together with the form", () => {
  render(<HostedConnection />);
  fireEvent.change(screen.getByLabelText("语言"), { target: { value: "en-US" } });
  expect(screen.getByRole("heading", { name: "Connect your computer" })).toBeVisible();
  expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("Enable hosted web LAN access");
});

it("marks the actual pairing step without changing its child controls", () => {
  const view = render(
    <PairingLayout words={dictionaries["zh-CN"]}>
      <button>test action</button>
    </PairingLayout>,
  );
  expect(screen.getAllByRole("listitem")[0]).toHaveAttribute("aria-current", "step");
  view.rerender(
    <PairingLayout words={dictionaries["zh-CN"]} pending>
      <button>test action</button>
    </PairingLayout>,
  );
  expect(screen.getAllByRole("listitem")[1]).toHaveAttribute("aria-current", "step");
  expect(screen.getByRole("button", { name: "test action" })).toBeEnabled();
});
