// @vitest-environment jsdom

import { deferred } from "@/test/deferred";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { api } from "@/core/api";
import { initializeI18n } from "@/core/i18n";
import type { RefreshReceipt } from "@/core/types";
import { homeKeys } from "./home-query";
import { scanSettingsActions } from "./scan-settings-actions";

beforeAll(() => initializeI18n("en-US"));
afterEach(() => vi.restoreAllMocks());

const completed = {
  kind: "discovery",
  disposition: "queued",
  request_id: "discovery-1",
  status: { kind: "discovery", state: "succeeded" },
} satisfies RefreshReceipt;

it.each(["removeRoot", "restoreExcluded"] as const)(
  "publishes %s before the discovery finishes and lets the user retry only discovery",
  async (action) => {
    const queryClient = new QueryClient();
    const row = { id: "root", path: "/tmp/excluded" };
    const key = action === "removeRoot" ? homeKeys.scanRoots() : homeKeys.excluded();
    const write = vi
      .spyOn(api, action === "removeRoot" ? "removeScanRoot" : "restoreExcludedWorkspace")
      .mockResolvedValue(undefined);
    const invalidated = deferred<void>();
    vi.spyOn(queryClient, "invalidateQueries").mockImplementationOnce(() => {
      invalidated.resolve();
      return invalidated.promise;
    });
    queryClient.setQueryData(key, [row]);
    const first = deferred<RefreshReceipt>();
    const second = deferred<RefreshReceipt>();
    const refresh = vi
      .spyOn(api, "requestRefresh")
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const success = vi.spyOn(toast, "success").mockReturnValue("success");
    const busy = vi.spyOn(toast, "warning").mockReturnValue("busy");
    const dismiss = vi.spyOn(toast, "dismiss").mockReturnValue("dismiss");

    const value = action === "removeRoot" ? row.id : row.path;
    await scanSettingsActions(queryClient)[action](value);

    expect(write).toHaveBeenCalledExactlyOnceWith(value);
    expect(success).toHaveBeenCalledExactlyOnceWith(
      action === "removeRoot" ? "Directory removed" : "Workspace restored",
    );
    expect(refresh).toHaveBeenCalledExactlyOnceWith("discovery", true);
    expect(busy).not.toHaveBeenCalled();
    await invalidated.promise;
    expect(queryClient.getQueryData(key)).toEqual([]);

    first.reject(new Error("queue-full"));
    await first.promise.catch(() => undefined);
    expect(busy).toHaveBeenCalledExactlyOnceWith(
      "Discovery busy",
      expect.objectContaining({ action: { label: "Retry", onClick: expect.any(Function) } }),
    );

    const retry = busy.mock.calls[0]?.[1]?.action;
    if (!retry || typeof retry !== "object" || !("onClick" in retry))
      throw new Error("Expected a discovery retry action");
    Reflect.apply(retry.onClick, undefined, []);
    second.resolve(completed);
    await second.promise;
    expect(dismiss).toHaveBeenCalledExactlyOnceWith("scan-settings-discovery");
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledOnce();
  },
);
