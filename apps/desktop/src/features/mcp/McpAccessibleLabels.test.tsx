// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpManagedEntry } from "@agentkib/runtime-protocol";
import { api } from "@/core/api";
import { initializeI18n, tr } from "@/core/i18n";
import { McpServiceEditor, newMcpDraft } from "./McpServiceEditor";
import { McpImportPanel } from "./McpImportPanel";

vi.mock("@/core/api", () => ({
  api: { saveMcpConfiguration: vi.fn(), previewMcpImport: vi.fn(), applyMcpImport: vi.fn() },
}));

const locales = ["zh-CN", "zh-Hant", "ja-JP", "en-US"] as const;
const labels = {
  "zh-CN": { action: " 的操作", value: " 的值", key: " 键名", import: " 的导入操作" },
  "zh-Hant": { action: " 的操作", value: " 的值", key: " 鍵名", import: " 的匯入操作" },
  "ja-JP": { action: " の操作", value: " の値", key: " のキー名", import: " の取り込み操作" },
  "en-US": { action: " action", value: " value", key: " key name", import: " import action" },
} as const;
const server: McpManagedEntry = {
  config: {
    id: "fixture",
    name: "Fixture service",
    transport: "streamable-http",
    url: "https://example.test/mcp",
    enabled: false,
    env: {},
    headers: {},
    targets: [],
    allow_tools: [],
    lan_allow_tools: [],
    supports_parallel_tool_calls: false,
  },
  scope: "workspace",
  inherited: false,
  configured_env: ["API_KEY"],
  configured_headers: ["API_KEY"],
  required_env: [],
  required_headers: [],
  oauth_configured: false,
};

function Editor({ onSaved }: { onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState(() => newMcpDraft(server));
  return (
    <McpServiceEditor
      project="/fixture"
      revision="r1"
      entry={server}
      draft={draft}
      onDraft={setDraft}
      onSaved={onSaved}
      onCancel={vi.fn()}
    />
  );
}

afterEach(cleanup);
beforeEach(() => vi.resetAllMocks());

describe("MCP accessible action labels", () => {
  it.each(locales)(
    "localizes secret controls and preserves secret operations in %s",
    async (locale) => {
      await initializeI18n(locale);
      const user = userEvent.setup();
      const onSaved = vi.fn().mockResolvedValue(undefined);
      render(<Editor onSaved={onSaved} />);
      for (const group of ["env", "headers"] as const) {
        const groupName = tr(group === "env" ? "mcp.environmentSecrets" : "mcp.headerSecrets");
        const action = screen.getByRole("combobox", {
          name: `${groupName} API_KEY${labels[locale].action}`,
        });
        expect(action).not.toHaveAccessibleName(`${group} API_KEY`);
        await user.click(action);
        await user.click(
          await screen.findByRole("option", { name: tr("mcp.manage.secret_replace") }),
        );
        const value = screen.getByLabelText(`${groupName} API_KEY${labels[locale].value}`);
        expect(value).toHaveAttribute("type", "password");
        await user.type(value, `${group}-fixture-secret`);
        const key = screen.getByRole("textbox", {
          name: `${groupName}${labels[locale].key}`,
        });
        expect(key).toHaveValue("");
      }
      await user.click(screen.getByRole("button", { name: tr("common.save") }));
      await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
      expect(api.saveMcpConfiguration).toHaveBeenCalledWith({
        project: "/fixture",
        revision: "r1",
        server: server.config,
        originalId: "fixture",
        overrideInherited: false,
        secretOperations: {
          env: { API_KEY: { action: "replace", value: "env-fixture-secret" } },
          headers: { API_KEY: { action: "replace", value: "headers-fixture-secret" } },
        },
      });
    },
  );

  it.each(locales)(
    "localizes import actions and preserves the source key in %s",
    async (locale) => {
      await initializeI18n(locale);
      vi.mocked(api.previewMcpImport).mockResolvedValue({
        token: "preview",
        revision: "r1",
        items: [
          {
            key: "source-id",
            config: server.config,
            status: "conflict",
            warnings: [],
            required_env: [],
            required_headers: [],
          },
        ],
      });
      vi.mocked(api.applyMcpImport).mockResolvedValue({ revision: "r2", results: [] });
      const onSaved = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();
      render(<McpImportPanel project="/fixture" onSaved={onSaved} />);
      await user.click(screen.getByRole("textbox"));
      await user.paste("{}");
      await user.click(screen.getByRole("button", { name: tr("mcp.manage.previewPaste") }));
      const action = await screen.findByRole("combobox", {
        name: `source-id${labels[locale].import}`,
      });
      expect(action).not.toHaveAccessibleName("source-id action");
      await user.click(action);
      await user.click(await screen.findByRole("option", { name: tr("mcp.manage.replaceLocal") }));
      await user.click(screen.getByRole("button", { name: tr("mcp.manage.collect") }));
      await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
      expect(api.applyMcpImport).toHaveBeenCalledWith({
        project: "/fixture",
        token: "preview",
        revision: "r1",
        selections: [{ key: "source-id", action: "replace" }],
      });
    },
  );
});
