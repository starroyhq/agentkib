// @vitest-environment jsdom
import { renderHook, waitFor, cleanup, act } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import { useSessionViewStore } from "./session-view-store";
import { useHistoryContinuation } from "./useHistoryContinuation";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("./useSessionSourceCapability", () => ({
  useSessionSourceCapability: () => ({ status: "supported" }),
}));
beforeAll(() => initializeI18n("en-US"));
afterEach(cleanup);

it("opens the existing cross-Agent continuation flow using the indexed history identity", async () => {
  const { result } = renderHook(() =>
    useHistoryContinuation(
      {
        id: "live-session",
        indexedSessionIds: ["indexed-history"],
        availability: "readable",
      } as ConversationSessionSummary,
      { id: "workspace" } as WorkspaceSummary,
    ),
  );
  await waitFor(() => expect(result.current.canContinue).toBe(true));
  act(() => result.current.continueSession());
  expect(navigate).not.toHaveBeenCalled();
  expect(useSessionViewStore.getState().historyContinuation).toMatchObject({
    workspace: { id: "workspace" },
    session: { id: "indexed-history" },
  });
});
