// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useEffect } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composerAddCopy } from "@agentkib/session-ui";
import {
  WebClient,
  type Access,
  type ConversationClientBridge,
  type Live,
  type UploadedAttachment,
} from "@agentkib/web-client";
import {
  SessionProvider,
  useSession,
} from "@/features/conversation/features/sessions/session-context";
import { SessionComposer } from "@/features/conversation/features/sessions/session-composer";
import { codexCopy } from "@/features/conversation/features/sessions/codex-copy";
import { composerLayoutCopy } from "@/features/conversation/features/sessions/composer-layout-copy";
import { managedControlCopy } from "@/features/conversation/features/sessions/managed-control-copy";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
const labels = [
  ["zh-CN", "选择附件文件", "引用文件或技能后，请输入消息或添加附件再发送。"],
  ["zh-Hant", "選取附件檔案", "引用檔案或技能後，請輸入訊息或新增附件再傳送。"],
  [
    "en-US",
    "Choose attachment files",
    "Add a message or upload an attachment to send file or skill references.",
  ],
  [
    "ja-JP",
    "添付ファイルを選択",
    "ファイルやスキルの参照を送るには、メッセージを入力するか添付ファイルを追加してください。",
  ],
] as const;
type Locale = (typeof labels)[number][0];
function fixture(attachments = true, send = true, full = true) {
  const summary = {
    id: "session",
    workspace_id: "workspace",
    agent: "codex" as const,
    title: "Attachment copy",
    availability: "readable" as const,
    archived: false,
    sidechain: false,
  };
  const access: Access = {
    status: "approved",
    protocolVersion: 2,
    csrfToken: "test",
    bootId: "boot",
    experimentalEnabled: true,
    device: {
      id: "paired-browser",
      name: "Test access",
      ...(full ? { accessMode: "full" as const } : {}),
      send,
      approve: send,
      attachments,
      advancedControl: send,
    },
  };
  const live: Live = {
    sessionId: "session",
    status: "idle",
    revision: 1,
    sendEnabled: true,
    executionMode: "codex-managed",
    approvals: [],
    questions: [],
  };
  const upload = vi.fn(async (_id: string, file: File): Promise<UploadedAttachment> => ({
    id: "attachment",
    name: file.name,
    mime: file.type,
    size: file.size,
    version: "1",
  }));
  const request = vi.fn(async (path: string, _body?: unknown) => {
    const operation = path.split("?")[0];
    if (operation === "access") return access;
    if (operation === "catalog")
      return {
        indexEnabled: true,
        sessions: [summary],
        workspaces: [{ id: "workspace", name: "Project", path: "/project" }],
      };
    if (operation === "events") return { events: [], warnings: [] };
    if (operation === "live") return live;
    if (operation === "managed/capabilities")
      return {
        sessionId: "session",
        status: "idle",
        executionMode: "codex-managed",
        features: {
          attachments: { available: attachments },
          send: { available: send },
          context: { available: true },
        },
      };
    if (operation === "managed/settings")
      return {
        sessionId: "session",
        revision: 1,
        available: false,
        current: { modelId: "", effort: "", mode: "default" },
        defaults: { modelId: "", effort: "" },
        writable: {
          model: { available: false },
          effort: { available: false },
          mode: { available: false },
        },
        options: { models: [], collaborationModes: [], policies: [], serviceTiers: [] },
      };
    if (operation === "codex/goals")
      return { sessionId: "session", revision: 1, available: false, actions: {} };
    if (operation === "codex/context-options")
      return {
        sessionId: "session",
        revision: 1,
        resources: [{ id: "readme", kind: "file", name: "README.md", available: true }],
      };
    return { available: false, data: [] };
  });
  const bridge: ConversationClientBridge = {
    async request<T>(path: string, body?: unknown) {
      return (await request(path, body)) as T;
    },
    uploadAttachment: async (id, file, progress) => {
      const result = await upload(id, file);
      progress(100);
      return result;
    },
    stream(id, handlers) {
      let closed = false;
      queueMicrotask(() => {
        if (closed) return;
        handlers.open();
        if (id)
          handlers.event(
            "session-event",
            JSON.stringify({
              protocolVersion: 2,
              subscriptionId: id,
              sessionId: id,
              runtimeBootId: "runtime",
              epoch: "epoch",
              seq: 0,
              cursor: "cursor",
              type: "snapshot",
              payload: { live },
            }),
          );
      });
      return () => {
        closed = true;
      };
    },
  };
  return {
    client: new WebClient(undefined, { type: "same-origin" }, bridge),
    request,
    upload,
    access,
  };
}
function Composer() {
  const { access, sessions, selected, choose, page } = useSession();
  useEffect(() => {
    if (access?.status === "approved" && sessions.length && !selected) void choose("session");
  }, [access?.status, sessions.length, selected, choose]);
  return page ? <SessionComposer /> : null;
}

async function start(locale: Locale, f = fixture()) {
  render(
    <SessionProvider client={f.client} embedded initialLocale={locale}>
      <Composer />
    </SessionProvider>,
  );
  await screen.findByRole("textbox");
  await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
  return f;
}
function writes(f: ReturnType<typeof fixture>) {
  return f.request.mock.calls.filter(([, body]) => body !== undefined);
}
beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("Web access attachment and permission copy", () => {
  it.each(labels)(
    "uses general file copy and the real attachment picker in %s",
    async (locale, chooseLabel, resourceHint) => {
      const f = await start(locale);
      const c = codexCopy[locale];
      const input = screen.getByLabelText(c.attachment, { selector: "input" });
      await waitFor(() => expect(input).toBeEnabled());
      const picker = vi.spyOn(input, "click");
      fireEvent.click(screen.getByRole("button", { name: c.addContext }));
      const dialog = await screen.findByRole("dialog", { name: c.addContext });
      const choose = within(dialog).getByRole("button", { name: chooseLabel });
      expect(choose).toBeEnabled();
      expect(dialog).not.toHaveTextContent(/手机|手機|phone|スマートフォン/);
      fireEvent.click(
        within(dialog).getByRole("button", { name: composerAddCopy(locale).filesAndFolders }),
      );
      fireEvent.click(await within(dialog).findByRole("checkbox", { name: /README.md/ }));
      fireEvent.click(
        within(dialog).getByRole("button", { name: composerLayoutCopy[locale].done }),
      );
      expect(screen.getByText(resourceHint)).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: c.addContext }));
      fireEvent.click(await screen.findByRole("button", { name: chooseLabel }));
      expect(picker).toHaveBeenCalledOnce();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      const file = new File(["note"], "notes.txt", { type: "text/plain" });
      fireEvent.change(input, { target: { files: [file] } });
      await waitFor(() => expect(f.upload).toHaveBeenCalledExactlyOnceWith("session", file));
      expect(await screen.findByText("notes.txt")).toBeVisible();
      await waitFor(() =>
        expect(
          screen.getByRole("textbox").closest("form")!.querySelector('button[type="submit"]'),
        ).toBeEnabled(),
      );
      expect(screen.queryByText(resourceHint)).not.toBeInTheDocument();
      expect(screen.queryByText(managedControlCopy[locale].send)).not.toBeInTheDocument();
      expect(writes(f)).toEqual([]);
    },
  );
  it.each(labels)("keeps unsupported attachments disabled in %s", async (locale, chooseLabel) => {
    const f = await start(locale, fixture(false));
    const c = codexCopy[locale];
    const input = screen.getByLabelText(c.attachment, { selector: "input" });
    expect(input).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: c.addContext }));
    const choose = await screen.findByRole("button", { name: chooseLabel });
    expect(choose).toBeDisabled();
    fireEvent.click(choose);
    fireEvent.change(input, { target: { files: [new File(["note"], "notes.txt")] } });
    expect(f.upload).not.toHaveBeenCalled();
    expect(writes(f)).toEqual([]);
  });
  it.each(labels)(
    "shows the actual read-only send permission notice without requiring handoff in %s",
    async (locale) => {
      const f = await start(locale, fixture(false, false));
      const expected = {
        "zh-CN": "当前访问没有发送权限。请在运行 AgentKib 的电脑上检查此访问的权限。",
        "zh-Hant": "目前存取沒有傳送權限。請在執行 AgentKib 的電腦上檢查此存取的權限。",
        "en-US":
          "This access does not include permission to send. Check its permissions on the computer running AgentKib.",
        "ja-JP":
          "現在のアクセスでは送信できません。AgentKib を実行しているコンピューターで、このアクセスの権限を確認してください。",
      }[locale];
      expect(await screen.findByText(expected)).toBeVisible();
      const input = screen.getByRole("textbox");
      fireEvent.change(input, { target: { value: "Preserve this draft" } });
      const send = input.closest("form")!.querySelector('button[type="submit"]');
      expect(send).toBeDisabled();
      fireEvent.submit(input.closest("form")!);
      expect(input).toHaveValue("Preserve this draft");
      expect(f.upload).not.toHaveBeenCalled();
      expect(writes(f)).toEqual([]);
    },
  );
  it.each(labels)(
    "explains missing attachment permission on Add for a restricted device in %s",
    async (locale) => {
      const f = await start(locale, fixture(false, true, false));
      const expected = {
        "zh-CN": "当前访问没有附件上传权限。",
        "zh-Hant": "目前存取沒有附件上傳權限。",
        "en-US": "This access does not include permission to upload attachments.",
        "ja-JP": "現在のアクセスでは添付ファイルをアップロードできません。",
      }[locale];
      const button = screen.getByRole("button", { name: codexCopy[locale].addContext });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", expected);
      fireEvent.click(button);
      expect(f.upload).not.toHaveBeenCalled();
      expect(writes(f)).toEqual([]);
    },
  );
});
