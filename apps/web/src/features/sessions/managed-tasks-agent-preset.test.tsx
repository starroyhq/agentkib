import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagedTasks } from "@/features/conversation/features/sessions/managed-tasks";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/features/conversation/features/sessions/session-context", () => ({
  useSession: () => session,
}));

const presets = [
  { id: "standard", name: null, description: null, isDefault: true, broken: null },
  { id: "ptc", name: null, description: null, isDefault: false, broken: null },
  {
    id: "mine",
    name: "My preset",
    description: "Written by the user",
    isDefault: false,
    broken: null,
  },
  { id: "broken", name: null, description: null, isDefault: false, broken: "plugin missing" },
];

function makeSession(locale = "en-US") {
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
    locale,
    refresh: vi.fn(),
  };
}
let session: ReturnType<typeof makeSession>;

beforeEach(() => {
  sessionStorage.clear();
  session = makeSession();
  navigate.mockClear();
});
afterEach(cleanup);

async function openForDsh() {
  render(<ManagedTasks create />);
  fireEvent.click(screen.getByRole("button", { name: "New task" }));
  await screen.findByRole("dialog", { name: "New task" });
  fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "deepseek-harness" } });
  return (await screen.findByLabelText("Agent preset")) as HTMLSelectElement;
}

describe("a new DeepSeek Harness task", () => {
  it("starts with the Agent preset chosen beside its workspace", async () => {
    const select = await openForDsh();
    // DSH's own names for the presets it ships; one it could not load cannot be chosen.
    expect(select.value).toBe("standard");
    expect([...select.options].map((option) => [option.textContent, option.disabled])).toEqual([
      ["Standard mode", false],
      ["PTC mode", false],
      ["My preset", false],
      ["broken · Failed to load", true],
    ]);
    fireEvent.change(select, { target: { value: "ptc" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(session.client.request).toHaveBeenCalledWith(
        "managed/create",
        expect.objectContaining({ agent: "deepseek-harness", agentPreset: "ptc" }),
      ),
    );
  });

  it("leaves the default preset to DSH", async () => {
    await openForDsh();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(session.client.request).toHaveBeenCalledWith("managed/create", expect.anything()),
    );
    const body = session.client.request.mock.calls.find(
      ([path]) => path === "managed/create",
    )![1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("agentPreset");
  });

  it("names DSH's presets in the reader's language", async () => {
    session = makeSession("zh-CN");
    render(<ManagedTasks create />);
    fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
    await screen.findByRole("dialog", { name: "新建任务" });
    fireEvent.change(screen.getByLabelText("执行工具"), { target: { value: "deepseek-harness" } });
    const select = (await screen.findByLabelText("Agent 预设")) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "标准模式",
      "PTC 模式",
      "My preset",
      "broken · 加载失败",
    ]);
  });
});
