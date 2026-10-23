// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { Suspense } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Manifest } from "@/core/types";
import { initializeI18n, tr } from "@/core/i18n";
import { api } from "@/core/api";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { Route } from "./assets";

const search = vi.hoisted(() => ({ section: "skills" }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({ options }),
  useNavigate: () => vi.fn(),
  useParams: () => ({ workspaceId: "workspace" }),
  useSearch: () => ({ workspaceAssetSection: search.section }),
}));
vi.mock("@/core/api", () => ({ api: { apply: vi.fn(), plan: vi.fn() } }));

const empty: Manifest = {
  schema_version: 2,
  workspace: { id: "workspace", name: "Workspace" },
  instructions: { shared: "Keep instructions", scoped: [], platform_overrides: {} },
  skills: [],
  connections: [],
  adapters: {},
  mcp: { config: "mcp.json" },
  memories: { require_approval: true },
};
function withExisting(section: "skills" | "mcp", name = "Existing"): Manifest {
  return section === "skills"
    ? { ...empty, skills: [{ name, path: ".agents/skills/existing", targets: ["codex"] }] }
    : {
        ...empty,
        connections: [
          {
            name,
            transport: "stdio",
            command: "original-command",
            args: ["original-arg"],
            env: { TOKEN: "${TOKEN}" },
            allow_tools: ["read"],
            targets: ["codex"],
          },
        ],
      };
}
async function mount(section: "skills" | "mcp" = "skills", manifest = empty) {
  search.section = section;
  useWorkspaceStore.setState({
    project: "/workspace",
    manifest,
    baselineManifest: JSON.stringify(manifest),
    scan: { root: "/workspace", manifest_exists: true, agents: [], assets: [], warnings: [] },
  });
  const Component = Route.options.component!;
  render(
    <Suspense fallback={null}>
      <Component />
    </Suspense>,
  );
  await screen.findByRole("textbox", { name: tr("assets.name") });
  return {
    manifest,
    name: screen.getByRole("textbox", { name: tr("assets.name") }),
    value: screen.getByRole("textbox", {
      name: tr(section === "skills" ? "assets.skillPath" : "assets.command"),
    }),
  };
}
function fill(name: HTMLElement, value: HTMLElement, nextName: string, nextValue: string) {
  fireEvent.change(name, { target: { value: nextName } });
  fireEvent.change(value, { target: { value: nextValue } });
}
async function http() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: tr("assets.transport") }));
  await user.click(await screen.findByRole("option", { name: "HTTP" }));
  return screen.getByRole("textbox", { name: tr("assets.url") });
}
function expectUnchanged(manifest: Manifest) {
  expect(useWorkspaceStore.getState().manifest).toBe(manifest);
  expect(useWorkspaceStore.getState().baselineManifest).toBe(JSON.stringify(manifest));
  expect(api.plan).not.toHaveBeenCalled();
  expect(api.apply).not.toHaveBeenCalled();
}
beforeAll(async () => {
  const component = Route.options.component;
  if (component && "preload" in component && typeof component.preload === "function")
    await component.preload();
});
beforeEach(async () => {
  vi.clearAllMocks();
  await initializeI18n("en-US");
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
});
afterEach(cleanup);

describe("E2 asset edit locks", () => {
  it.each(["planningChanges", "applyingChanges"] as const)(
    "keeps all draft inputs read-only during %s and restores editing afterwards",
    async (lock) => {
      const { name, value, manifest } = await mount();
      fill(name, value, "New skill", ".agents/skills/new");
      const add = screen.getByRole("button", { name: tr("common.add") });
      act(() => useWorkspaceStore.setState({ [lock]: true }));
      // Native fieldset semantics apply even when button.disabled itself is false.
      expect(name).toBeDisabled();
      expect(value).toBeDisabled();
      expect(add).toBeDisabled();
      await userEvent.setup().click(add);
      expectUnchanged(manifest);
      act(() => useWorkspaceStore.setState({ [lock]: false }));
      expect(add).toBeEnabled();
      await userEvent.setup().click(add);
      expect(useWorkspaceStore.getState().manifest!.skills).toEqual([
        { name: "New skill", path: ".agents/skills/new", targets: [] },
      ]);
      expect(api.plan).not.toHaveBeenCalled();
      expect(api.apply).not.toHaveBeenCalled();
    },
  );
});

describe("workspace asset draft validation", () => {
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "labels fields, names actual empty lists and associates Skill errors in %s",
    async (locale) => {
      await initializeI18n(locale);
      const { name, value, manifest } = await mount();
      const message = tr("assets.noDraftSkills");
      expect(message).not.toContain("assets.");
      expect(screen.getByText(message)).toBeVisible();
      expect(name).toBeRequired();
      expect(value).toBeRequired();
      expect(name).not.toHaveAttribute("aria-invalid");
      await userEvent.setup().click(screen.getByRole("button", { name: tr("common.add") }));
      expect(name).toHaveAccessibleDescription(tr("assets.nameRequired"));
      expect(value).toHaveAccessibleDescription(tr("assets.skillPathRequired"));
      expect(name).toHaveAttribute("aria-invalid", "true");
      expect(value).toHaveAttribute("aria-invalid", "true");
      expect(name).toHaveFocus();
      expectUnchanged(manifest);
    },
  );

  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "labels MCP fields and both endpoint variants with localized errors in %s",
    async (locale) => {
      await initializeI18n(locale);
      const { name, value, manifest } = await mount("mcp");
      expect(screen.getByText(tr("assets.noDraftConnections"))).toBeVisible();
      expect(screen.getByRole("combobox", { name: tr("assets.transport") })).toBeVisible();
      await userEvent.setup().click(screen.getByRole("button", { name: tr("common.add") }));
      expect(name).toHaveAccessibleDescription(tr("assets.nameRequired"));
      expect(value).toHaveAccessibleDescription(tr("assets.commandRequired"));
      const url = await http();
      expect(url).toHaveAccessibleDescription(tr("assets.urlRequired"));
      expect(url).toBeRequired();
      expectUnchanged(manifest);
    },
  );

  it.each(["skills", "mcp"] as const)(
    "rejects whitespace fields and focuses the remaining empty %s value after correcting the name",
    async (section) => {
      const { name, value, manifest } = await mount(section);
      fill(name, value, " \t ", "   ");
      const add = screen.getByRole("button", { name: tr("common.add") });
      await userEvent.setup().click(add);
      expect(name).toHaveAttribute("aria-invalid", "true");
      expect(value).toHaveAttribute("aria-invalid", "true");
      fireEvent.change(name, { target: { value: "Valid name" } });
      expect(name).not.toHaveAttribute("aria-invalid");
      await userEvent.setup().click(add);
      expect(value).toHaveFocus();
      expectUnchanged(manifest);
    },
  );

  it.each([
    ["skills", "Existing", "Existing"],
    ["skills", "Existing", " Existing "],
    ["skills", " Existing ", " Existing "],
    ["skills", " Existing ", "Existing"],
    ["mcp", "Existing", "Existing"],
    ["mcp", "Existing", " Existing "],
    ["mcp", " Existing ", " Existing "],
    ["mcp", " Existing ", "Existing"],
  ] as const)(
    "refuses %s duplicate %j without replacing original %j and focuses the existing row",
    async (section, original, attempted) => {
      const manifest = withExisting(section, original);
      const { name, value } = await mount(section, manifest);
      fill(name, value, attempted, "replacement-value");
      await userEvent.setup().click(screen.getByRole("button", { name: tr("common.add") }));
      expect(name).toHaveAccessibleDescription(tr("assets.duplicateDraftName", { name: original }));
      expect(name).toHaveValue(attempted);
      expect(value).toHaveValue("replacement-value");
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: tr("assets.viewExistingDraftItem") }));
      expect(screen.getByRole("group", { name: original.trim() })).toHaveFocus();
      expectUnchanged(manifest);
      expect(screen.queryByRole("alertdialog")).toBeNull();
    },
  );

  it.each(["skills", "mcp"] as const)(
    "appends a trimmed %s item on Enter, preserves other data and clears only successful input",
    async (section) => {
      const manifest = withExisting(section);
      const { name, value } = await mount(section, manifest);
      fill(
        name,
        value,
        " New item ",
        section === "skills" ? " ./custom directory/skill " : " /custom directory/server --flag ",
      );
      value.focus();
      await userEvent.setup().keyboard("{Enter}");
      const current = useWorkspaceStore.getState().manifest!;
      expect(current.instructions).toEqual(manifest.instructions);
      expect(current.adapters).toEqual(manifest.adapters);
      if (section === "skills") {
        expect(current.skills).toEqual([
          ...manifest.skills,
          { name: "New item", path: "./custom directory/skill", targets: [] },
        ]);
        expect(current.connections).toBe(manifest.connections);
      } else {
        expect(current.connections).toEqual([
          ...manifest.connections,
          {
            name: "New item",
            transport: "stdio",
            command: "/custom directory/server --flag",
            args: [],
            env: {},
            allow_tools: [],
            targets: [],
          },
        ]);
        expect(current.skills).toBe(manifest.skills);
      }
      expect(name).toHaveValue("");
      expect(value).toHaveValue("");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(
        screen.queryByText(
          tr(section === "skills" ? "assets.noDraftSkills" : "assets.noDraftConnections"),
        ),
      ).toBeNull();
      expect(useWorkspaceStore.getState().baselineManifest).toBe(JSON.stringify(manifest));
      expect(api.plan).not.toHaveBeenCalled();
      expect(api.apply).not.toHaveBeenCalled();
    },
  );

  it.each(["skills", "mcp"] as const)(
    "keeps case-sensitive %s names compatible",
    async (section) => {
      const manifest = { ...withExisting("skills"), connections: withExisting("mcp").connections };
      const { name, value } = await mount(section, manifest);
      fill(name, value, "existing", section === "skills" ? ".agents/skills/lower" : "node");
      await userEvent.setup().click(screen.getByRole("button", { name: tr("common.add") }));
      const current = useWorkspaceStore.getState().manifest!;
      expect(
        (section === "skills" ? current.skills : current.connections).map((item) => item.name),
      ).toEqual(["Existing", "existing"]);
      expect(section === "skills" ? current.connections : current.skills).toEqual(
        section === "skills" ? manifest.connections : manifest.skills,
      );
      expect(api.plan).not.toHaveBeenCalled();
      expect(api.apply).not.toHaveBeenCalled();
    },
  );

  it.each(["skills", "mcp"] as const)(
    "allows a %s name that is already used only in the other naming space",
    async (section) => {
      const manifest = withExisting(section === "skills" ? "mcp" : "skills");
      const { name, value } = await mount(section, manifest);
      fill(name, value, "Existing", section === "skills" ? ".agents/skills/existing" : "node");
      await userEvent.setup().click(screen.getByRole("button", { name: tr("common.add") }));
      const current = useWorkspaceStore.getState().manifest!;
      expect(section === "skills" ? current.skills : current.connections).toHaveLength(1);
      expect(section === "skills" ? current.connections : current.skills).toBe(
        section === "skills" ? manifest.connections : manifest.skills,
      );
      expect(screen.queryByRole("alert")).toBeNull();
      expect(api.plan).not.toHaveBeenCalled();
      expect(api.apply).not.toHaveBeenCalled();
    },
  );

  it.each(["ftp://example.test", "node-server", "HTTP://example.test", "https:/example.test"])(
    "rejects HTTP value %j using the existing manifest prefix rule and preserves transport switching",
    async (endpoint) => {
      const { name, manifest } = await mount("mcp");
      const url = await http();
      fill(name, url, "Service", endpoint);
      await userEvent.setup().click(screen.getByRole("button", { name: tr("common.add") }));
      expect(url).toHaveAccessibleDescription(tr("assets.httpUrlInvalid"));
      expect(url).toHaveFocus();
      expectUnchanged(manifest);
      await userEvent.setup().click(screen.getByRole("combobox", { name: tr("assets.transport") }));
      await userEvent.setup().click(await screen.findByRole("option", { name: "stdio" }));
      const command = screen.getByRole("textbox", { name: tr("assets.command") });
      expect(command).toHaveValue(endpoint);
      expect(command).not.toHaveAttribute("aria-invalid");
      await userEvent.setup().click(screen.getByRole("button", { name: tr("common.add") }));
      expect(useWorkspaceStore.getState().manifest!.connections[0]).toMatchObject({
        transport: "stdio",
        command: endpoint,
      });
      expect(api.plan).not.toHaveBeenCalled();
      expect(api.apply).not.toHaveBeenCalled();
    },
  );

  it.each(["https://example.test/mcp?x=a#fragment", "http://127.0.0.1:47653/mcp", "http://"])(
    "keeps the backend-compatible HTTP draft value %j without extra URI normalization",
    async (endpoint) => {
      const { name } = await mount("mcp");
      const url = await http();
      fill(name, url, " namespace/service ", ` ${endpoint} `);
      await userEvent.setup().click(screen.getByRole("button", { name: tr("common.add") }));
      expect(useWorkspaceStore.getState().manifest!.connections).toEqual([
        {
          name: "namespace/service",
          transport: "http",
          url: endpoint,
          env: {},
          allow_tools: [],
          targets: [],
        },
      ]);
      expect(screen.queryByText(tr("assets.noDraftConnections"))).toBeNull();
      expect(api.plan).not.toHaveBeenCalled();
      expect(api.apply).not.toHaveBeenCalled();
    },
  );

  it.each(["bad/name", "bad\\name", ".", ".."])(
    "explains the existing Skill-name restriction for %j",
    async (invalid) => {
      const { name, value, manifest } = await mount();
      fill(name, value, invalid, ".agents/skills/new");
      await userEvent.setup().click(screen.getByRole("button", { name: tr("common.add") }));
      expect(name).toHaveAccessibleDescription(tr("assets.skillNameInvalid"));
      expect(name).toHaveFocus();
      expectUnchanged(manifest);
    },
  );

  it("updates duplicate feedback when the existing draft row is removed without clearing the proposed input", async () => {
    const { name, value } = await mount("skills", withExisting("skills"));
    fill(name, value, "Existing", ".agents/skills/replacement");
    await userEvent.setup().click(screen.getByRole("button", { name: tr("common.add") }));
    expect(name).toHaveAttribute("aria-invalid", "true");
    await userEvent
      .setup()
      .click(
        screen.getByRole("button", { name: tr("assets.removeDraftItem", { name: "Existing" }) }),
      );
    expect(name).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("button", { name: tr("assets.viewExistingDraftItem") })).toBeNull();
    expect(value).toHaveValue(".agents/skills/replacement");
    await userEvent.setup().click(screen.getByRole("button", { name: tr("common.add") }));
    expect(useWorkspaceStore.getState().manifest!.skills).toEqual([
      { name: "Existing", path: ".agents/skills/replacement", targets: [] },
    ]);
    expect(api.plan).not.toHaveBeenCalled();
    expect(api.apply).not.toHaveBeenCalled();
  });
});
