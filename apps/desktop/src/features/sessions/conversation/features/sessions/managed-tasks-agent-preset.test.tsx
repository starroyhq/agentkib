// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagedTasks } from "./managed-tasks";

vi.mock("./session-context", () => ({ useSession: () => session }));
vi.mock("./session-navigation", () => ({ useSessionNavigate: () => vi.fn() }));

const presets = [
  { id: "standard", name: null, description: null, isDefault: true, broken: null },
  { id: "ptc", name: null, description: null, isDefault: false, broken: null },
  { id: "broken", name: null, description: null, isDefault: false, broken: "plugin missing" },
];

function makeSession() {
  const request = vi.fn(async (path: string, _body?: unknown) =>
    path === "managed/create"
      ? { sessionId: "created" }
      : {
          available: true,
          workspaces: [{ id: "workspace", name: "Project" }],
          ...(path.includes("agent=deepseek-harness") ? { agentPresets: presets } : { models: [] }),
        },
  );
  return {
    origin: "",
    selected: undefined,
    current: undefined,
    access: {
      status: "approved",
      protocolVersion: 2,
      bootId: "boot",
      experimentalEnabled: true,
      device: { id: "device", manage: true, send: true },
    },
    client: { request, receipt: vi.fn() },
    online: true,
    controlReady: true,
    busy: false,
    locale: "zh-CN",
    refresh: vi.fn(),
  };
}
let session: ReturnType<typeof makeSession>;

beforeEach(() => {
  sessionStorage.clear();
  session = makeSession();
});
afterEach(cleanup);

describe("a new DeepSeek Harness task on the desktop", () => {
  it("starts with the Agent preset chosen beside its workspace", async () => {
    render(<ManagedTasks create />);
    fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
    await screen.findByRole("dialog", { name: "新建任务" });
    fireEvent.change(screen.getByLabelText("执行工具"), {
      target: { value: "deepseek-harness" },
    });
    const select = (await screen.findByLabelText("Agent 预设")) as HTMLSelectElement;
    expect(select.value).toBe("standard");
    expect([...select.options].map((option) => [option.textContent, option.disabled])).toEqual([
      ["标准模式", false],
      ["PTC 模式", false],
      ["broken · 加载失败", true],
    ]);
    fireEvent.change(select, { target: { value: "ptc" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() =>
      expect(session.client.request).toHaveBeenCalledWith(
        "managed/create",
        expect.objectContaining({ agent: "deepseek-harness", agentPreset: "ptc" }),
      ),
    );
  });
});
