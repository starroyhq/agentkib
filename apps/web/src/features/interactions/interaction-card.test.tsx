import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Approval, UserQuestionRequest } from "@agentkib/web-client";
import {
  approvalCardModel,
  displayCommand,
  InteractionDock,
  type AnswerContext,
  type InteractionDockItem,
  type InteractionLocale,
} from "@agentkib/session-ui";

afterEach(cleanup);

const request: UserQuestionRequest = {
  requestId: "request",
  turnId: "turn",
  supported: true,
  questions: [
    {
      id: "one",
      question: "选择方案",
      options: [{ label: "方案 A", description: "说明 A" }, { label: "方案 B" }],
      multiSelect: false,
      allowCustom: true,
    },
    {
      id: "two",
      question: "选择功能",
      options: [{ label: "搜索" }, { label: "目录" }],
      multiSelect: true,
      allowCustom: false,
    },
  ],
};
const single = { ...request, questions: [request.questions[0]] };

function renderQuestion(
  question: UserQuestionRequest,
  options: { enabled?: boolean; locale?: InteractionLocale; answerContext?: AnswerContext } = {},
) {
  const onAnswer = vi.fn((..._args: unknown[]) => true);
  const items: InteractionDockItem[] = [
    {
      kind: "question",
      key: "q",
      request: question,
      enabled: options.enabled ?? true,
      answerContext: options.answerContext,
    },
  ];
  render(
    <InteractionDock
      locale={options.locale ?? "zh-CN"}
      items={items}
      busy={false}
      onChoose={vi.fn()}
      onAnswer={onAnswer}
    />,
  );
  return { onAnswer, answers: (call = 0) => onAnswer.mock.calls[call]?.[1] };
}

describe("question card", () => {
  it("asks each question in turn and sends the original option labels", () => {
    const { answers } = renderQuestion(request);
    expect(screen.getByRole("heading", { name: "选择方案" })).toBeVisible();
    expect(screen.getByText("说明 A")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "方案 A" }));
    expect(screen.getByRole("heading", { name: "选择功能" })).toBeVisible();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "搜索" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "目录" }));
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(answers()).toEqual({ one: ["方案 A"], two: ["搜索", "目录"] });
  });

  it("sends a chosen option at once on the last question", () => {
    const { answers } = renderQuestion(single);
    fireEvent.click(screen.getByRole("button", { name: "方案 A" }));
    expect(answers()).toEqual({ one: ["方案 A"] });
  });

  it("sends a written answer in place of an option, never a blank one", () => {
    const { onAnswer, answers } = renderQuestion(single);
    const input = screen.getByLabelText("选择方案 · 或自行撰写回复");
    fireEvent.change(input, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: " 自己的方案 " } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(answers()).toEqual({ one: ["自己的方案"] });
  });

  it("cannot answer when this device may not or the request has gone", () => {
    const { onAnswer } = renderQuestion(request, { enabled: false });
    expect(screen.getByRole("button", { name: "方案 A" })).toBeDisabled();
    expect(screen.getByLabelText("选择方案 · 或自行撰写回复")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "方案 A" }));
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("accepts the 4096-character boundary and blocks longer input", async () => {
    const { onAnswer } = renderQuestion(single);
    const input = screen.getByLabelText("选择方案 · 或自行撰写回复");
    expect(input).toHaveAttribute("maxlength", "4096");
    fireEvent.change(input, { target: { value: "x".repeat(4096) } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: "x".repeat(4097) } });
    expect(screen.getByRole("alert")).toHaveTextContent("4096");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("matches the native single-answer UTF-8 byte boundary", async () => {
    const { onAnswer } = renderQuestion(single);
    const input = screen.getByLabelText("选择方案 · 或自行撰写回复");
    for (const value of ["文".repeat(2730), "文".repeat(2730) + "ab"]) {
      await waitFor(() => expect(input).toBeEnabled());
      fireEvent.change(input, { target: { value } });
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
    }
    expect(onAnswer).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: "文".repeat(2731) } });
    expect(screen.getByRole("alert")).toHaveTextContent("8192");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("rejects a written answer that repeats a chosen option", () => {
    renderQuestion({ ...request, questions: [{ ...request.questions[0], multiSelect: true }] });
    fireEvent.click(screen.getByRole("checkbox", { name: "方案 A" }));
    const input = screen.getByLabelText("选择方案 · 或自行撰写回复");
    fireEvent.change(input, { target: { value: "方案 A" } });
    expect(screen.getByRole("alert")).toHaveTextContent("重复");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "新方案" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  });

  it("counts the complete UTF-8 JSON body, including context", () => {
    const questions = Array.from({ length: 9 }, (_, i) => ({
      ...request.questions[0],
      id: String(i),
      question: `问题 ${i}`,
      options: [],
    }));
    renderQuestion(
      { ...request, questions },
      {
        answerContext: { sessionId: "s".repeat(64), bootId: "b".repeat(43), expectedRevision: 123 },
      },
    );
    for (let i = 0; i < 9; i++) {
      fireEvent.change(screen.getByLabelText(`问题 ${i} · 回复…`), {
        target: { value: "文".repeat(2700) },
      });
      if (i < 8) fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    }
    expect(screen.getByRole("alert")).toHaveTextContent("总量");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("问题 8 · 回复…"), { target: { value: "文" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  });

  it.each(["__proto__", "constructor", "toString"])("answers a question whose id is %s", (id) => {
    const native = { ...single, questions: [{ ...single.questions[0], id }] };
    const chosen = renderQuestion(native);
    fireEvent.click(screen.getByRole("button", { name: "方案 A" }));
    expect(chosen.answers()).toEqual(Object.fromEntries([[id, ["方案 A"]]]));
    cleanup();
    const written = renderQuestion(native);
    fireEvent.change(screen.getByLabelText("选择方案 · 或自行撰写回复"), {
      target: { value: "自己的方案" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(written.answers()).toEqual(Object.fromEntries([[id, ["自己的方案"]]]));
  });

  it("keeps prototype-named multi-choice answers independent", () => {
    const { answers } = renderQuestion({
      ...request,
      questions: [{ ...request.questions[1], id: "__proto__" }],
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "搜索" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "目录" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "搜索" }));
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(answers()).toEqual(Object.fromEntries([["__proto__", ["目录"]]]));
  });

  it.each([
    { ...request, supported: false },
    { ...request, questions: null },
    { ...request, questions: [{ ...request.questions[0], options: null }] },
    { ...request, questions: [{ ...request.questions[0], options: [null] }] },
    { ...request, questions: [{ ...request.questions[0], question: {} }] },
    { ...request, questions: [request.questions[0], request.questions[0]] },
  ])("shows unsupported or malformed requests without a way to answer", (native) => {
    const { onAnswer } = renderQuestion(native as unknown as UserQuestionRequest);
    expect(screen.getByRole("status")).toHaveTextContent("此问题已失效或暂时无法回答");
    expect(screen.queryByRole("button", { name: "方案 A" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("masks secret answers and clears them as soon as they are sent", () => {
    const { answers } = renderQuestion(
      {
        requestId: "secret",
        turnId: "turn",
        supported: true,
        questions: [
          {
            id: "token",
            question: "Token",
            isSecret: true,
            options: [],
            multiSelect: false,
            allowCustom: true,
          },
        ],
      },
      { locale: "en-US" },
    );
    const input = screen.getByLabelText("Token · Reply…");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("autocomplete", "new-password");
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(input).toHaveAttribute("type", "text");
    fireEvent.change(input, { target: { value: " secret-value " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(answers()).toEqual({ token: [" secret-value "] });
    expect(screen.queryByDisplayValue(" secret-value ")).not.toBeInTheDocument();
  });
});

const command: Approval = {
  requestId: 1,
  turnId: "t",
  method: "item/commandExecution/requestApproval",
  command: "/bin/zsh -lc 'pnpm install --frozen-lockfile'",
  cwd: "/projects/app",
  supported: true,
  availableDecisions: [],
  decisionOptions: [
    { id: "once", label: "accept", decision: "accept", scope: "once" },
    { id: "session", label: "acceptForSession", decision: "acceptForSession", scope: "session" },
    {
      id: "persist",
      label: "acceptWithExecpolicyAmendment",
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: ["pnpm", "install", "--frozen-lockfile"],
        },
      },
      scope: "persistent",
    },
    { id: "decline", label: "decline", decision: "decline", scope: "once" },
    { id: "cancel", label: "cancel", decision: "cancel", scope: "once" },
  ],
  requestContext: { reason: "安装依赖需要访问网络" },
};

function model(approval: Approval, locale: InteractionLocale = "zh-CN", canStop = true) {
  return approvalCardModel(approval, {
    locale,
    agent: approval.method.startsWith("claude/") ? "Claude Code" : "Codex",
    workspacePath: "/projects/app",
    canStop,
  });
}

function renderApprovals(
  approvals: Approval[],
  options: {
    locale?: InteractionLocale;
    canStop?: boolean;
    failure?: string;
    result?: unknown;
  } = {},
) {
  const onChoose = vi.fn((..._args: unknown[]) => ("result" in options ? options.result : true));
  render(
    <InteractionDock
      locale={options.locale ?? "zh-CN"}
      items={approvals.map((approval, index) => ({
        kind: "approval",
        key: `a${index}`,
        model: model(approval, options.locale, options.canStop ?? true),
        enabled: true,
      }))}
      busy={false}
      failure={options.failure}
      onChoose={onChoose}
      onAnswer={vi.fn()}
    />,
  );
  return onChoose;
}

describe("approval card", () => {
  it("asks in the agent's words and shows the bare command, the reason and what each option keeps", () => {
    renderApprovals([command]);
    const card = screen.getByRole("region", { name: "等待审批" });
    expect(
      within(card).getByRole("heading", { name: "是否要让 Codex 运行此命令？" }),
    ).toBeVisible();
    expect(within(card).getByText("pnpm install --frozen-lockfile")).toBeVisible();
    expect(within(card).getByText("安装依赖需要访问网络")).toBeVisible();
    for (const name of ["允许一次", "允许此会话", "始终允许", "拒绝"])
      expect(within(card).getByRole("button", { name })).toBeEnabled();
    expect(within(card).getByRole("button", { name: "始终允许" })).toHaveAccessibleDescription(
      "以后以 pnpm install --frozen-lockfile 开头的命令都不再询问",
    );
    expect(within(card).queryByRole("button", { name: "拒绝并停止本轮" })).not.toBeInTheDocument();
    expect(within(card).queryByText(/中运行/)).not.toBeInTheDocument();
    expect(within(card).queryByText(/原客户端/)).not.toBeInTheDocument();
    expect(card.querySelector("details")).not.toHaveAttribute("open");
  });

  it("sends the exact offered decision with one click, without a confirmation step", () => {
    const onChoose = renderApprovals([command]);
    fireEvent.click(screen.getByRole("button", { name: "始终允许" }));
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose.mock.calls[0][1]).toMatchObject({
      key: "persist",
      nativeDecision: command.decisionOptions![2].decision,
    });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("offers deny-and-stop only when the composer cannot stop the turn", () => {
    renderApprovals([command], { canStop: false });
    expect(screen.getByRole("button", { name: "拒绝并停止本轮" })).toBeEnabled();
  });

  it("answers with number keys and collapses without deciding", () => {
    const onChoose = renderApprovals([command]);
    const card = screen.getByRole("region", { name: "等待审批" });
    fireEvent.keyDown(card, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "等待审批" })).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "展开 · 等待审批 · pnpm install --frozen-lockfile" }),
    );
    fireEvent.click(within(screen.getByRole("region")).getByRole("button", { name: "收起" }));
    expect(onChoose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^展开/ }));
    fireEvent.keyDown(screen.getByRole("region", { name: "等待审批" }), { key: "1" });
    expect(onChoose.mock.calls[0][1]).toMatchObject({ key: "once", nativeDecision: "accept" });
  });

  it("pages through waiting requests", () => {
    renderApprovals([
      command,
      {
        requestId: "bash",
        turnId: "t",
        method: "claude/can_use_tool",
        toolName: "Bash",
        input: { command: "echo hello" },
        availableDecisions: ["allow", "deny"],
        supported: true,
      },
    ]);
    expect(within(screen.getByRole("region")).getByText("1/2")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "下一项" }));
    const card = screen.getByRole("region", { name: "等待审批" });
    expect(
      within(card).getByRole("heading", { name: "是否要让 Claude Code 运行此命令？" }),
    ).toBeVisible();
    expect(within(card).getByText("echo hello")).toBeVisible();
    expect(within(card).getByRole("button", { name: "允许" })).toBeEnabled();
  });

  it("says on the card when the host refused its decision", async () => {
    renderApprovals([command], {
      result: undefined,
      failure: "未能发送你的决定。请检查网络连接后重试。",
    });
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("未能发送你的决定");
    expect(screen.getByRole("button", { name: "拒绝" })).toBeEnabled();
  });
});

describe("approval card model", () => {
  it("drops the shell wrapper Codex adds around commands", () => {
    expect(displayCommand(["/bin/zsh", "-lc", "pnpm install"])).toBe("pnpm install");
    expect(displayCommand("/bin/bash -lc 'echo '\\''hi'\\'''")).toBe("echo 'hi'");
    expect(displayCommand('sh -c "echo \\"quoted\\""')).toBe('echo "quoted"');
    expect(displayCommand("git status")).toBe("git status");
    expect(displayCommand(["git", "commit", "-m", "two words"])).toBe('git commit -m "two words"');
  });

  it.each([
    ["zh-CN", "允许 Codex 与 https://destination.example.test 建立连接？"],
    ["zh-TW", "允許 Codex 連線到 https://destination.example.test 嗎？"],
    ["en-US", "Allow Codex to connect to https://destination.example.test?"],
    ["ja-JP", "Codex が https://destination.example.test に接続することを許可しますか？"],
  ] as const)("names the network destination in %s", (locale, title) => {
    const card = model(
      {
        ...command,
        decisionOptions: undefined,
        availableDecisions: ["accept", "decline"],
        requestContext: {
          networkApprovalContext: { host: "destination.example.test", protocol: "https" },
        },
      },
      locale,
    );
    expect(card.title).toBe(title);
    expect(card.icon).toBe("network");
  });

  it("lists requested permissions in plain words and keeps the raw request for details", () => {
    const card = model(
      {
        ...command,
        method: "item/permissions/requestApproval",
        command: undefined,
        requestContext: {
          grantRoot: "/authorized",
          additionalPermissions: {
            network: { enabled: true },
            fileSystem: {
              read: ["/read"],
              write: ["/write"],
              entries: [{ access: "deny", path: { type: "glob_pattern", pattern: "/private/**" } }],
            },
          },
        },
      },
      "en-US",
    );
    expect(card.title).toBe("Codex is asking for permissions");
    expect(card.needs?.text).toBe(
      "granted folder /authorized, network access, read /read, write /write, no access to /private/**",
    );
    expect(card.details).toContain("glob_pattern");
  });

  it("explains command and network rules on the options that save them", () => {
    const card = model({
      ...command,
      decisionOptions: [
        {
          id: "rule",
          label: "applyNetworkPolicyAmendment",
          decision: {
            applyNetworkPolicyAmendment: {
              network_policy_amendment: { action: "deny", host: "private.test" },
            },
          },
          scope: "persistent",
        },
      ],
    });
    expect(card.choices).toEqual([
      expect.objectContaining({ label: "始终拒绝", detail: "以后连接 private.test 直接拒绝" }),
    ]);
  });

  it("names the directory only when it is not the workspace itself", () => {
    expect(model({ ...command, cwd: "/projects/app" }).location).toBeUndefined();
    expect(model({ ...command, cwd: "/projects/app/packages/api" }).location).toBe(
      "在 packages/api 中运行",
    );
    expect(model({ ...command, cwd: "/tmp/elsewhere" }).location).toBe("在 /tmp/elsewhere 中运行");
  });

  it("lists changed files with their line counts", () => {
    const card = model({
      ...command,
      method: "item/fileChange/requestApproval",
      command: undefined,
      changes: [{ path: "src/auth/refresh.ts", kind: { type: "update" }, diff: "+a\n+b\n-c\n" }],
    });
    expect(card.title).toBe("允许 Codex 编辑以下文件吗？");
    expect(card.block).toEqual({ label: "编辑文件", lines: ["src/auth/refresh.ts   +2 −1"] });
    expect(card.choices.find((choice) => choice.key === "session")).toMatchObject({
      label: "允许所有修改",
      detail: "本会话中这次及之后的文件编辑都不再询问",
    });
  });

  it("uses each agent's own options: Claude allow or deny, ACP names as given", () => {
    const tool = model({
      requestId: "fetch",
      turnId: "t",
      method: "claude/can_use_tool",
      toolName: "WebFetch",
      input: { url: "https://docs.example.test" },
      availableDecisions: ["allow", "deny"],
      supported: true,
    });
    expect(tool.title).toBe("是否允许 Claude Code 使用 WebFetch？");
    expect(tool.block).toEqual({ label: "参数", lines: ["url: https://docs.example.test"] });
    expect(tool.choices.map((choice) => choice.label)).toEqual(["允许", "拒绝"]);
    const acp = model({
      requestId: "acp",
      turnId: "t",
      method: "session/request_permission",
      toolCall: { title: "bash" },
      options: [
        { optionId: "once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
      availableDecisions: ["once", "reject"],
      supported: true,
    });
    expect(acp.choices.map((choice) => [choice.label, choice.decision])).toEqual([
      ["Allow once", "once"],
      ["Reject", "reject"],
    ]);
  });

  it("offers only declining when an MCP request needs a form or a link", () => {
    const card = model({
      requestId: "mcp",
      turnId: "t",
      method: "mcpServer/elicitation/request",
      input: { serverName: "linear", message: "请选择要关联的项目。" },
      availableDecisions: ["decline"],
      supported: true,
    });
    expect(card.title).toBe("linear 需要你处理");
    expect(card.message).toBe("请选择要关联的项目。");
    expect(card.declineOnly).toBe("需要填写表单或打开链接，AgentKib 还不支持");
    expect(card.choices).toEqual([
      expect.objectContaining({ label: "拒绝", detail: "拒绝后 Codex 继续本轮" }),
    ]);
  });
});
