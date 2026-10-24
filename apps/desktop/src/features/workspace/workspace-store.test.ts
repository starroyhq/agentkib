import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ChangeSet,
  Manifest,
  SessionHandoffLaunchRequest,
  WorkspaceSummary,
} from "@/core/types";
import { type ChangeSetOrigin, useWorkspaceStore } from "./workspace-store";
import { draftSectionCount, resolveRefreshedManifest } from "./manifest-draft";

const workspace: WorkspaceSummary = {
  id: "workspace-1",
  path: "/workspace-1",
  name: "First workspace",
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
};
const plan: ChangeSet = {
  id: "plan-1",
  project_root: workspace.path,
  created_at: "2026-10-16T00:00:00Z",
  changes: [],
  requires_home_approval: false,
};
const launchRequest: SessionHandoffLaunchRequest = {
  mode: "native-import",
  operation_id: "operation-1",
  workspace_id: workspace.id,
  target_agent: "codex",
  plan_hash: "plan-hash",
};
const manifest = (shared: string): Manifest => ({
  schema_version: 1,
  workspace: { id: workspace.id, name: workspace.name },
  instructions: { shared, scoped: [], platform_overrides: {} },
  skills: [],
  mcp: { config: "" },
  connections: [],
  memories: { require_approval: true },
  adapters: {},
});

function resetStore() {
  useWorkspaceStore.getState().resetWorkspace();
  useWorkspaceStore.getState().setWorkspaceDrafts({});
}

describe("transient workspace notices", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("keeps cached baselines aligned with dirty drafts after apply, discard, and cache cleanup", () => {
    const baseline = manifest("saved");
    const draft = manifest("unsaved");
    const applied = manifest("doctor update");
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      manifest: draft,
      baselineManifest: JSON.stringify(baseline),
    });
    useWorkspaceStore.getState().cacheWorkspaceDraft(workspace.id, draft, JSON.stringify(baseline));
    useWorkspaceStore.getState().cacheWorkspaceDraft("other", draft, "other baseline");
    useWorkspaceStore.getState().acceptAppliedManifest(applied);
    expect(useWorkspaceStore.getState().workspaceDraftBaselines).toEqual({
      [workspace.id]: JSON.stringify(applied),
      other: "other baseline",
    });
    expect(useWorkspaceStore.getState().discardWorkspaceDraft(JSON.stringify(draft))).toBe(true);
    expect(useWorkspaceStore.getState().workspaceDraftBaselines).toEqual({
      other: "other baseline",
    });
    useWorkspaceStore.getState().setWorkspaceDrafts({});
    expect(useWorkspaceStore.getState().workspaceDraftBaselines).toEqual({});
  });

  it.each(["new request", "clear request", "new plan", "reset"])(
    "clears an unknown import snapshot on %s while retaining it for unrelated editor changes",
    (action) => {
      const recovery = { workspaceId: workspace.id, project: workspace.path, changeSet: plan };
      useWorkspaceStore.getState().setHandoffLaunchRequest(launchRequest);
      useWorkspaceStore.getState().setHandoffRecoveryChanges(recovery);
      useWorkspaceStore.getState().setManifest(manifest("unrelated draft"));
      useWorkspaceStore.getState().setChangeSet(undefined);
      useWorkspaceStore.getState().setHandoffLaunchRequest(launchRequest);
      expect(useWorkspaceStore.getState().handoffRecoveryChanges).toBe(recovery);
      if (action === "new request")
        useWorkspaceStore
          .getState()
          .setHandoffLaunchRequest({ ...launchRequest, operation_id: "new" });
      else if (action === "clear request")
        useWorkspaceStore.getState().setHandoffLaunchRequest(undefined);
      else if (action === "new plan") useWorkspaceStore.getState().setChangeSet(plan);
      else useWorkspaceStore.getState().resetWorkspace();
      expect(useWorkspaceStore.getState().handoffRecoveryChanges).toBeUndefined();
    },
  );

  it("dismisses only the presentation and preserves the active workspace operation", () => {
    const draft = manifest("keep this draft");
    useWorkspaceStore.setState({ manifest: draft, applyingChanges: true });
    useWorkspaceStore.getState().setMessage("write failed");
    const { messageRevision } = useWorkspaceStore.getState();
    useWorkspaceStore.getState().dismissMessage(messageRevision);
    expect(useWorkspaceStore.getState()).toMatchObject({
      message: "write failed",
      messageDismissed: true,
      manifest: draft,
      applyingChanges: true,
    });
  });

  it.each(["same failure", "new failure"])("preserves a newer notice with text %s", (next) => {
    useWorkspaceStore.getState().setMessage("same failure");
    const old = useWorkspaceStore.getState().messageRevision;
    useWorkspaceStore.getState().dismissMessage(old);
    useWorkspaceStore.getState().setMessage(next);
    useWorkspaceStore.getState().dismissMessage(old);
    expect(useWorkspaceStore.getState()).toMatchObject({ message: next, messageDismissed: false });
    expect(useWorkspaceStore.getState().messageRevision).toBeGreaterThan(old);
  });

  it("does not reopen a dismissed error when another source conditionally leaves it unchanged", () => {
    useWorkspaceStore.getState().setMessage("workspace error");
    const before = useWorkspaceStore.getState().messageRevision;
    useWorkspaceStore.getState().dismissMessage(before);
    useWorkspaceStore
      .getState()
      .setMessage((current) => (current === "runtime error" ? "" : current));
    expect(useWorkspaceStore.getState()).toMatchObject({
      message: "workspace error",
      messageRevision: before,
      messageDismissed: true,
    });
  });

  it("invalidates old dismiss callbacks when the workspace is reset", () => {
    useWorkspaceStore.getState().setMessage("old");
    const old = useWorkspaceStore.getState().messageRevision;
    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().setMessage("new");
    useWorkspaceStore.getState().dismissMessage(old);
    expect(useWorkspaceStore.getState()).toMatchObject({ message: "new", messageDismissed: false });
  });
});

describe("workspace change plans and drafts", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("keeps the acknowledged disk separate from the original dirty-draft baseline through further edits and reset", () => {
    const baseline = JSON.stringify(manifest("original"));
    const disk = JSON.stringify(manifest("external update already reviewed"));
    const draft = manifest("unsaved draft");
    useWorkspaceStore.getState().cacheWorkspaceDraft(workspace.id, draft, baseline, disk);
    expect(useWorkspaceStore.getState().workspaceDraftBaselines[workspace.id]).toBe(baseline);
    expect(useWorkspaceStore.getState().workspaceDraftDisks[workspace.id]).toBe(disk);
    const edited = manifest("more unsaved edits");
    useWorkspaceStore.getState().cacheWorkspaceDraft(workspace.id, edited, baseline);
    expect(useWorkspaceStore.getState().workspaceDraftDisks[workspace.id]).toBe(disk);
    useWorkspaceStore.getState().resetWorkspace();
    expect(useWorkspaceStore.getState().workspaceDrafts[workspace.id]).toBe(edited);
    expect(useWorkspaceStore.getState().workspaceDraftDisks[workspace.id]).toBe(disk);
  });

  it("removes acknowledged disks only for cleaned, discarded or removed drafts", () => {
    const baseline = manifest("original");
    const snapshot = JSON.stringify(baseline);
    const draft = manifest("unsaved");
    for (const id of [workspace.id, "clean", "removed", "retained"]) {
      useWorkspaceStore.getState().cacheWorkspaceDraft(id, draft, snapshot, `disk-${id}`);
    }
    useWorkspaceStore.getState().cacheWorkspaceDraft("clean", baseline, snapshot);
    expect(useWorkspaceStore.getState().workspaceDraftDisks.clean).toBeUndefined();
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      manifest: draft,
      baselineManifest: snapshot,
    });
    expect(useWorkspaceStore.getState().discardWorkspaceDraft(JSON.stringify(draft))).toBe(true);
    expect(useWorkspaceStore.getState().workspaceDraftDisks[workspace.id]).toBeUndefined();
    useWorkspaceStore.getState().setWorkspaceDrafts({ retained: draft });
    expect(useWorkspaceStore.getState().workspaceDraftDisks).toEqual({ retained: "disk-retained" });
    useWorkspaceStore.getState().setWorkspaceDrafts({});
    expect(useWorkspaceStore.getState().workspaceDraftDisks).toEqual({});
  });

  it("acknowledges the actual applied disk when an unrelated editor draft survives apply", () => {
    const baseline = JSON.stringify(manifest("original"));
    const draft = manifest("unrelated unsaved edit");
    const applied = manifest("doctor update");
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      manifest: draft,
      baselineManifest: baseline,
    });
    useWorkspaceStore.getState().cacheWorkspaceDraft(workspace.id, draft, baseline, "older disk");
    useWorkspaceStore.getState().acceptAppliedManifest(applied);
    expect(useWorkspaceStore.getState().workspaceDraftDisks[workspace.id]).toBe(
      JSON.stringify(applied),
    );
  });

  it.each([
    ["doctor", true],
    ["doctor", false],
    ["handoff", true],
    ["handoff", false],
    ["handoff-setup", true],
    ["handoff-setup", false],
  ] satisfies Array<[ChangeSetOrigin, boolean]>)(
    "preserves the dirty draft after a %s plan with a recorded input of %s",
    (origin, recordInput) => {
      const baseline = manifest("saved instructions");
      const draft = manifest("unsaved editor instructions");
      const applied = manifest("instructions reloaded after applying the plan");
      const otherDraft = manifest("another workspace's unsaved instructions");
      useWorkspaceStore.setState({
        selectedWorkspace: workspace,
        manifest: draft,
        baselineManifest: JSON.stringify(baseline),
        workspaceDrafts: { [workspace.id]: manifest("older draft"), other: otherDraft },
        changeSetOrigin: origin,
      });
      useWorkspaceStore.getState().setChangeSet(plan, recordInput ? baseline : undefined);

      useWorkspaceStore
        .getState()
        .acceptAppliedManifest(
          applied,
          useWorkspaceStore.getState().changeSetManifest,
          JSON.stringify(draft),
        );

      const state = useWorkspaceStore.getState();
      expect(state.manifest).toBe(draft);
      expect(state.baselineManifest).toBe(JSON.stringify(applied));
      expect(state.workspaceDrafts).toEqual({ [workspace.id]: draft, other: otherDraft });
      expect(state.workspaceDrafts.other).toBe(otherDraft);
    },
  );

  it("consumes an applied standard draft and removes only its workspace's cached draft", () => {
    const baseline = manifest("saved instructions");
    const draft = manifest("planned editor instructions");
    const applied = manifest("planned editor instructions");
    const otherDraft = manifest("another workspace's unsaved instructions");
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      manifest: draft,
      baselineManifest: JSON.stringify(baseline),
      workspaceDrafts: { [workspace.id]: manifest("older cached draft"), other: otherDraft },
    });
    useWorkspaceStore.getState().setChangeSet(plan, draft);

    useWorkspaceStore
      .getState()
      .acceptAppliedManifest(
        applied,
        useWorkspaceStore.getState().changeSetManifest,
        JSON.stringify(draft),
      );

    const state = useWorkspaceStore.getState();
    expect(state.manifest).toBe(applied);
    expect(state.baselineManifest).toBe(JSON.stringify(applied));
    expect(state.workspaceDrafts).toEqual({ other: otherDraft });
    expect(state.workspaceDrafts.other).toBe(otherDraft);
  });

  it("keeps edits made while an applied plan is reloading its manifest", () => {
    const baseline = manifest("saved instructions");
    const planned = manifest("planned editor instructions");
    const editedDuringReload = manifest("newer instructions typed during reload");
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      manifest: planned,
      baselineManifest: JSON.stringify(baseline),
    });
    useWorkspaceStore.getState().setChangeSet(plan, planned);
    const appliedInput = useWorkspaceStore.getState().changeSetManifest;

    useWorkspaceStore.getState().setManifest(editedDuringReload);
    useWorkspaceStore
      .getState()
      .acceptAppliedManifest(
        manifest("planned editor instructions"),
        appliedInput,
        JSON.stringify(planned),
      );

    const state = useWorkspaceStore.getState();
    expect(state.manifest).toBe(editedDuringReload);
    expect(state.baselineManifest).toBe(JSON.stringify(planned));
    expect(state.workspaceDrafts[workspace.id]).toBe(editedDuringReload);
    expect(state.changeSet).toBe(plan);
    expect(state.changeSetInvalidated).toBe(true);
  });

  it.each(["standard", "doctor"] as const)(
    "preserves a revert to the old baseline while a %s plan is applying",
    (origin) => {
      const baseline = manifest("saved instructions");
      const draft = manifest("unsaved editor instructions");
      const plannedInput = origin === "standard" ? draft : baseline;
      const applied = origin === "standard" ? draft : manifest("repaired instructions");
      useWorkspaceStore.setState({
        selectedWorkspace: workspace,
        manifest: draft,
        baselineManifest: JSON.stringify(baseline),
        changeSetOrigin: origin,
      });
      useWorkspaceStore.getState().setChangeSet(plan, plannedInput);
      const appliedInput = useWorkspaceStore.getState().changeSetManifest;
      const draftAtApply = JSON.stringify(draft);

      useWorkspaceStore.getState().setManifest(baseline);
      useWorkspaceStore.getState().acceptAppliedManifest(applied, appliedInput, draftAtApply);

      const state = useWorkspaceStore.getState();
      expect(state.manifest).toBe(baseline);
      expect(state.baselineManifest).toBe(JSON.stringify(applied));
      expect(state.workspaceDrafts[workspace.id]).toBe(baseline);
    },
  );

  it("accepts a changed disk manifest when the editor has no unsaved changes", () => {
    const baseline = manifest("saved instructions");
    const applied = manifest("repaired instructions");
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      manifest: baseline,
      baselineManifest: JSON.stringify(baseline),
      workspaceDrafts: { [workspace.id]: manifest("stale draft") },
    });

    useWorkspaceStore.getState().acceptAppliedManifest(applied);

    const state = useWorkspaceStore.getState();
    expect(state.manifest).toBe(applied);
    expect(state.baselineManifest).toBe(JSON.stringify(applied));
    expect(state.workspaceDrafts).toEqual({});
  });

  it.each(["value", "updater"] as const)(
    "keeps a read-only stale plan and clears its launch request when the draft changes through a %s",
    (updateKind) => {
      const draft = manifest("planned instructions");
      const nextDraft = manifest("newer instructions");
      useWorkspaceStore.getState().setManifest(draft);
      useWorkspaceStore.getState().setChangeSet(plan, draft);
      useWorkspaceStore.getState().setHandoffLaunchRequest(launchRequest);

      useWorkspaceStore
        .getState()
        .setManifest(updateKind === "value" ? nextDraft : () => nextDraft);

      const state = useWorkspaceStore.getState();
      expect(state.manifest).toBe(nextDraft);
      expect(state.changeSet).toBe(plan);
      expect(state.changeSetManifest).toBe(JSON.stringify(draft));
      expect(state.changeSetInvalidated).toBe(true);
      expect(state.handoffLaunchRequest).toBeUndefined();
    },
  );

  it("clears stale and disk-conflict markers only when a new plan is accepted", () => {
    useWorkspaceStore.getState().setChangeSet(plan, manifest("planned"));
    useWorkspaceStore.getState().setChangeSetConflict(true);
    useWorkspaceStore.getState().setChangeSetInvalidated(true);
    useWorkspaceStore.getState().setChangeSet({ ...plan, id: "regenerated" }, manifest("new"));
    expect(useWorkspaceStore.getState()).toMatchObject({
      changeSetConflict: false,
      changeSetInvalidated: false,
    });
  });

  it("does not discard a draft while a plan is being generated and resets its lock on leaving", () => {
    const draft = manifest("draft");
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      manifest: draft,
      baselineManifest: JSON.stringify(manifest("saved")),
      planningChanges: true,
    });
    expect(useWorkspaceStore.getState().discardWorkspaceDraft(JSON.stringify(draft))).toBe(false);
    useWorkspaceStore.getState().resetWorkspace();
    expect(useWorkspaceStore.getState().planningChanges).toBe(false);
  });

  it("does not let an old planning cleanup release a newer workspace operation", () => {
    const first = useWorkspaceStore.getState().setPlanningChanges(true);
    useWorkspaceStore.getState().resetWorkspace();
    const second = useWorkspaceStore.getState().setPlanningChanges(true);
    useWorkspaceStore.getState().finishPlanningChanges(first);
    expect(useWorkspaceStore.getState().planningChanges).toBe(true);
    useWorkspaceStore.getState().finishPlanningChanges(second);
    expect(useWorkspaceStore.getState().planningChanges).toBe(false);
  });

  it("retains the plan and launch request when a new manifest object has identical contents", () => {
    const draft = manifest("planned instructions");
    useWorkspaceStore.getState().setManifest(draft);
    useWorkspaceStore.getState().setChangeSet(plan, draft);
    useWorkspaceStore.getState().setHandoffLaunchRequest(launchRequest);
    const equivalent = { ...draft, instructions: { ...draft.instructions } };

    useWorkspaceStore.getState().setManifest(() => equivalent);

    const state = useWorkspaceStore.getState();
    expect(state.manifest).toBe(equivalent);
    expect(state.changeSet).toBe(plan);
    expect(state.changeSetManifest).toBe(JSON.stringify(draft));
    expect(state.handoffLaunchRequest).toBe(launchRequest);
  });

  it("retains an unresolved native import recovery request without a pending plan", () => {
    useWorkspaceStore.getState().setManifest(manifest("saved instructions"));
    useWorkspaceStore.getState().setHandoffLaunchRequest(launchRequest);

    useWorkspaceStore.getState().setManifest(manifest("new editor instructions"));

    const state = useWorkspaceStore.getState();
    expect(state.changeSet).toBeUndefined();
    expect(state.handoffLaunchRequest).toBe(launchRequest);
  });

  it.each<ChangeSetOrigin>(["doctor", "handoff", "handoff-setup"])(
    "keeps an independent %s plan through editing and discarding a draft",
    (origin) => {
      const baseline = manifest("saved");
      const draft = manifest("editor draft");
      useWorkspaceStore.setState({
        selectedWorkspace: workspace,
        manifest: baseline,
        baselineManifest: JSON.stringify(baseline),
        changeSetOrigin: origin,
      });
      useWorkspaceStore.getState().setChangeSet(plan, baseline);
      useWorkspaceStore.getState().setHandoffLaunchRequest(launchRequest);
      useWorkspaceStore.getState().setManifest(draft);
      expect(useWorkspaceStore.getState().changeSet).toBe(plan);
      expect(useWorkspaceStore.getState().discardWorkspaceDraft(JSON.stringify(draft))).toBe(true);
      expect(useWorkspaceStore.getState()).toMatchObject({
        changeSet: plan,
        changeSetManifest: JSON.stringify(baseline),
        changeSetOrigin: origin,
        handoffLaunchRequest: launchRequest,
        manifest: baseline,
      });
    },
  );

  it("clears the applied snapshot when a new plan replaces it, but not when clearing a completed plan", () => {
    const appliedChanges = {
      workspaceId: workspace.id,
      project: workspace.path,
      changeSet: plan,
      applied: ["AGENTS.md"],
      backupDir: "/backup",
    };
    useWorkspaceStore.setState({ changeSet: plan, appliedChanges });
    useWorkspaceStore.getState().setChangeSet(undefined);
    expect(useWorkspaceStore.getState().appliedChanges).toBe(appliedChanges);
    useWorkspaceStore.getState().setChangeSet({ ...plan, id: "new" });
    expect(useWorkspaceStore.getState().appliedChanges).toBeUndefined();
  });

  it("snapshots the actual planning input even when it differs from the editor draft", () => {
    const draft = manifest("unsaved editor instructions");
    const actualInput = manifest("saved instructions used by Doctor");
    const actualSnapshot = JSON.stringify(actualInput);
    useWorkspaceStore.getState().setManifest(draft);

    useWorkspaceStore.getState().setChangeSet(plan, actualInput);
    actualInput.instructions.shared = "later mutation of the planning input";

    const state = useWorkspaceStore.getState();
    expect(state.manifest).toBe(draft);
    expect(state.changeSet).toBe(plan);
    expect(state.changeSetManifest).toBe(actualSnapshot);
    expect(state.changeSetManifest).not.toBe(JSON.stringify(draft));
  });

  it("does not assign the editor draft as an input for a plan without a recorded manifest", () => {
    const draft = manifest("unsaved editor instructions");
    useWorkspaceStore.getState().setManifest(draft);
    useWorkspaceStore.getState().setChangeSet(plan, draft);

    useWorkspaceStore.getState().setChangeSet({ ...plan, id: "plan-without-input" });

    expect(useWorkspaceStore.getState().changeSetManifest).toBeUndefined();
  });

  it("discards the reviewed draft, stale plan and only its workspace's cache atomically", () => {
    const baseline = manifest("saved instructions");
    const draft = manifest("unsaved edit");
    const otherDraft = manifest("other workspace");
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      manifest: draft,
      baselineManifest: JSON.stringify(baseline),
      workspaceDrafts: { [workspace.id]: draft, other: otherDraft },
    });
    useWorkspaceStore.getState().setChangeSet(plan, draft);
    useWorkspaceStore.getState().setHandoffLaunchRequest(launchRequest);

    expect(useWorkspaceStore.getState().discardWorkspaceDraft(JSON.stringify(draft))).toBe(true);

    const state = useWorkspaceStore.getState();
    expect(state.manifest).toEqual(baseline);
    expect(state.workspaceDrafts).toEqual({ other: otherDraft });
    expect(state.changeSet).toBeUndefined();
    expect(state.changeSetManifest).toBeUndefined();
    expect(state.handoffLaunchRequest).toBeUndefined();
  });

  it("does not discard newer edits or mutate drafts while applying", () => {
    const baseline = manifest("saved");
    const draft = manifest("confirmed draft");
    const newer = manifest("newer draft");
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      manifest: newer,
      baselineManifest: JSON.stringify(baseline),
    });
    expect(useWorkspaceStore.getState().discardWorkspaceDraft(JSON.stringify(draft))).toBe(false);
    expect(useWorkspaceStore.getState().manifest).toBe(newer);
    useWorkspaceStore.getState().setApplyingChanges(true);
    expect(useWorkspaceStore.getState().discardWorkspaceDraft(JSON.stringify(newer))).toBe(false);
    expect(useWorkspaceStore.getState().manifest).toBe(newer);
  });

  it("retains an unknown import recovery request when discarding an unrelated draft", () => {
    const baseline = manifest("saved");
    const draft = manifest("editor draft");
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      manifest: draft,
      baselineManifest: JSON.stringify(baseline),
      handoffLaunchRequest: launchRequest,
    });
    expect(useWorkspaceStore.getState().discardWorkspaceDraft(JSON.stringify(draft))).toBe(true);
    expect(useWorkspaceStore.getState().handoffLaunchRequest).toBe(launchRequest);
  });

  it.each(["invalid JSON", "null", "{}"])(
    "does not replace a draft with an invalid baseline: %s",
    (baseline) => {
      const draft = manifest("unsaved");
      useWorkspaceStore.setState({
        selectedWorkspace: workspace,
        manifest: draft,
        baselineManifest: baseline,
      });
      expect(useWorkspaceStore.getState().discardWorkspaceDraft(JSON.stringify(draft))).toBe(false);
      expect(useWorkspaceStore.getState().manifest).toBe(draft);
    },
  );

  it("counts changed draft sections rather than implying a count of files", () => {
    const baseline = manifest("saved");
    const draft = {
      ...manifest("edit"),
      skills: [{ name: "new skill", path: "skills/new", targets: [] }],
    };
    expect(draftSectionCount(draft, JSON.stringify(baseline))).toBe(2);
    expect(draftSectionCount(baseline, JSON.stringify(baseline))).toBe(0);
  });
});

describe("refreshing external manifest edits", () => {
  const baseline = manifest("saved");
  const disk = manifest("external update");
  const draft = manifest("unsaved draft");
  it("adopts external edits when the in-memory manifest matches its old baseline", async () => {
    const result = await resolveRefreshedManifest({
      initialManifest: baseline,
      initialBaseline: JSON.stringify(baseline),
      diskManifest: disk,
      getCurrentManifest: () => baseline,
      confirmDiskVersion: () => {
        throw new Error("clean editor must not prompt");
      },
    });
    expect(result).toBe(disk);
  });
  it.each([true, false])(
    "lets a user resolve a disk/draft conflict (load disk: %s)",
    async (loadDisk) => {
      let asked = false;
      const result = await resolveRefreshedManifest({
        initialManifest: draft,
        initialBaseline: JSON.stringify(baseline),
        diskManifest: disk,
        getCurrentManifest: () => draft,
        confirmDiskVersion: async () => {
          asked = true;
          return loadDisk;
        },
      });
      expect(asked).toBe(true);
      expect(result).toBe(loadDisk ? disk : draft);
    },
  );
  it("preserves edits made while the conflict dialog is open", async () => {
    let current = draft;
    const newer = manifest("typed while confirming");
    const result = await resolveRefreshedManifest({
      initialManifest: draft,
      initialBaseline: JSON.stringify(baseline),
      diskManifest: disk,
      getCurrentManifest: () => current,
      confirmDiskVersion: async () => {
        current = newer;
        return true;
      },
    });
    expect(result).toBe(newer);
  });
  it("keeps a cached draft when no previous disk baseline is available", async () => {
    expect(
      await resolveRefreshedManifest({
        initialBaseline: "",
        cachedDraft: draft,
        diskManifest: disk,
        getCurrentManifest: () => undefined,
        confirmDiskVersion: async () => {
          throw new Error("unknown baseline");
        },
      }),
    ).toBe(draft);
  });
});
