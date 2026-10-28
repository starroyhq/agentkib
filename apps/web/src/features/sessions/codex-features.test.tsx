import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexCapabilities, UploadedAttachment } from "@agentkib/web-client";
import { CodexTools } from "@/features/conversation/features/sessions/codex-tools";
import { CodexComposer } from "@/features/conversation/features/sessions/codex-composer";
import { NativeDecisions } from "@/features/conversation/features/interactions/native-decisions";
import { useSession } from "@/features/conversation/features/sessions/session-context";
import { dictionaries } from "@/features/conversation/i18n";
import { codexCopyForSurface } from "@/features/conversation/features/sessions/codex-copy";
import { webLayoutCopy } from "@/features/conversation/features/sessions/web-layout-copy";
import { publishSessionInvalidation } from "@/features/conversation/features/sessions/session-events";
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/features/conversation/features/sessions/session-context", () => ({
  useSession: vi.fn(),
}));
const sessionMock = vi.mocked(useSession);
let state: ReturnType<typeof useSession>;
const uploaded: UploadedAttachment = {
  id: "opaque-id",
  name: "image.png",
  mime: "image/png",
  size: 3,
  version: "v1",
};
beforeEach(() => {
  const request = vi.fn().mockResolvedValue({});
  state = {
    selected: "s",
    access: {
      status: "approved",
      protocolVersion: 2,
      device: { attachments: true, advancedControl: true },
    },
    live: { status: "idle" },
    client: {
      uploadAttachment: vi.fn().mockResolvedValue(uploaded),
      request,
      codexSessionSettings: vi.fn((sessionId: string) =>
        request(`codex/session-settings?sessionId=${sessionId}`),
      ),
      codexGoals: vi.fn((sessionId: string) => request(`codex/goals?sessionId=${sessionId}`)),
      codexContextOptions: vi.fn((sessionId: string) =>
        request(`codex/context-options?sessionId=${sessionId}`),
      ),
    },
    locale: "zh-CN",
    t: dictionaries["zh-CN"],
    message: "",
    setMessage: vi.fn(),
    control: vi.fn().mockResolvedValue(true),
    codexAction: vi.fn().mockResolvedValue({ accepted: true }),
    capabilities: {
      sessionId: "s",
      features: {
        attachments: { available: true },
        steer: { available: true },
        "queue-add": { available: true },
      },
    } as CodexCapabilities,
    canSend: true,
    canStop: false,
    busy: false,
    online: true,
    controlReady: true,
  } as unknown as ReturnType<typeof useSession>;
  sessionMock.mockImplementation(() => state);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe("Codex composer", () => {
  it("blocks send and steer during compaction while keeping explicit queueing and native stop available", () => {
    state.message = "next";
    state.live = {
      ...state.live!,
      sessionId: "s",
      status: "running",
      turnId: "turn",
      activity: "compacting",
    };
    state.canSend = false;
    state.canStop = true;
    render(<CodexComposer />);
    expect(screen.getByRole("button", { name: "追加到当前轮次" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "加入队列（将自动执行）" })).toBeEnabled();
    expect(screen.getByRole("button", { name: state.t.stop })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "加入队列（将自动执行）" }));
    expect(state.codexAction).toHaveBeenCalledWith("queue-add", { text: "next" });
  });
  it("refreshes settings and goals from native invalidation without scanning resources", async () => {
    state.access!.device!.accessMode = "full";
    vi.mocked(state.client.request).mockResolvedValue({
      sessionId: "s",
      available: false,
      revision: 1,
      resources: [],
      current: {},
      defaults: {},
      options: {},
      writable: {},
    });
    render(<CodexComposer />);
    await waitFor(() => expect(state.client.codexSessionSettings).toHaveBeenCalledOnce());
    act(() => {
      publishSessionInvalidation(state.client, "s", ["settings", "goal"]);
    });
    await waitFor(() => expect(state.client.codexSessionSettings).toHaveBeenCalledTimes(2));
    expect(state.client.codexGoals).toHaveBeenCalledTimes(2);
    expect(state.client.codexContextOptions).toHaveBeenCalledOnce();
  });
  it("stages an attachment and sends only opaque IDs, allowing an attachment-only turn", async () => {
    render(<CodexComposer />);
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("添加附件", { selector: "input" }), {
      target: { files: [new File(["abc"], "image.png", { type: "image/png" })] },
    });
    await screen.findByText("100%");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(state.control).toHaveBeenCalledWith(
        "send",
        undefined,
        undefined,
        undefined,
        undefined,
        { attachmentIds: ["opaque-id"] },
      ),
    );
    expect(JSON.stringify(vi.mocked(state.control).mock.calls)).not.toContain("image.png");
    await waitFor(() => expect(screen.queryByText("image.png")).not.toBeInTheDocument());
  });
  it.each([
    ["queue-add", "加入队列（将自动执行）"],
    ["steer", "追加到当前轮次"],
  ])("sends text-only %s only during a running turn", (action, label) => {
    state.message = "next";
    const view = render(<CodexComposer />);
    expect(screen.queryByRole("button", { name: /加入队列/ })).not.toBeInTheDocument();
    state = {
      ...state,
      live: { ...state.live!, status: "running", turnId: "turn" },
      canSend: false,
      canStop: true,
    };
    view.rerender(<CodexComposer />);
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(state.codexAction).toHaveBeenCalledWith(action, {
      text: "next",
      ...(action === "steer" ? { turnId: "turn" } : {}),
    });
  });
  it("blocks submission while uploading and aborts transfers on unmount", async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(state.client.uploadAttachment).mockImplementation(
      (_id, _file, progress, nextSignal) => {
        signal = nextSignal;
        progress(50);
        return new Promise(() => {});
      },
    );
    const view = render(<CodexComposer />);
    fireEvent.change(screen.getByLabelText("添加附件", { selector: "input" }), {
      target: { files: [new File(["abc"], "image.png")] },
    });
    expect(await screen.findByText("上传中 50%")).toBeVisible();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });
  it("rejects pasted files when the host has not verified attachment support", () => {
    state = { ...state, capabilities: undefined };
    render(<CodexComposer />);
    fireEvent.paste(screen.getByLabelText("发送消息"), {
      clipboardData: { files: [new File(["x"], "file.txt")] },
    });
    expect(state.client.uploadAttachment).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "添加附件" })).toBeDisabled();
  });

  it("shows host-confirmed settings and context usage only to a full-access browser", async () => {
    state = {
      ...state,
      access: {
        ...state.access!,
        device: { ...state.access!.device!, accessMode: "full" },
      },
      live: { ...state.live!, revision: 4 },
      capabilities: {
        ...state.capabilities!,
        features: {
          ...state.capabilities!.features,
          settings: { available: true },
          context: { available: true },
        },
      } as CodexCapabilities,
    };
    vi.mocked(state.client.request).mockImplementation(async (path: string) => {
      if (path.startsWith("codex/session-settings?"))
        return {
          sessionId: "s",
          available: true,
          revision: 4,
          executionMode: "codex-managed",
          status: "idle",
          current: {
            modelId: "gpt-6-sol",
            effort: "high",
            mode: "default",
            policyId: "workspace",
            serviceTierId: "fast",
          },
          defaults: { modelId: "gpt-6-sol", effort: "medium", serviceTierId: "standard" },
          writable: {
            model: { available: true },
            effort: { available: true },
            mode: { available: true },
            policy: { available: true },
            serviceTier: { available: true },
            restoreDefaults: { available: true },
          },
          options: {
            models: [
              {
                id: "gpt-6-sol",
                name: "GPT-6 Sol",
                efforts: ["medium", "high"],
                serviceTierIds: ["standard", "fast"],
              },
            ],
            policies: [{ id: "workspace", name: "工作区写入" }],
            serviceTiers: [
              { id: "standard", name: "标准" },
              { id: "fast", name: "加速", description: "由主机提供" },
            ],
          },
          usage: { available: true, usedTokens: 50, contextWindow: 100 },
        };
      if (path.startsWith("codex/goals?"))
        return { sessionId: "s", revision: 4, available: false, actions: {} };
      if (path.startsWith("codex/context-options?"))
        return { sessionId: "s", revision: 4, resources: [] };
      return {};
    });
    render(<CodexComposer />);
    expect(await screen.findByRole("button", { name: /GPT-6 Sol/ })).toBeVisible();
    expect(screen.getByTitle("上下文用量: 最近原生报告: 50 / 100")).toHaveTextContent("50%");
    fireEvent.click(screen.getByRole("button", { name: /GPT-6 Sol/ }));
    expect(screen.getByLabelText("思考强度")).toHaveValue("high");
    expect(screen.getByDisplayValue("加速")).toHaveValue("fast");
    fireEvent.click(screen.getByRole("button", { name: "恢复运行 AgentKib 的电脑默认" }));
    await waitFor(() =>
      expect(state.codexAction).toHaveBeenCalledWith("settings", { restoreDefaults: true }),
    );
  });

  it("sends opaque host resource IDs and never exposes the control to a legacy credential", async () => {
    const fullAccess = {
      ...state.access!,
      device: { ...state.access!.device!, accessMode: "full" as const },
    };
    state = {
      ...state,
      access: fullAccess,
      capabilities: {
        ...state.capabilities!,
        features: {
          ...state.capabilities!.features,
          context: { available: true },
        },
      } as CodexCapabilities,
    };
    vi.mocked(state.client.request).mockImplementation(async (path: string) => {
      if (path.startsWith("codex/session-settings?")) throw new Error("unavailable");
      if (path.startsWith("codex/goals?")) throw new Error("unavailable");
      if (path.startsWith("codex/context-options?"))
        return {
          sessionId: "s",
          available: true,
          revision: 1,
          resources: [
            {
              id: "opaque-resource-id",
              kind: "file",
              name: "notes.md",
              available: true,
            },
          ],
        };
      return {};
    });
    const view = render(<CodexComposer />);
    fireEvent.click(await screen.findByRole("button", { name: "添加上下文" }));
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.getByText("引用文件或技能后，请输入消息或添加附件再发送。")).toBeVisible();
    expect(state.control).not.toHaveBeenCalled();
    state = { ...state, message: "Use these references" };
    view.rerender(<CodexComposer />);
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(state.control).toHaveBeenCalledWith(
        "send",
        undefined,
        undefined,
        undefined,
        undefined,
        { attachmentIds: [], resourceIds: ["opaque-resource-id"] },
      ),
    );
    expect(JSON.stringify(vi.mocked(state.control).mock.calls)).not.toContain("notes.md");

    state = {
      ...state,
      access: { ...fullAccess, device: { ...fullAccess.device!, accessMode: undefined } },
    };
    view.rerender(<CodexComposer />);
    expect(screen.queryByRole("button", { name: "添加上下文" })).not.toBeInTheDocument();
  });

  it("disables setting changes while a native turn is running", async () => {
    state = {
      ...state,
      access: { ...state.access!, device: { ...state.access!.device!, accessMode: "full" } },
      live: { ...state.live!, status: "running", revision: 2 },
      capabilities: {
        ...state.capabilities!,
        features: { ...state.capabilities!.features, settings: { available: true } },
      } as CodexCapabilities,
    };
    vi.mocked(state.client.request).mockImplementation(async (path: string) => {
      if (path.startsWith("codex/session-settings?"))
        return {
          sessionId: "s",
          available: true,
          revision: 2,
          executionMode: "codex-managed",
          status: "running",
          current: { modelId: "model" },
          defaults: {},
          writable: {
            model: { available: true },
            restoreDefaults: { available: true },
          },
          options: { models: [{ id: "model", name: "Model" }] },
        };
      if (path.startsWith("codex/goals?"))
        return { sessionId: "s", revision: 2, available: false, actions: {} };
      return { sessionId: "s", revision: 2, resources: [] };
    });
    render(<CodexComposer />);
    fireEvent.click(await screen.findByRole("button", { name: /Model/ }));
    expect(screen.getByLabelText("模型")).toBeDisabled();
    expect(screen.getByRole("button", { name: "恢复运行 AgentKib 的电脑默认" })).toBeDisabled();
    expect(screen.getByText("当前轮次结束后才能修改设置")).toBeVisible();
  });

  it("uses the durable Codex action path for goal changes", async () => {
    state = {
      ...state,
      access: { ...state.access!, device: { ...state.access!.device!, accessMode: "full" } },
      live: { ...state.live!, revision: 8 },
      capabilities: {
        ...state.capabilities!,
        features: {
          ...state.capabilities!.features,
          "goal-set": { available: true },
          "goal-pause": { available: true },
          "goal-clear": { available: true },
        },
      } as CodexCapabilities,
    };
    vi.mocked(state.client.request).mockImplementation(async (path: string) => {
      if (path.startsWith("codex/goals?"))
        return {
          sessionId: "s",
          revision: 8,
          available: true,
          goal: { objective: "finish QA", status: "active", tokensUsed: 12, elapsedMs: 2000 },
          actions: {
            set: { available: true },
            pause: { available: true },
            resume: { available: false },
            clear: { available: true },
          },
        };
      if (path.startsWith("codex/context-options?"))
        return { sessionId: "s", revision: 8, resources: [] };
      throw new Error("settings unavailable");
    });
    render(<CodexComposer />);
    fireEvent.click(await screen.findByRole("button", { name: "持续目标" }));
    expect(screen.getByDisplayValue("finish QA")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(state.codexAction).toHaveBeenCalledWith("goal-pause", {}));
  });
});
it("requires explicit confirmation for native session/persistent approval scope and submits the exact candidate", () => {
  const submit = vi.fn();
  const decision = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] } };
  render(
    <NativeDecisions
      approval={{
        requestId: 1,
        turnId: "t",
        method: "command",
        supported: true,
        availableDecisions: [],
        decisionOptions: [
          { id: "persist", label: "acceptWithExecpolicyAmendment", decision, scope: "persistent" },
        ],
      }}
      locale="en-US"
      enabled
      busy={false}
      submit={submit}
    />,
  );
  const button = screen.getByRole("button", { name: "Save command rule and allow" });
  expect(button).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(button);
  expect(submit).toHaveBeenCalledExactlyOnceWith(decision);
});

it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
  "keeps Codex operations focused on session management and automatic queues in %s",
  async (locale) => {
    state = {
      ...state,
      locale,
      current: {
        id: "s",
        agent: "codex",
        title: "Codex",
        workspace_id: "w",
        archived: false,
        sidechain: false,
        availability: "readable",
      },
      access: { ...state.access!, experimentalEnabled: true },
      capabilities: {
        sessionId: "s",
        executionMode: "codex-managed",
        status: "idle",
        features: { resume: { available: true }, "queue-start": { available: true } },
      },
      client: Object.assign(state.client, {
        codexQueue: vi.fn().mockResolvedValue({ data: [{ id: "queued", text: "Pending turn" }] }),
        request: vi.fn().mockResolvedValue({ available: true, workspaces: [] }),
      }),
      refresh: vi.fn(),
    };
    const view = render(<CodexTools open ownership={<span>Legacy ownership controls</span>} />);
    await screen.findByText("Pending turn");
    const copy = codexCopyForSurface(locale, "web");
    const obsoleteResume = {
      "zh-CN": "恢复执行",
      "zh-TW": "恢復執行",
      "en-US": "Resume execution",
      "ja-JP": "実行を再開",
    }[locale];
    expect(screen.getByRole("heading", { name: copy.queue })).toBeVisible();
    expect(screen.queryByRole("button", { name: copy.queueStart })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: obsoleteResume })).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        /我已处理待审批事项|我已處理待審批事項|I have handled pending|保留中のリクエストとバックグラウンド/,
      ),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText("Legacy ownership controls")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(webLayoutCopy[locale].diagnostics));
    expect(screen.queryByText(/codex-managed/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.inspect })).toBeInTheDocument();
    state = {
      ...state,
      capabilities: {
        ...state.capabilities!,
        features: { resume: { available: false }, "queue-start": { available: false } },
      },
    };
    view.rerender(<CodexTools open />);
    expect(
      screen.queryByText(new RegExp(`${obsoleteResume}|${copy.queueStart}`)),
    ).not.toBeInTheDocument();
  },
);

describe("Session delete", () => {
  const copy = codexCopyForSurface("zh-CN", "web");
  function prepare(features: Record<string, { available: boolean; reason?: string }>) {
    state = {
      ...state,
      current: {
        id: "s",
        agent: "codex",
        title: "Codex",
        workspace_id: "w",
        archived: false,
        sidechain: false,
        availability: "readable",
      },
      access: { ...state.access!, experimentalEnabled: true },
      capabilities: { sessionId: "s", executionMode: "codex-managed", status: "idle", features },
      client: Object.assign(state.client, {
        codexQueue: vi.fn().mockResolvedValue({ data: [] }),
        request: vi.fn().mockResolvedValue({ available: true, workspaces: [] }),
      }),
      refresh: vi.fn(),
    } as ReturnType<typeof useSession>;
  }
  it("asks before deleting permanently, and deletes only once confirmed", async () => {
    prepare({ delete: { available: true } });
    render(<CodexTools open />);
    fireEvent.click(screen.getByRole("button", { name: copy.delete }));
    expect(state.codexAction).not.toHaveBeenCalled();
    const confirm = screen.getByRole("group", { name: copy.deleteTitle });
    expect(confirm).toHaveAccessibleDescription(copy.deleteCodexDetail);
    fireEvent.click(screen.getByRole("button", { name: copy.cancel }));
    expect(screen.queryByRole("group", { name: copy.deleteTitle })).not.toBeInTheDocument();
    expect(state.codexAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: copy.delete }));
    fireEvent.click(screen.getByRole("button", { name: copy.deleteConfirm }));
    await waitFor(() => expect(state.codexAction).toHaveBeenCalledExactlyOnceWith("delete", {}));
  });
  it("says another Codex process has to quit first", () => {
    prepare({ delete: { available: false, reason: "codex-owner-busy" } });
    render(<CodexTools open />);
    expect(screen.getByRole("button", { name: copy.delete })).toBeDisabled();
    expect(screen.getByText(copy.deleteOwnerBusy)).toBeVisible();
  });
  it("offers no delete where the computer reports none", () => {
    prepare({ rename: { available: true } });
    render(<CodexTools open />);
    expect(screen.queryByRole("button", { name: copy.delete })).not.toBeInTheDocument();
  });
});

it("retains Claude's existing ownership content", () => {
  state = {
    ...state,
    current: {
      id: "s",
      agent: "claude-code",
      title: "Claude",
      workspace_id: "w",
      archived: false,
      sidechain: false,
      availability: "readable",
    },
  };
  render(<CodexTools open ownership={<span>Claude ownership controls</span>} />);
  expect(screen.getByText("Claude ownership controls")).toBeVisible();
});

it("keeps native inspection available while write outcome is unconfirmed", async () => {
  state = {
    ...state,
    current: {
      id: "s",
      agent: "codex",
      title: "Codex",
      workspace_id: "w",
      archived: false,
      sidechain: false,
      availability: "readable",
    },
    access: { ...state.access!, experimentalEnabled: true },
    online: false,
    controlReady: false,
    capabilities: {
      sessionId: "s",
      executionMode: "codex-managed",
      status: "unknown",
      features: { inspect: { available: true }, rename: { available: true } },
    },
    client: Object.assign(state.client, {
      codexQueue: vi.fn().mockResolvedValue({ data: [] }),
      request: vi.fn().mockResolvedValue({ available: true, workspaces: [] }),
    }),
    refresh: vi.fn(),
  };
  render(<CodexTools />);
  fireEvent.click(screen.getByRole("button", { name: "会话操作" }));
  const inspect = screen.getByRole("button", { name: "检查会话状态" });
  expect(inspect).toBeEnabled();
  expect(screen.getByRole("button", { name: "重命名" })).toBeDisabled();
  fireEvent.click(inspect);
  await waitFor(() => expect(state.codexAction).toHaveBeenCalledExactlyOnceWith("inspect", {}));
});

it("does not delete a staged attachment while its send outcome is unknown", async () => {
  vi.mocked(state.control).mockResolvedValue(undefined);
  const view = render(<CodexComposer />);
  fireEvent.change(screen.getByLabelText("添加附件", { selector: "input" }), {
    target: { files: [new File(["abc"], "image.png")] },
  });
  await screen.findByText("100%");
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(state.control).toHaveBeenCalled());
  state = { ...state, notice: "uncertain" };
  view.rerender(<CodexComposer />);
  expect(screen.getByRole("button", { name: "移除附件: image.png" })).toBeDisabled();
  expect(state.client.request).not.toHaveBeenCalled();
  state = { ...state, notice: "accepted" };
  view.rerender(<CodexComposer />);
  await waitFor(() => expect(screen.queryByText("image.png")).not.toBeInTheDocument());
  expect(state.client.request).not.toHaveBeenCalled();
});

it("keeps queued attachment messages read-only while allowing deletion", async () => {
  state = {
    ...state,
    current: {
      id: "s",
      agent: "codex",
      title: "Codex",
      workspace_id: "w",
      archived: false,
      sidechain: false,
      availability: "readable",
    },
    access: { ...state.access!, experimentalEnabled: true },
    capabilities: {
      sessionId: "s",
      executionMode: "codex-managed",
      status: "running",
      features: { "queue-update": { available: true }, "queue-delete": { available: true } },
    },
    client: Object.assign(state.client, {
      codexQueue: vi.fn().mockResolvedValue({
        data: [{ id: "queued", text: "Image description", hasAttachments: true }],
      }),
      request: vi.fn().mockResolvedValue({ available: true, workspaces: [] }),
    }),
    refresh: vi.fn(),
  };
  render(<CodexTools />);
  fireEvent.click(screen.getByRole("button", { name: "会话操作" }));
  await screen.findByText("Image description");
  expect(screen.getByRole("button", { name: "修改" })).toBeDisabled();
  expect(screen.getByText("含附件的待发消息暂不支持编辑正文，可删除后重新添加。")).toBeVisible();
  expect(screen.getByRole("button", { name: "移除" })).toBeEnabled();
});

it("drains a queue invalidation received while an older queue read is pending", async () => {
  let finish!: (value: { sessionId: string; data: { id: string; text: string }[] }) => void;
  const codexQueue = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({ sessionId: "s", data: [{ id: "new", text: "Current queue" }] });
  state = {
    ...state,
    current: {
      id: "s",
      agent: "codex",
      title: "Codex",
      workspace_id: "w",
      archived: false,
      sidechain: false,
      availability: "readable",
    },
    access: { ...state.access!, experimentalEnabled: true },
    client: Object.assign(state.client, { codexQueue }),
    refresh: vi.fn(),
  };
  render(<CodexTools open />);
  expect(codexQueue).toHaveBeenCalledOnce();
  await act(async () => {
    publishSessionInvalidation(state.client, "s", ["queue"]);
    finish({ sessionId: "s", data: [{ id: "old", text: "Outdated queue" }] });
  });
  expect(await screen.findByText("Current queue")).toBeVisible();
  expect(screen.queryByText("Outdated queue")).not.toBeInTheDocument();
  expect(codexQueue).toHaveBeenCalledTimes(2);
});

it.each(["queue-first", "title-first"])(
  "retains the manageable queue when another client renames the session (%s)",
  async (order) => {
    const queue = { sessionId: "s", data: [{ id: "queued", text: "Pending message" }] };
    let finish!: (value: typeof queue) => void;
    const codexQueue = vi
      .fn()
      .mockResolvedValueOnce(queue)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(queue);
    state = {
      ...state,
      current: {
        id: "s",
        agent: "codex",
        title: "Original conversation",
        workspace_id: "w",
        archived: false,
        sidechain: false,
        availability: "readable",
      },
      access: { ...state.access!, experimentalEnabled: true },
      capabilities: {
        sessionId: "s",
        executionMode: "codex-managed",
        status: "idle",
        features: { "queue-update": { available: true }, "queue-delete": { available: true } },
      },
      client: Object.assign(state.client, { codexQueue }),
      refresh: vi.fn(),
    };
    const view = render(<CodexTools open />);
    await screen.findByText("Pending message");
    // The remote rename invalidates both reads, which can finish in either order.
    act(() => publishSessionInvalidation(state.client, "s", ["queue", "catalog"]));
    const rename = () => {
      state = { ...state, current: { ...state.current!, title: "Renamed conversation" } };
      view.rerender(<CodexTools open />);
    };
    if (order === "title-first") rename();
    await act(async () =>
      finish({ ...queue, data: [{ id: "queued", text: "Updated pending message" }] }),
    );
    if (order === "queue-first") rename();

    expect(screen.getByDisplayValue("Renamed conversation")).toBeVisible();
    expect(screen.getByText("Updated pending message")).toBeVisible();
    expect(screen.getByRole("button", { name: "修改" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "移除" })).toBeEnabled();
    expect(codexQueue).toHaveBeenCalledTimes(2);
    expect(state.client.request).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    await waitFor(() =>
      expect(state.codexAction).toHaveBeenCalledExactlyOnceWith("queue-delete", {
        queuedSubmissionId: "queued",
      }),
    );
  },
);

it("clears the previous queue on session change and ignores its pending response", async () => {
  const oldQueue = { sessionId: "s", data: [{ id: "old", text: "Previous session message" }] };
  let finishOld!: (value: typeof oldQueue) => void;
  let finishNew!: (value: typeof oldQueue) => void;
  const codexQueue = vi
    .fn()
    .mockResolvedValueOnce(oldQueue)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishNew = resolve;
        }),
    );
  state = {
    ...state,
    current: {
      id: "s",
      agent: "codex",
      title: "Original conversation",
      workspace_id: "w",
      archived: false,
      sidechain: false,
      availability: "readable",
    },
    access: { ...state.access!, experimentalEnabled: true },
    client: Object.assign(state.client, { codexQueue }),
    refresh: vi.fn(),
  };
  const view = render(<CodexTools open />);
  await screen.findByText("Previous session message");
  act(() => publishSessionInvalidation(state.client, "s", ["queue"]));
  state = {
    ...state,
    selected: "next",
    current: { ...state.current!, id: "next" },
  };
  view.rerender(<CodexTools open />);
  expect(screen.queryByText("Previous session message")).not.toBeInTheDocument();
  expect(codexQueue).toHaveBeenLastCalledWith("next", expect.any(AbortSignal));

  await act(async () => finishOld(oldQueue));
  expect(screen.queryByText("Previous session message")).not.toBeInTheDocument();
  await act(async () =>
    finishNew({ sessionId: "next", data: [{ id: "new", text: "New session message" }] }),
  );
  expect(screen.getByText("New session message")).toBeVisible();
  expect(screen.queryByText("Previous session message")).not.toBeInTheDocument();
  act(() => publishSessionInvalidation(state.client, "s", ["queue"]));
  expect(codexQueue).toHaveBeenCalledTimes(3);
});
