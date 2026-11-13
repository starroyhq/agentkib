// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import type {
  InstalledSkill,
  SkillImportBatchPreview,
  SkillInventory,
  SkillObservation,
} from "@/core/types";
import { SkillImportDialog } from "./SkillImportDialog";

const mocks = vi.hoisted(() => ({
  prepareSkillImports: vi.fn(),
  applySkillImports: vi.fn(),
  discardSkillPreview: vi.fn(),
  readSkillPreviewFile: vi.fn(),
}));
vi.mock("@/core/api", () => ({ api: mocks }));
const observation: SkillObservation = {
  id: "first",
  name: "reviewer",
  path: "/native/reviewer",
  resolved_path: "/shared/reviewer",
  scope: "personal",
  workspace_id: null,
  agents: ["claude-code"],
  kind: "symlink",
  status: "observed",
  owner: "external",
  library_id: null,
  diagnostics: [],
};
const inventory: SkillInventory = {
  observations: [
    observation,
    { ...observation, id: "alias", path: "/other/reviewer", agents: ["codex"] },
    {
      ...observation,
      id: "pending",
      name: "pending",
      path: "/native/pending",
      resolved_path: "/native/pending",
      status: "pending-trust",
      agents: ["hermes"],
      diagnostics: ["Project is not trusted"],
    },
    {
      ...observation,
      id: "broken",
      name: "broken",
      path: "/native/broken",
      resolved_path: null,
      status: "broken-link",
    },
    {
      ...observation,
      id: "managed",
      name: "managed",
      path: "/native/managed",
      resolved_path: "/native/managed",
      owner: "agentkib",
    },
  ],
  warnings: [],
};
const preview: SkillImportBatchPreview = {
  token: "batch",
  expires_at: "2030-01-01T00:00:00Z",
  total_size: 20,
  items: [
    {
      id: "a",
      observation_ids: ["first", "alias"],
      paths: ["/native/reviewer", "/other/reviewer"],
      agents: ["claude-code", "codex"],
      resolved_path: "/shared/reviewer",
      library_id: "reviewer",
      display_name: "reviewer",
      status: "ready",
      preview: {
        token: "nested",
        operation: "install",
        skill: { name: "reviewer", description: "Review", source: null },
        files: [{ path: "SKILL.md", size: 20, executable: false }],
        added: ["SKILL.md"],
        removed: [],
        modified: [],
        total_size: 20,
        local_modified: false,
        expires_at: "2030-01-01T00:00:00Z",
      },
    },
    {
      id: "b",
      observation_ids: ["pending"],
      paths: ["/native/pending"],
      agents: ["hermes"],
      resolved_path: "/native/pending",
      library_id: "pending",
      display_name: "pending",
      status: "ready",
    },
  ],
};
const installed: InstalledSkill = {
  name: "reviewer",
  display_name: "reviewer",
  path: "/library/reviewer",
  description: "Review",
  status: "current",
  size: 20,
  can_rollback: false,
  source: null,
};

describe("SkillImportDialog", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.prepareSkillImports.mockResolvedValue(preview);
    mocks.discardSkillPreview.mockResolvedValue(undefined);
    mocks.readSkillPreviewFile.mockResolvedValue({
      path: "SKILL.md",
      before: null,
      after: "Frozen instructions",
      binary: false,
      truncated: false,
    });
  });
  afterEach(async () => {
    cleanup();
    await changeLocale("en-US");
  });

  it("groups physical aliases, selects readable native-restricted packages and excludes owned deployments", async () => {
    render(
      <SkillImportDialog
        inventory={inventory}
        deployments={[]}
        onClose={vi.fn()}
        onImported={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    expect(
      (screen.getByRole("checkbox", { name: "broken" }) as HTMLInputElement).getAttribute(
        "aria-disabled",
      ) ?? (screen.getByRole("checkbox", { name: "broken" }) as HTMLInputElement).disabled,
    ).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "managed" })).toBeNull();
    expect(screen.getByText("2 packages selected")).toBeTruthy();
    expect(screen.getByText("Project is not trusted")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Review selected packages" }));
    expect(mocks.prepareSkillImports).toHaveBeenCalledWith(["first", "alias", "pending"]);
    expect(await screen.findByText("Ready to import 2 packages · 0.0 KB")).toBeTruthy();
  });

  it("selects and deselects only filtered rows and reads reviewed files through the batch token", async () => {
    render(
      <SkillImportDialog
        inventory={inventory}
        deployments={[]}
        onClose={vi.fn()}
        onImported={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Search Skills" }), "pending");
    await user.click(screen.getByRole("button", { name: "Deselect all shown" }));
    expect(screen.getByText("1 packages selected")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Review selected packages" }));
    expect(mocks.prepareSkillImports).toHaveBeenCalledWith(["first", "alias"]);
    await user.click(await screen.findByText("Review package files"));
    await waitFor(() =>
      expect(mocks.readSkillPreviewFile).toHaveBeenCalledWith("batch", "SKILL.md", undefined, "a"),
    );
    expect(await screen.findByText("Frozen instructions")).toBeTruthy();
  });

  it("keeps imported results after a refresh error and re-prepares only failed packages", async () => {
    mocks.applySkillImports.mockResolvedValue({
      token: "batch",
      items: [
        {
          id: "a",
          observation_ids: ["first", "alias"],
          status: "imported",
          library_id: "reviewer",
          skill: installed,
        },
        { id: "b", observation_ids: ["pending"], status: "failed", error: "Destination occupied" },
      ],
    });
    const onImported = vi.fn().mockResolvedValue([new Error("Inventory refresh failed")]);
    render(
      <SkillImportDialog
        inventory={inventory}
        deployments={[]}
        onClose={vi.fn()}
        onImported={onImported}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Review selected packages" }));
    await user.click(await screen.findByRole("button", { name: "Import ready packages" }));
    expect(await screen.findByText(/Inventory refresh failed/)).toBeTruthy();
    expect(screen.getByText("Imported")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onImported).toHaveBeenCalledWith([installed], []);
    mocks.prepareSkillImports.mockResolvedValue({
      ...preview,
      token: "retry",
      items: [preview.items[1]],
    });
    await user.click(screen.getByRole("button", { name: "Retry failed packages" }));
    expect(mocks.prepareSkillImports).toHaveBeenLastCalledWith(["pending"]);
    expect(mocks.applySkillImports).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("reviewer · Imported")).toBeTruthy();
    expect(mocks.discardSkillPreview).toHaveBeenCalledWith("batch");
  });

  it("distinguishes successful and failed imports with the same display name by source paths", async () => {
    mocks.prepareSkillImports.mockResolvedValue({
      ...preview,
      items: [
        preview.items[0],
        {
          ...preview.items[1],
          display_name: "reviewer",
          library_id: "reviewer-2",
          paths: ["/second/reviewer"],
          resolved_path: "/second-source/reviewer",
        },
      ],
    });
    mocks.applySkillImports.mockResolvedValue({
      token: "batch",
      items: [
        {
          id: "a",
          observation_ids: ["first", "alias"],
          status: "imported",
          library_id: "reviewer",
          skill: installed,
        },
        { id: "b", observation_ids: ["pending"], status: "failed", error: "Destination occupied" },
      ],
    });
    render(
      <SkillImportDialog
        inventory={inventory}
        deployments={[]}
        onClose={vi.fn()}
        onImported={vi.fn().mockResolvedValue([])}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Review selected packages" }));
    await user.click(await screen.findByRole("button", { name: "Import ready packages" }));
    await screen.findByText("Import results");
    const successfulRow = screen.getByText("/shared/reviewer").parentElement!;
    expect(within(successfulRow).getByText("Imported")).toBeTruthy();
    expect(within(successfulRow).getByText("Library ID: reviewer")).toBeTruthy();
    const failedRow = screen.getByText("/second-source/reviewer").parentElement!;
    expect(within(failedRow).getByText("Failed")).toBeTruthy();
    expect(within(failedRow).getByText("/second/reviewer")).toBeTruthy();
    expect(within(failedRow).getByText("Destination occupied")).toBeTruthy();
    expect(within(failedRow).queryByText(/Library ID:/)).toBeNull();
  });

  it("releases a prepared batch on cancellation", async () => {
    const onClose = vi.fn();
    render(
      <SkillImportDialog
        inventory={inventory}
        deployments={[]}
        onClose={onClose}
        onImported={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Review selected packages" }));
    await screen.findByRole("button", { name: "Import ready packages" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.discardSkillPreview).toHaveBeenCalledWith("batch");
    expect(onClose).toHaveBeenCalledOnce();
    expect(mocks.applySkillImports).not.toHaveBeenCalled();
  });

  it("localizes import controls in all four interface languages", async () => {
    render(
      <SkillImportDialog
        inventory={{ observations: [], warnings: [] }}
        deployments={[]}
        onClose={vi.fn()}
        onImported={vi.fn()}
      />,
    );
    for (const locale of ["en-US", "zh-CN", "zh-Hant", "ja-JP"] as const) {
      await act(() => changeLocale(locale));
      expect(screen.getByRole("dialog", { name: tr("skills.imports.title") })).toBeTruthy();
      expect(screen.getByRole("button", { name: tr("skills.imports.review") })).toBeTruthy();
      expect(tr("skills.imports.empty")).not.toBe("skills.imports.empty");
    }
  });
});
