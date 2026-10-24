import { create } from "zustand";
import type {
  ChangeSet,
  Manifest,
  DoctorIssue,
  SessionHandoffLaunchRequest,
  WorkspaceScan,
  WorkspaceSummary,
} from "@/core/types";

export type ChangeSetOrigin = "standard" | "doctor" | "handoff" | "handoff-setup";
export interface AppliedWorkspaceChanges {
  workspaceId: string;
  project: string;
  changeSet: ChangeSet;
  applied: string[];
  backupDir: string;
  origin?: ChangeSetOrigin;
  plannedManifest?: string;
  baselineManifest?: string;
  diagnosis?: {
    status: "checking" | "complete" | "failed";
    resolved?: number;
    remaining?: number;
    issues: DoctorIssue[];
  };
}
type Updater<T> = T | ((current: T) => T);

interface WorkspaceState {
  project: string;
  selectedWorkspace?: WorkspaceSummary;
  scan?: WorkspaceScan;
  manifest?: Manifest;
  changeSet?: ChangeSet;
  changeSetManifest?: string;
  changeSetImportWarning?: boolean;
  changeSetIncludesHome: boolean;
  changeSetInvalidated: boolean;
  changeSetConflict: boolean;
  planningChanges: boolean;
  planningRevision: number;
  changeSetOrigin: ChangeSetOrigin;
  handoffLaunchRequest?: SessionHandoffLaunchRequest;
  handoffRecoveryChanges?: Pick<AppliedWorkspaceChanges, "workspaceId" | "project" | "changeSet">;
  baselineManifest: string;
  workspaceDrafts: Record<string, Manifest>;
  workspaceDraftBaselines: Record<string, string>;
  workspaceDraftDisks: Record<string, string>;
  busy: boolean;
  message: string;
  messageRevision: number;
  messageDismissed: boolean;
  applyingChanges: boolean;
  appliedChanges?: AppliedWorkspaceChanges;
}

interface WorkspaceActions {
  setProject: (value: Updater<string>) => void;
  setSelectedWorkspace: (value: Updater<WorkspaceSummary | undefined>) => void;
  setScan: (value: Updater<WorkspaceScan | undefined>) => void;
  setManifest: (value: Updater<Manifest | undefined>) => void;
  setChangeSet: (
    value: Updater<ChangeSet | undefined>,
    plannedManifest?: Manifest,
    includesHome?: boolean,
    literalImportWarning?: boolean,
  ) => void;
  acceptAppliedManifest: (
    manifest: Manifest,
    plannedManifest?: string,
    draftAtApply?: string,
  ) => void;
  setChangeSetOrigin: (value: Updater<ChangeSetOrigin>) => void;
  setHandoffLaunchRequest: (value: Updater<SessionHandoffLaunchRequest | undefined>) => void;
  setHandoffRecoveryChanges: (value: WorkspaceState["handoffRecoveryChanges"]) => void;
  setBaselineManifest: (value: Updater<string>) => void;
  setWorkspaceDrafts: (value: Updater<Record<string, Manifest>>) => void;
  cacheWorkspaceDraft: (
    workspaceId: string,
    manifest: Manifest | undefined,
    baseline: string,
    diskSnapshot?: string,
  ) => void;
  setBusy: (value: Updater<boolean>) => void;
  setMessage: (value: Updater<string>) => void;
  dismissMessage: (revision: number) => void;
  setPlanningChanges: (value: boolean) => number;
  finishPlanningChanges: (revision: number) => void;
  setChangeSetInvalidated: (value: boolean) => void;
  setChangeSetConflict: (value: boolean) => void;
  setApplyingChanges: (value: Updater<boolean>) => void;
  setAppliedChanges: (value: AppliedWorkspaceChanges | undefined) => void;
  discardWorkspaceDraft: (expectedManifest: string) => boolean;
  resetWorkspace: () => void;
}

const resolve = <T>(value: Updater<T>, current: T): T =>
  typeof value === "function" ? (value as (current: T) => T)(current) : value;

function cachedDraftState(
  state: WorkspaceState,
  workspaceId: string,
  manifest: Manifest | undefined,
  baseline: string,
  diskSnapshot?: string,
) {
  const workspaceDrafts = { ...state.workspaceDrafts };
  const workspaceDraftBaselines = { ...state.workspaceDraftBaselines };
  const workspaceDraftDisks = { ...state.workspaceDraftDisks };
  if (manifest && JSON.stringify(manifest) !== baseline) {
    workspaceDrafts[workspaceId] = manifest;
    if (baseline) workspaceDraftBaselines[workspaceId] = baseline;
    else delete workspaceDraftBaselines[workspaceId];
    if (diskSnapshot !== undefined) workspaceDraftDisks[workspaceId] = diskSnapshot;
  } else {
    delete workspaceDrafts[workspaceId];
    delete workspaceDraftBaselines[workspaceId];
    delete workspaceDraftDisks[workspaceId];
  }
  return { workspaceDrafts, workspaceDraftBaselines, workspaceDraftDisks };
}

export const useWorkspaceStore = create<WorkspaceState & WorkspaceActions>((set) => ({
  project: "",
  changeSetOrigin: "standard",
  changeSetIncludesHome: false,
  changeSetInvalidated: false,
  changeSetConflict: false,
  planningChanges: false,
  planningRevision: 0,
  baselineManifest: "",
  workspaceDrafts: {},
  workspaceDraftBaselines: {},
  workspaceDraftDisks: {},
  busy: false,
  message: "",
  messageRevision: 0,
  messageDismissed: false,
  applyingChanges: false,
  setProject: (value) => set((state) => ({ project: resolve(value, state.project) })),
  setSelectedWorkspace: (value) =>
    set((state) => ({ selectedWorkspace: resolve(value, state.selectedWorkspace) })),
  setScan: (value) => set((state) => ({ scan: resolve(value, state.scan) })),
  setManifest: (value) =>
    set((state) => {
      const manifest = resolve(value, state.manifest);
      if (
        state.changeSet &&
        state.changeSetOrigin === "standard" &&
        JSON.stringify(manifest) !== JSON.stringify(state.manifest)
      ) {
        return {
          manifest,
          changeSetInvalidated: true,
          handoffLaunchRequest: undefined,
          handoffRecoveryChanges: undefined,
        };
      }
      return { manifest };
    }),
  setChangeSet: (value, plannedManifest, includesHome = false, literalImportWarning) =>
    set((state) => {
      const changeSet = resolve(value, state.changeSet);
      return {
        changeSet,
        changeSetImportWarning: changeSet ? literalImportWarning : undefined,
        changeSetInvalidated: false,
        changeSetConflict: false,
        changeSetManifest: plannedManifest ? JSON.stringify(plannedManifest) : undefined,
        changeSetIncludesHome: includesHome,
        ...(changeSet && changeSet !== state.changeSet
          ? { appliedChanges: undefined, handoffRecoveryChanges: undefined }
          : {}),
      };
    }),
  acceptAppliedManifest: (diskManifest, plannedManifest, draftAtApply) =>
    set((state) => {
      const baselineManifest = JSON.stringify(diskManifest);
      const currentManifest = JSON.stringify(state.manifest);
      // Doctor and handoff plans may not include the editor's draft. Edits made
      // during apply also count, including a revert to the previous disk baseline.
      const preserveDraft =
        state.manifest &&
        ((draftAtApply !== undefined && currentManifest !== draftAtApply) ||
          (currentManifest !== state.baselineManifest && currentManifest !== plannedManifest));
      const manifest = preserveDraft && state.manifest ? state.manifest : diskManifest;
      return {
        manifest,
        baselineManifest,
        ...(state.selectedWorkspace
          ? cachedDraftState(
              state,
              state.selectedWorkspace.id,
              manifest,
              baselineManifest,
              baselineManifest,
            )
          : {}),
      };
    }),
  setChangeSetOrigin: (value) =>
    set((state) => ({ changeSetOrigin: resolve(value, state.changeSetOrigin) })),
  setHandoffLaunchRequest: (value) =>
    set((state) => {
      const handoffLaunchRequest = resolve(value, state.handoffLaunchRequest);
      return {
        handoffLaunchRequest,
        ...(!handoffLaunchRequest || handoffLaunchRequest !== state.handoffLaunchRequest
          ? { handoffRecoveryChanges: undefined }
          : {}),
      };
    }),
  setHandoffRecoveryChanges: (handoffRecoveryChanges) => set({ handoffRecoveryChanges }),
  setBaselineManifest: (value) =>
    set((state) => ({ baselineManifest: resolve(value, state.baselineManifest) })),
  setWorkspaceDrafts: (value) =>
    set((state) => {
      const workspaceDrafts = resolve(value, state.workspaceDrafts);
      const workspaceDraftBaselines = Object.fromEntries(
        Object.entries(state.workspaceDraftBaselines).filter(([id]) => id in workspaceDrafts),
      );
      const workspaceDraftDisks = Object.fromEntries(
        Object.entries(state.workspaceDraftDisks).filter(([id]) => id in workspaceDrafts),
      );
      return { workspaceDrafts, workspaceDraftBaselines, workspaceDraftDisks };
    }),
  cacheWorkspaceDraft: (workspaceId, manifest, baseline, diskSnapshot) =>
    set((state) => cachedDraftState(state, workspaceId, manifest, baseline, diskSnapshot)),
  setBusy: (value) => set((state) => ({ busy: resolve(value, state.busy) })),
  setMessage: (value) =>
    set((state) => {
      const message = resolve(value, state.message);
      // Conditional recovery that leaves another error intact is not a new notice.
      if (typeof value === "function" && message === state.message) return state;
      return { message, messageRevision: state.messageRevision + 1, messageDismissed: false };
    }),
  dismissMessage: (revision) =>
    set((state) => (state.messageRevision === revision ? { messageDismissed: true } : state)),
  setPlanningChanges: (planningChanges) => {
    let revision = 0;
    set((state) => {
      revision = state.planningRevision + 1;
      return { planningChanges, planningRevision: revision };
    });
    return revision;
  },
  finishPlanningChanges: (revision) =>
    set((state) => (state.planningRevision === revision ? { planningChanges: false } : state)),
  setChangeSetInvalidated: (changeSetInvalidated) => set({ changeSetInvalidated }),
  setChangeSetConflict: (changeSetConflict) => set({ changeSetConflict }),
  setApplyingChanges: (value) =>
    set((state) => ({ applyingChanges: resolve(value, state.applyingChanges) })),
  setAppliedChanges: (appliedChanges) => set({ appliedChanges }),
  discardWorkspaceDraft: (expectedManifest) => {
    let discarded = false;
    set((state) => {
      if (
        state.busy ||
        state.planningChanges ||
        state.applyingChanges ||
        !state.selectedWorkspace ||
        !state.manifest ||
        !state.baselineManifest ||
        JSON.stringify(state.manifest) !== expectedManifest
      )
        return state;
      let manifest: Manifest;
      try {
        // The baseline is the JSON snapshot of the manifest loaded by the workspace loaders.
        manifest = JSON.parse(state.baselineManifest) as Manifest;
      } catch {
        return state;
      }
      if (
        !manifest ||
        typeof manifest !== "object" ||
        !manifest.instructions ||
        !manifest.workspace ||
        !Array.isArray(manifest.skills) ||
        !Array.isArray(manifest.connections)
      )
        return state;
      discarded = true;
      return {
        manifest,
        ...cachedDraftState(state, state.selectedWorkspace.id, manifest, state.baselineManifest),
        ...(state.changeSetOrigin === "standard"
          ? {
              changeSet: undefined,
              changeSetManifest: undefined,
              changeSetImportWarning: undefined,
              changeSetIncludesHome: false,
              // A completed/unknown import still needs its recovery request.
              handoffLaunchRequest: state.changeSet ? undefined : state.handoffLaunchRequest,
              handoffRecoveryChanges: state.changeSet ? undefined : state.handoffRecoveryChanges,
            }
          : {}),
      };
    });
    return discarded;
  },
  resetWorkspace: () =>
    set((state) => ({
      project: "",
      selectedWorkspace: undefined,
      scan: undefined,
      manifest: undefined,
      changeSet: undefined,
      changeSetManifest: undefined,
      changeSetImportWarning: undefined,
      changeSetIncludesHome: false,
      changeSetInvalidated: false,
      changeSetConflict: false,
      planningChanges: false,
      planningRevision: state.planningRevision + 1,
      changeSetOrigin: "standard",
      handoffLaunchRequest: undefined,
      handoffRecoveryChanges: undefined,
      baselineManifest: "",
      busy: false,
      message: "",
      messageRevision: state.messageRevision + 1,
      messageDismissed: false,
      applyingChanges: false,
      appliedChanges: undefined,
    })),
}));
