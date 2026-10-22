import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApplication, makeRouter } from "@/router";
import { hostedCopy } from "./hosted-home";
import { codePairingCopy } from "./code-pairing-copy";
import { connectionCopy } from "./connection-copy";
import { dictionaries, type Locale } from "@/features/conversation/i18n";

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

describe("hosted remote entry", () => {
  it.each([
    ["zh-CN", "局域网直连", "电脑上的 AgentKib", "设置 → 远程连接 → 手机", "授权码", "远程控制"],
    ["zh-TW", "區域網路直連", "電腦上的 AgentKib", "設定 → 遠端連線 → 手機", "授權碼", "遠端控制"],
    [
      "en-US",
      "LAN direct connection",
      "AgentKib on your computer",
      "Settings → Remote connections → Phones",
      "access code",
      "remote control",
    ],
    [
      "ja-JP",
      "LAN 直接接続",
      "コンピューター上の AgentKib",
      "設定 → リモート接続 → スマートフォン",
      "認証コード",
      "リモート操作",
    ],
  ] as const)(
    "names the current remote settings and access code in %s",
    async (locale, setting, app, path, code, control) => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      render(<WebApplication hosted initialLocale={locale} />);
      const note = await screen.findByText(hostedCopy[locale].lanNote);
      expect(note).toHaveTextContent(setting);
      expect(note).toHaveTextContent(app);
      const steps = screen.getAllByRole("listitem");
      expect(steps).toHaveLength(3);
      for (const step of steps) {
        expect(step).toHaveTextContent(app);
      }
      expect(steps[0]).toHaveTextContent(path);
      expect(steps[2]).toHaveTextContent(code);
      expect(steps[2]).toHaveTextContent(control);
      expect(screen.getByText(hostedCopy[locale].accountNote)).toHaveTextContent(app);
      expect(screen.getByText(hostedCopy[locale].accountNote)).toHaveTextContent(code);
      expect(document.body.textContent).not.toMatch(
        /主机|主機|远控|遠控|公网访问|公網存取|公網訪問|八位|一次性|桌面|デスクトップ|\bdesktop\b|eight-character|8\s*(?:位|桁)|8-digit|one-time|使い捨て/i,
      );
      expect(screen.getByRole("link", { name: hostedCopy[locale].lan })).toHaveAttribute(
        "href",
        "/connect",
      );
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each(Object.keys(hostedCopy) as Locale[])(
    "keeps connection copy keys and interpolation tokens aligned in %s",
    (locale) => {
      const copyGroups: Record<Locale, Record<string, string | string[]>>[] = [
        hostedCopy,
        connectionCopy,
        codePairingCopy,
        dictionaries,
      ];
      for (const copies of copyGroups) {
        const reference = copies["zh-CN"];
        const localized = copies[locale];
        expect(Object.keys(localized).sort()).toEqual(Object.keys(reference).sort());
        for (const [key, value] of Object.entries(localized)) {
          const source = reference[key];
          const entries = Array.isArray(value) ? value : [value];
          const sourceEntries = Array.isArray(source) ? source : [source];
          expect(entries, key).toHaveLength(sourceEntries.length);
          entries.forEach((entry, index) => {
            expect(entry.trim(), key).not.toBe("");
            expect(entry.match(/\{\{?[^{}]+\}?\}/g) ?? [], key).toEqual(
              sourceEntries[index].match(/\{\{?[^{}]+\}?\}/g) ?? [],
            );
          });
        }
      }
    },
  );

  it.each(Object.keys(hostedCopy) as Locale[])(
    "shows guidance without accessing a computer in %s",
    async (locale) => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      render(<WebApplication hosted initialLocale={locale} />);
      expect(await screen.findByRole("heading", { name: hostedCopy[locale].title })).toBeVisible();
      expect(screen.getByRole("link", { name: hostedCopy[locale].lan })).toHaveAttribute(
        "href",
        "/connect",
      );
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: hostedCopy[locale].account })).toHaveAttribute(
        "href",
        "https://account.agentkib.com/",
      );
      expect(screen.getByRole("link", { name: hostedCopy[locale].account })).toHaveAttribute(
        "referrerpolicy",
        "no-referrer",
      );
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("opens the explicit LAN flow and retains homepage language preferences", async () => {
    render(<WebApplication hosted />);
    fireEvent.change(await screen.findByLabelText("语言"), { target: { value: "en-US" } });
    fireEvent.click(screen.getByRole("link", { name: "Local network connection" }));
    expect(await screen.findByRole("heading", { name: "Local network connection" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Connect to AgentKib on your computer" }),
    ).toBeDisabled();
  });

  it("accepts an old QR address only after validating private LAN HTTP", async () => {
    history.replaceState(null, "", "/#connect=http%3A%2F%2F192.168.1.10%3A1422");
    render(<WebApplication hosted />);
    expect(await screen.findByLabelText("电脑的局域网地址")).toHaveValue(
      "http://192.168.1.10:1422",
    );
    expect(screen.getByRole("button", { name: "连接电脑上的 AgentKib" })).toBeDisabled();
    expect(location.hash).toBe("#/connect");
  });

  it.each(["https://public.example", "http://192.168.1.10:1422/path", "javascript:alert(1)"])(
    "does not prefill or connect to invalid old QR address %s",
    async (address) => {
      history.replaceState(null, "", `/#connect=${encodeURIComponent(address)}`);
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      render(<WebApplication hosted />);
      expect(await screen.findByRole("heading", { name: "连接你的电脑", level: 1 })).toBeVisible();
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("consumes old QR fragments in an already loaded page and resets LAN consent", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(<WebApplication hosted />);
    await screen.findByRole("heading", { name: "连接你的电脑", level: 1 });
    history.replaceState(null, "", "/#connect=http%3A%2F%2F192.168.1.10%3A1422");
    fireEvent(window, new HashChangeEvent("hashchange"));
    expect(await screen.findByLabelText("电脑的局域网地址")).toHaveValue(
      "http://192.168.1.10:1422",
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "连接电脑上的 AgentKib" })).toBeEnabled();
    history.replaceState(null, "", "/#connect=http%3A%2F%2F192.168.1.11%3A1422");
    fireEvent(window, new HashChangeEvent("hashchange"));
    await waitFor(() =>
      expect(screen.getByLabelText("电脑的局域网地址")).toHaveValue("http://192.168.1.11:1422"),
    );
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "连接电脑上的 AgentKib" })).toBeDisabled();
    expect(location.hash).toBe("#/connect");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns an already loaded page to guidance for an invalid legacy fragment", async () => {
    render(<WebApplication hosted />);
    fireEvent.click(await screen.findByRole("link", { name: "局域网连接" }));
    await screen.findByLabelText("电脑的局域网地址");
    history.replaceState(null, "", "/#connect=https%3A%2F%2Fpublic.example");
    fireEvent(window, new HashChangeEvent("hashchange"));
    expect(await screen.findByRole("heading", { name: "连接你的电脑", level: 1 })).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(location.hash).toBe("#/");
  });

  it("keeps the existing hash route and does not consume LAN QR links on same-origin hosts", () => {
    history.replaceState(null, "", "/#/sessions/old-session");
    const router = makeRouter({ hosted: true });
    expect(router.history.location.pathname).toBe("/sessions/old-session");
    history.replaceState(null, "", "/#connect=http%3A%2F%2F192.168.1.10%3A1422");
    makeRouter({}, true);
    expect(location.hash).toContain("connect=");
  });

  it("opens the computer's same-origin pairing screen without hosted guidance", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        status: "unpaired",
        csrfToken: "csrf",
        bootId: "boot",
        experimentalEnabled: false,
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    render(<WebApplication connection={{ type: "same-origin" }} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(screen.queryByText(hostedCopy["zh-CN"].intro)).not.toBeInTheDocument();
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/web/v1/access");
  });
});
