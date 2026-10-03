// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDialogProvider } from "@/components/AppDialogProvider";
import { api } from "@/core/api";
import { initializeI18n, tr } from "@/core/i18n";
import type { GitIdentitySummary, WorkspaceSummary } from "@/core/types";
import { GlobalSettings, type GlobalSettingsProps } from "./GlobalSettings";

// 隐私页还会渲染其它设置块；未显式配置的 api 方法统一返回 undefined。
vi.mock("@/core/api", () => {
  const calls: Record<string, ReturnType<typeof vi.fn>> = {};
  return {
    api: new Proxy(calls, {
      get: (target, key: string) => (target[key] ??= vi.fn(async () => undefined)),
    }),
  };
});

const noop = async () => undefined;
const props: GlobalSettingsProps = {
  section: "privacy",
  workspaces: [
    { id: "a", name: "A", path: "/a" },
    { id: "b", name: "B", path: "/b" },
  ] as WorkspaceSummary[],
  remoteGateways: [],
  scanRoots: [],
  excluded: [],
  activity: [],
  onAddRoot: noop,
  onRemoveRoot: noop,
  onRestore: noop,
  onCloseBehaviorChanged: noop,
  onLocaleChanged: () => undefined,
  onSessionIndexCleared: () => undefined,
  onOnboardingRestarted: noop,
  onRemoteGatewaysChanged: noop,
  onRefreshDiagnostics: noop,
};
const identity = (id: string, label: string) =>
  ({ id: `${id}-0000000000`, label, source: "alias", enabled: true }) as GitIdentitySummary;

function renderPrivacy() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AppDialogProvider>
        <GlobalSettings {...props} />
      </AppDialogProvider>
    </QueryClientProvider>,
  );
}

describe("GlobalSettings privacy data", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("reloads git identities from the cache after adding an alias", async () => {
    vi.mocked(api.gitIdentities)
      .mockResolvedValueOnce([identity("one", "one@example.com")])
      .mockResolvedValueOnce([
        identity("one", "one@example.com"),
        identity("two", "two@example.com"),
      ]);
    vi.mocked(api.workspaceSessionStatus).mockResolvedValue([]);
    renderPrivacy();
    expect(await screen.findByText("one@example.com")).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: tr("settings.gitAliasPlaceholder") }), {
      target: { value: "two@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: tr("settings.addAlias") }));
    expect(await screen.findByText("two@example.com")).toBeTruthy();
    expect(api.addGitIdentityAlias).toHaveBeenCalledWith("two@example.com");
    expect(api.gitIdentities).toHaveBeenCalledTimes(2);
  });

  it("counts indexed workspaces once per workspace set", async () => {
    vi.mocked(api.gitIdentities).mockResolvedValue([]);
    vi.mocked(api.workspaceSessionStatus).mockImplementation(async (id) =>
      id === "a" ? [{ last_success_at: "2026-09-01T00:00:00Z" } as never] : [],
    );
    renderPrivacy();
    await waitFor(() => expect(api.workspaceSessionStatus).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.workspaceSessionStatus).mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
  });
});
