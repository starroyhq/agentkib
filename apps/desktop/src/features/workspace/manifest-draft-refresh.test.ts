import { describe, expect, it, vi } from "vitest";
import type { Manifest } from "@/core/types";
import {
  draftSectionCount,
  preparedManifestBaseline,
  resolveRefreshedManifest,
} from "./manifest-draft";

function manifest(id: string, shared = "original"): Manifest {
  return {
    schema_version: 2,
    workspace: { id, name: "example" },
    instructions: { shared, scoped: [], platform_overrides: {} },
    skills: [],
    connections: [],
    adapters: {},
    mcp: { config: "mcp.json" },
    memories: { require_approval: true },
  };
}

describe("default manifest draft refresh", () => {
  it.each(["original", "external content"])(
    "treats deletion of a real manifest as a conflict and preserves its identity: %s",
    async (shared) => {
      const baseline = manifest("persisted-id");
      const draft = manifest("persisted-id", "unsaved");
      const confirm = vi.fn().mockResolvedValue(false);
      const retained = vi.fn();
      const result = await resolveRefreshedManifest({
        initialManifest: draft,
        initialBaseline: JSON.stringify(baseline),
        diskManifest: manifest("prepared-after-deletion", shared),
        diskIsDefault: true,
        getCurrentManifest: () => draft,
        confirmDiskVersion: confirm,
        onConflictRetained: retained,
      });
      expect(confirm).toHaveBeenCalledOnce();
      expect(retained).toHaveBeenCalledOnce();
      expect(result).toBe(draft);
      expect(draftSectionCount(result, JSON.stringify(baseline))).toBe(1);
    },
  );

  it("recognizes an acknowledged deletion without changing the persisted draft or hiding a new external edit", async () => {
    const baseline = manifest("persisted-id");
    const draft = manifest("persisted-id", "unsaved");
    const acknowledged = manifest("first-prepared-id");
    const confirm = vi.fn().mockResolvedValue(false);
    for (const shared of ["original", "a new external edit"]) {
      const result = await resolveRefreshedManifest({
        initialManifest: draft,
        initialBaseline: JSON.stringify(baseline),
        acknowledgedDisk: JSON.stringify(acknowledged),
        acknowledgedDiskIsDefault: true,
        diskManifest: manifest("next-prepared-id", shared),
        diskIsDefault: true,
        getCurrentManifest: () => draft,
        confirmDiskVersion: confirm,
      });
      expect(result).toBe(draft);
    }
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("confirms a real manifest appearing even if its contents equal the previous prepared baseline", async () => {
    const baseline = manifest("prepared-id");
    const draft = manifest("prepared-id", "unsaved");
    const confirm = vi.fn().mockResolvedValue(false);
    expect(
      await resolveRefreshedManifest({
        initialManifest: draft,
        initialBaseline: JSON.stringify(baseline),
        initialBaselineIsDefault: true,
        diskManifest: baseline,
        getCurrentManifest: () => draft,
        confirmDiskVersion: confirm,
      }),
    ).toBe(draft);
    expect(confirm).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    "does not ask again for an acknowledged disk while preserving the original draft baseline (default: %s)",
    async (diskIsDefault) => {
      const baseline = manifest("original-id");
      const draft = manifest("original-id", "unsaved");
      const acknowledged = manifest("original-id", "external edit already reviewed");
      const disk = {
        ...acknowledged,
        workspace: {
          ...acknowledged.workspace,
          id: diskIsDefault ? "new-server-id" : "original-id",
        },
      };
      const confirm = vi.fn();
      const retained = vi.fn();
      const result = await resolveRefreshedManifest({
        initialManifest: draft,
        initialBaseline: JSON.stringify(baseline),
        initialBaselineIsDefault: diskIsDefault,
        acknowledgedDisk: JSON.stringify(acknowledged),
        acknowledgedDiskIsDefault: diskIsDefault,
        diskManifest: disk,
        diskIsDefault,
        getCurrentManifest: () => draft,
        confirmDiskVersion: confirm,
        onConflictRetained: retained,
      });
      expect(confirm).not.toHaveBeenCalled();
      expect(retained).toHaveBeenCalledOnce();
      expect(result?.instructions.shared).toBe("unsaved");
      expect(
        draftSectionCount(
          result,
          preparedManifestBaseline(JSON.stringify(baseline), disk, diskIsDefault),
        ),
      ).toBe(1);
    },
  );

  it.each(["a newer external edit"])(
    "asks again for a different disk version after acknowledgment: %s",
    async (next) => {
      const baseline = manifest("saved");
      const draft = manifest("saved", "unsaved");
      const confirm = vi.fn().mockResolvedValue(false);
      const retained = vi.fn();
      const result = await resolveRefreshedManifest({
        initialManifest: draft,
        initialBaseline: JSON.stringify(baseline),
        acknowledgedDisk: JSON.stringify(manifest("saved", "first external edit")),
        diskManifest: manifest("saved", next),
        getCurrentManifest: () => draft,
        confirmDiskVersion: confirm,
        onConflictRetained: retained,
      });
      expect(confirm).toHaveBeenCalledOnce();
      expect(retained).toHaveBeenCalledOnce();
      expect(result).toBe(draft);
    },
  );

  it("does not let a stale acknowledgment manufacture a conflict when disk matches the original baseline", async () => {
    const baseline = manifest("saved");
    const draft = manifest("saved", "unsaved");
    const confirm = vi.fn();
    const retained = vi.fn();
    const result = await resolveRefreshedManifest({
      initialManifest: draft,
      initialBaseline: JSON.stringify(baseline),
      acknowledgedDisk: JSON.stringify(manifest("saved", "earlier external edit")),
      diskManifest: baseline,
      getCurrentManifest: () => draft,
      confirmDiskVersion: confirm,
      onConflictRetained: retained,
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(retained).not.toHaveBeenCalled();
    expect(result).toBe(draft);
    expect(draftSectionCount(result, JSON.stringify(baseline))).toBe(1);
  });

  it("does not overwrite newer edits when a second external version is confirmed", async () => {
    const baseline = manifest("saved");
    const draft = manifest("saved", "unsaved");
    const newer = manifest("saved", "typed while confirming another external version");
    let current = draft;
    const retained = vi.fn();
    expect(
      await resolveRefreshedManifest({
        initialManifest: draft,
        initialBaseline: JSON.stringify(baseline),
        acknowledgedDisk: JSON.stringify(manifest("saved", "first external edit")),
        diskManifest: manifest("saved", "second external edit"),
        getCurrentManifest: () => current,
        confirmDiskVersion: async () => {
          current = newer;
          return true;
        },
        onConflictRetained: retained,
      }),
    ).toBe(newer);
    expect(retained).toHaveBeenCalledOnce();
  });

  it("preserves a one-section draft without prompting for a fresh default identity", async () => {
    const baseline = manifest("previous-default");
    const draft = manifest("previous-default", "edited shared instructions");
    const disk = manifest("new-default");
    const confirm = vi.fn().mockResolvedValue(true);
    const result = await resolveRefreshedManifest({
      initialBaseline: JSON.stringify(baseline),
      initialBaselineIsDefault: true,
      cachedDraft: draft,
      diskManifest: disk,
      diskIsDefault: true,
      getCurrentManifest: () => undefined,
      confirmDiskVersion: confirm,
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(result?.instructions).toEqual(draft.instructions);
    expect(result?.workspace.id).toBe(disk.workspace.id);
    expect(draftSectionCount(result, JSON.stringify(disk))).toBe(1);
  });

  it("adopts a clean freshly prepared default without inventing a draft", async () => {
    const baseline = manifest("previous-default");
    const disk = manifest("new-default");
    const confirm = vi.fn();
    expect(
      await resolveRefreshedManifest({
        initialManifest: baseline,
        initialBaseline: JSON.stringify(baseline),
        initialBaselineIsDefault: true,
        diskManifest: disk,
        diskIsDefault: true,
        getCurrentManifest: () => baseline,
        confirmDiskVersion: confirm,
      }),
    ).toBe(disk);
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "still prompts for real imported source changes (load disk: %s)",
    async (loadDisk) => {
      const baseline = manifest("old");
      const draft = manifest("old", "unsaved");
      const disk = manifest("new", "external source edit");
      const confirm = vi.fn().mockResolvedValue(loadDisk);
      const retained = vi.fn();
      const result = await resolveRefreshedManifest({
        initialBaseline: JSON.stringify(baseline),
        initialBaselineIsDefault: true,
        cachedDraft: draft,
        diskManifest: disk,
        diskIsDefault: true,
        getCurrentManifest: () => undefined,
        confirmDiskVersion: confirm,
        onConflictRetained: retained,
      });
      expect(confirm).toHaveBeenCalledOnce();
      expect(result?.instructions.shared).toBe(loadDisk ? "external source edit" : "unsaved");
      expect(retained).toHaveBeenCalledTimes(loadDisk ? 0 : 1);
    },
  );

  it("does not ignore a real manifest's identity change", async () => {
    const baseline = manifest("old");
    const draft = manifest("old", "unsaved");
    const confirm = vi.fn().mockResolvedValue(false);
    const retained = vi.fn();
    expect(
      await resolveRefreshedManifest({
        initialManifest: draft,
        initialBaseline: JSON.stringify(baseline),
        diskManifest: manifest("external-id"),
        getCurrentManifest: () => draft,
        confirmDiskVersion: confirm,
        onConflictRetained: retained,
      }),
    ).toBe(draft);
    expect(confirm).toHaveBeenCalledOnce();
    expect(retained).toHaveBeenCalledOnce();
    expect(draftSectionCount(draft, JSON.stringify(baseline))).toBe(1);
  });

  it("retains the old baseline when edits supersede the open confirmation", async () => {
    const baseline = manifest("saved");
    const draft = manifest("saved", "unsaved");
    const newer = manifest("saved", "typed while confirming");
    let current = draft;
    const retained = vi.fn();
    const result = await resolveRefreshedManifest({
      initialManifest: draft,
      initialBaseline: JSON.stringify(baseline),
      diskManifest: manifest("saved", "external source edit"),
      getCurrentManifest: () => current,
      confirmDiskVersion: async () => {
        current = newer;
        return true;
      },
      onConflictRetained: retained,
    });
    expect(result).toBe(newer);
    expect(retained).toHaveBeenCalledOnce();
  });
});
