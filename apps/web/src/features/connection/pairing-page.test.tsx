import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import type { Access } from "@agentkib/web-client";
import { dictionaries, type Locale } from "@/features/conversation/i18n";
import { PairingPage } from "./pairing-page";
import { codePairingCopy } from "./code-pairing-copy";
import { pairingErrorCopy, pairingErrorText } from "./pairing-error-copy";

let locale: Locale = "zh-CN";
let pairingMode: Access["pairingMode"];
let connectionType = "same-origin";
let pairingError: string | undefined;
let busy = false;
let accessStatus: Access["status"] = "unpaired";
const refresh = vi.fn();
const pair = vi.fn();
const post = vi.fn();
vi.mock("@/features/conversation/features/sessions/session-context", () => ({
  useSession: () => ({
    t: dictionaries[locale],
    locale,
    access: {
      status: accessStatus,
      pairingMode,
      pending:
        accessStatus === "pending"
          ? { id: "pending", verification: "123456", expiresAt: "2026-10-22T00:00:00Z" }
          : undefined,
    },
    connection: { type: connectionType },
    code: "12345678",
    name: "Test browser",
    setCode: vi.fn(),
    setName: vi.fn(),
    pair,
    post,
    busy,
    pairingError,
    refresh,
  }),
}));
afterEach(cleanup);
beforeEach(() => {
  pairingError = undefined;
  busy = false;
  accessStatus = "unpaired";
  refresh.mockReset();
  pair.mockReset();
  post.mockReset();
});

it.each([
  ["zh-CN", "电脑上的 AgentKib"],
  ["zh-TW", "電腦上的 AgentKib"],
  ["en-US", "AgentKib on your computer"],
  ["ja-JP", "コンピューター上の AgentKib"],
] as const)(
  "identifies the computer application throughout confirmation pairing in %s",
  (value, app) => {
    locale = value;
    connectionType = "same-origin";
    pairingMode = "confirmation";
    const view = render(<PairingPage />);
    for (const key of ["connect", "pairTitle", "pairInfo", "scope", "pending"] as const) {
      for (const node of screen.getAllByText(dictionaries[value][key])) {
        expect(node, key).toHaveTextContent(app);
      }
    }
    expect(screen.getByText(dictionaries[value].pairInfo).textContent).not.toMatch(
      /八位|8\s*(?:位|桁)|8-digit/i,
    );
    expect(view.container.textContent).not.toMatch(/桌面|デスクトップ|\bdesktop\b/i);
    accessStatus = "pending";
    view.rerender(<PairingPage />);
    for (const key of ["connect", "pending", "verify", "scope"] as const) {
      for (const node of screen.getAllByText(dictionaries[value][key])) {
        expect(node, key).toHaveTextContent(app);
      }
    }
    expect(screen.getByText("123456")).toBeVisible();
    expect(view.container.textContent).not.toMatch(/桌面|デスクトップ|\bdesktop\b/i);
    expect(pair).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  },
);

it.each(Object.keys(codePairingCopy) as Locale[])(
  "shows direct full access and removes the confirmation step in %s",
  (value) => {
    locale = value;
    connectionType = "same-origin";
    pairingMode = "code";
    render(<PairingPage />);
    expect(screen.getByRole("heading", { name: codePairingCopy[value].title })).toBeVisible();
    expect(screen.getByText(codePairingCopy[value].info)).toBeVisible();
    expect(screen.getByText(codePairingCopy[value].info).textContent).not.toMatch(
      /八位|8\s*(?:位|桁)|8-digit|一次性|one-time|使い捨て/i,
    );
    expect(screen.getByText(codePairingCopy[value].scope)).toBeVisible();
    expect(screen.getByText(codePairingCopy[value].safety)).toBeVisible();
    const code = screen.getByLabelText(codePairingCopy[value].code);
    expect(code).toBeVisible();
    expect(code).toHaveAttribute("pattern", "[0-9]{8}");
    expect(code).toHaveAttribute("minlength", "8");
    expect(code).toHaveAttribute("maxlength", "8");
    expect(code).toHaveAttribute("autocomplete", "one-time-code");
    expect(screen.queryByText(dictionaries[value].pending)).not.toBeInTheDocument();
  },
);

it.each(["legacy", "lan", "confirmation"])("keeps the %s pairing boundary", (mode) => {
  locale = "zh-CN";
  connectionType = mode === "lan" ? "lan-http" : "same-origin";
  pairingMode = mode === "legacy" ? undefined : mode === "lan" ? "code" : "confirmation";
  render(<PairingPage />);
  expect(screen.getByText(dictionaries[locale].pending)).toBeVisible();
  expect(screen.queryByText(codePairingCopy[locale].scope)).not.toBeInTheDocument();
});

it.each(Object.keys(pairingErrorCopy) as Locale[])(
  "shows actionable pairing errors and a reconnect action in %s",
  (value) => {
    locale = value;
    pairingMode = "code";
    connectionType = "same-origin";
    pairingError = "invalid_pairing_code";
    render(<PairingPage />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      pairingErrorText(value, "invalid_pairing_code", "access"),
    );
    expect(screen.getByLabelText(codePairingCopy[value].code)).toHaveValue("12345678");
    expect(screen.getByLabelText(codePairingCopy[value].code)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: dictionaries[value].retry }));
    expect(refresh).toHaveBeenCalledWith(true);
  },
);

it.each(Object.keys(pairingErrorCopy) as Locale[])(
  "provides a localized fallback in %s",
  (value) => {
    const copy = pairingErrorCopy[value];
    for (const code of Object.keys(copy) as (keyof typeof copy)[]) {
      if (code !== "requesting") expect(pairingErrorText(value, code)).toBe(copy[code]);
    }
    expect(pairingErrorText(value, "server stack or unknown error")).toBe(
      pairingErrorCopy[value].request_failed,
    );
    expect(pairingErrorText(value, "toString")).toBe(pairingErrorCopy[value].request_failed);
  },
);

it("disables both fields and shows progress while the pairing request is pending", () => {
  locale = "zh-CN";
  pairingMode = "code";
  connectionType = "same-origin";
  busy = true;
  render(<PairingPage />);

  expect(screen.getByLabelText(codePairingCopy[locale].code)).toBeDisabled();
  expect(screen.getByLabelText(dictionaries[locale].name)).toBeDisabled();
  expect(screen.getByRole("button", { name: pairingErrorCopy[locale].requesting })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: pairingErrorCopy[locale].requesting }).closest("form"),
  ).toHaveAttribute("aria-busy", "true");
});

it.each(Object.keys(pairingErrorCopy) as Locale[])(
  "keeps pairing code terminology in confirmation mode in %s",
  (value) => {
    locale = value;
    pairingMode = "confirmation";
    connectionType = "same-origin";
    pairingError = "invalid_pairing_code";
    render(<PairingPage />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      pairingErrorCopy[value].invalid_pairing_code,
    );
    expect(pairingErrorText(value, "invalid_pairing_code", "access")).not.toBe(
      pairingErrorCopy[value].invalid_pairing_code,
    );
  },
);
