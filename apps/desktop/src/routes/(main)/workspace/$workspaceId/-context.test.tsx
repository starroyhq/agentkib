// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import type { ContextPreview } from "@/core/types";
import { ContextPage } from "./context";

vi.mock("@/core/api", () => ({ api: { context: vi.fn() } }));

const preview = (skill: string) =>
  ({
    sections: [],
    warnings: [],
    visible_skills: [skill],
    visible_connections: [],
    approved_memories: [],
  }) as unknown as ContextPreview;

describe("ContextPage", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("debounces working directory edits and keeps the previous preview while resolving", async () => {
    vi.mocked(api.context).mockImplementation(async (_project, cwd) =>
      preview(cwd === "/repo" ? "root-skill" : "nested-skill"),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ContextPage project="/repo" onOpenInstructions={() => undefined} />
      </QueryClientProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("root-skill")).toBeTruthy();

    const input = screen.getByLabelText(tr("context.workingDirectory"));
    fireEvent.change(input, { target: { value: "/repo/a" } });
    fireEvent.change(input, { target: { value: "/repo/app" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    // 防抖期间既不发请求，也不丢掉已有结果。
    expect(api.context).toHaveBeenCalledTimes(1);
    expect(screen.getByText("root-skill")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(api.context).toHaveBeenCalledTimes(2);
    expect(api.context).toHaveBeenLastCalledWith("/repo", "/repo/app", "codex");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("nested-skill")).toBeTruthy();
    expect(screen.queryByText("root-skill")).toBeNull();
  });

  // 与后端 context-claude.ts 里的静态文案逐字一致；任一边改动都会让对应测试失败。
  const SETTINGS_NOT_READ =
    "Settings given on the command line (--settings, --setting-sources), policy delivered by MDM, a configuration profile or the Windows registry, and server-managed settings are not visible to AgentKib, so this list can differ from what Claude Code loads.";
  const CONFIG_INVALID =
    "CLAUDE_CONFIG_DIR is set but is not a usable absolute path, so AgentKib reads Claude Code's default configuration folder. User-level instructions shown here may belong to a different setup than the one Claude Code uses.";
  const MEMORY_OFF =
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 is set in AgentKib's environment, so auto memory is not shown. Claude Code started in another environment may still load it.";
  const SWITCHES =
    "An environment variable that turns off CLAUDE.md loading (CLAUDE_CODE_DISABLE_CLAUDE_MDS, CLAUDE_CODE_SAFE_MODE or CLAUDE_CODE_SIMPLE) is set in AgentKib's environment. Claude Code started with it loads fewer instruction files than listed here; AgentKib does not model this.";
  const VERSION_UNKNOWN =
    "AGENTS.md may not be loaded: the Claude Code version could not be detected, and Claude Code reads AGENTS.md only from v2.1.277.";
  const EXTERNAL =
    "External import (outside the working directory): ~/team.md (source: /repo/CLAUDE.md). Claude Code asks for approval before loading external imports, so this content may not be in effect.";
  const MISSING = "Imported file is missing: /repo/none.md (source: /repo/CLAUDE.md)";

  async function renderWarnings(warnings: string[]) {
    vi.mocked(api.context).mockResolvedValue({
      ...preview("any-skill"),
      warnings,
    });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ContextPage project="/repo" onOpenInstructions={() => undefined} />
      </QueryClientProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it("shows a Note: entry as a neutral note without the prefix and keeps other entries as warnings", async () => {
    await renderWarnings([
      `Note: ${SETTINGS_NOT_READ}`,
      `Note: ${EXTERNAL}`,
      VERSION_UNKNOWN,
      MISSING,
    ]);
    const notes = screen.getAllByRole("note");
    expect(notes.map((note) => note.textContent)).toEqual([
      tr("context.claudeSettingsNotRead"),
      EXTERNAL,
    ]);
    // 注记不带前缀，也不使用警告的琥珀色。
    for (const note of notes) {
      expect(note.textContent).not.toContain("Note:");
      expect(note.className).not.toContain("amber");
    }
    const warning = screen.getByText(tr("context.claudeAgentsVersionUnknown"));
    expect(warning.className).toContain("amber");
    expect(screen.getByText(MISSING).className).toContain("amber");
    expect(screen.queryByText(/^Note: /)).toBeNull();
  });

  it.each(["en-US", "zh-CN", "zh-Hant", "ja-JP"] as const)(
    "localizes the Claude Code context messages in %s",
    async (locale) => {
      await changeLocale(locale);
      try {
        await renderWarnings([
          `Note: ${SETTINGS_NOT_READ}`,
          `Note: ${CONFIG_INVALID}`,
          `Note: ${MEMORY_OFF}`,
          `Note: ${SWITCHES}`,
          VERSION_UNKNOWN,
        ]);
        const pairs: [string, string][] = [
          ["context.claudeSettingsNotRead", SETTINGS_NOT_READ],
          ["context.claudeConfigDirInvalid", CONFIG_INVALID],
          ["context.claudeAutoMemoryOff", MEMORY_OFF],
          ["context.claudeLoadSwitches", SWITCHES],
        ];
        expect(screen.getAllByRole("note").map((note) => note.textContent)).toEqual(
          pairs.map(([key]) => tr(key)),
        );
        const unknown = tr("context.claudeAgentsVersionUnknown");
        expect(screen.getByText(unknown)).toBeTruthy();
        if (locale !== "en-US") {
          // 没有命中映射时界面会退回英文原文，这里要求必须是译文。
          for (const [key, english] of pairs) {
            expect(tr(key)).not.toBe(english);
            expect(screen.queryByText(english)).toBeNull();
          }
          expect(unknown).not.toBe(VERSION_UNKNOWN);
          expect(screen.queryByText(VERSION_UNKNOWN)).toBeNull();
        }
      } finally {
        await changeLocale("en-US");
      }
    },
  );

  // 工作区外来源的徽章显示来源类别；项目内的相对目录（包括与保留名同名的 ./user）原样显示。
  async function renderSections(scopes: string[], agent = "claude-code") {
    vi.mocked(api.context).mockResolvedValue({
      ...preview("any-skill"),
      agent,
      sections: scopes.map((scope, index) => ({
        source: `/repo/${index}.md`,
        scope,
        content: `section ${index}`,
        precedence: index,
      })),
    } as unknown as ContextPreview);
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ContextPage project="/repo" onOpenInstructions={() => undefined} />
      </QueryClientProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
  const sourceKinds = ["managed", "user", "ancestor", "auto-memory", "conditional"] as const;

  it.each(["en-US", "zh-CN", "zh-Hant", "ja-JP"] as const)(
    "labels the source of each section in %s",
    async (locale) => {
      await changeLocale(locale);
      try {
        await renderSections([...sourceKinds, "", "packages/app", "./user"]);
        // The badge is the last element of each section's header.
        const labels = screen
          .getAllByRole("article")
          .map((article) => article.querySelector("header")?.lastElementChild?.textContent);
        expect(labels).toEqual([
          ...sourceKinds.map((kind) => tr(`context.scope.${kind}`)),
          tr("status.scope.project"),
          "packages/app",
          "./user",
        ]);
        if (locale !== "en-US")
          for (const kind of sourceKinds) expect(tr(`context.scope.${kind}`)).not.toBe(kind);
      } finally {
        await changeLocale("en-US");
      }
    },
  );
  // Codex 的工作区里有名为 user、managed 的目录时，scope 恰好等于 Claude 的保留名，必须原样显示。
  it.each(["codex", "cursor", "opencode"])(
    "shows the directory of a %s source as it is, even when it has a name Claude Code reserves",
    async (agent) => {
      await renderSections(["user", "managed", "settings", "assets", ""], agent);
      const labels = screen
        .getAllByRole("article")
        .map((article) => article.querySelector("header")?.lastElementChild?.textContent);
      expect(labels).toEqual(["user", "managed", "settings", "assets", tr("status.scope.project")]);
    },
  );
  it("labels the settings and asset listings of Claude Code", async () => {
    await renderSections(["settings", "assets"]);
    const labels = screen
      .getAllByRole("article")
      .map((article) => article.querySelector("header")?.lastElementChild?.textContent);
    expect(labels).toEqual([tr("context.scope.settings"), tr("context.scope.assets")]);
  });
});
