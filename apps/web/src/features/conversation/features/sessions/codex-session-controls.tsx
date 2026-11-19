import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useState,
  useRef,
  type ReactNode,
  type Ref,
} from "react";
import { X } from "lucide-react";
import {
  ApiError,
  canDisplayCodexModelFallback,
  forgetSessionModelDisplay,
  managedAgentOf,
  sessionProviderCapabilities,
  type SessionAction,
  type CodexContextOptions,
  type CodexContextResource,
  type CodexGoalState,
  type CodexSessionSettings,
} from "@agentkib/web-client";
import {
  ComposerGoalFields,
  ComposerModelPicker,
  SessionComposerToolbar,
  composerGoalCopy,
  parseGoalDraft,
  existingSessionComposerCapabilities,
  runComposerSettingsMutation,
  type ComposerMutationFields,
  composerSettingsSelection,
  projectComposerSettingsControls,
  mergePreparedCatalog,
  prepareComposerSettings,
  composerSettingsWriteLocked,
  useComposerModelPanel,
  useComposerModelDisplay,
  confirmsComposerSettings,
  type PendingComposerSettings,
  useComposerFollowerSettings,
  type NewSessionGoalDraft,
} from "@agentkib/session-ui";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/dialog";
import { useSession } from "./session-context";
import { composerLayoutCopy, composerTerm } from "./composer-layout-copy";
import { codexCopyForSurface, codexReason } from "./codex-copy";
import { subscribeSessionInvalidation } from "./session-events";
import { ContextUsageGauge, type ContextUsageHandle } from "./context-usage";
import { sessionAgentCopy } from "./session-agent-copy";

export type CodexResource = CodexContextResource;

/** Opens the relevant composer control when available in the current session. */
export type ComposerControlsHandle = {
  open(panel: "permissions" | "usage" | "models" | "effort" | "goal"): boolean;
  /** Turns plan mode on, as `/plan` does in Codex's composer; false when this session cannot. */
  plan(): boolean;
};
/** Whether plan mode is on, and whether the composer can turn it on. */
export type ComposerPlanState = { on: boolean; available: boolean };

type CodexComposerControlsProps = {
  composerCapabilities?: ReturnType<typeof existingSessionComposerCapabilities>;
  resources: CodexResource[];
  setResources: (resources: CodexResource[]) => void;
  openPhoneFiles: () => void;
  disabled: boolean;
  action?: ReactNode;
  advancedActions?: ReactNode;
  /** Lets the composer route bare commands to their controls. */
  controlsRef?: Ref<ComposerControlsHandle>;
  /** Told when plan mode or the composer's ability to switch it changes. */
  onPlan?: (state: ComposerPlanState) => void;
  startupGoal?: { value: NewSessionGoalDraft; apply: boolean; afterRevision?: number };
  onStageGoal?: (goal: NewSessionGoalDraft) => void;
  onStartupGoalHandled?: (applied: boolean) => void;
  onStartupGoalDiscarded?: () => void;
};

function unavailable(error: unknown) {
  return error instanceof ApiError ? error.code : "request_failed";
}

function modelReadDenied(error: unknown) {
  return error instanceof ApiError && [401, 403, 404, 410].includes(error.status);
}

/** Which goal actions the panel offers: starting one always; with a goal, clearing it and
 * resuming it once stopped or pausing it while active. */
function offersGoalAction(
  goal: { status: string } | undefined,
  action: "set" | "pause" | "resume" | "clear",
) {
  if (action === "set") return true;
  if (!goal) return false;
  if (action === "pause") return goal.status === "active";
  if (action === "resume")
    return ["paused", "blocked", "budgetLimited", "usageLimited", "budget-exhausted"].includes(
      goal.status,
    );
  return true;
}

export function CodexComposerControls({
  composerCapabilities,
  resources,
  setResources,
  openPhoneFiles,
  disabled,
  action,
  advancedActions,
  controlsRef,
  onPlan,
  startupGoal,
  onStageGoal,
  onStartupGoalHandled,
  onStartupGoalDiscarded,
}: CodexComposerControlsProps) {
  const {
    current,
    selected,
    client,
    access,
    locale,
    live,
    busy,
    online,
    controlReady,
    codexAction,
    capabilities,
    usageEpoch,
    notice,
    noticeReason,
    settingsChangedHere,
    settingsNotice,
    settingsOnlyBlocked,
    t,
  } = useSession();
  const copy = codexCopyForSurface(locale, "web");
  const goalCopy = composerGoalCopy(locale);
  const currentAgent =
    current?.id === selected && current.availability === "readable" ? current.agent : undefined;
  const modelDisplayScope = useRef({ access, agent: currentAgent });
  modelDisplayScope.current = { access, agent: currentAgent };
  const isClaude = current?.agent === "claude-code";
  const settingsAgent = managedAgentOf(current?.agent);
  const managedAgent = settingsAgent === "codex" ? null : settingsAgent;
  const isDevin = managedAgent === "devin";
  const agentCopy = sessionAgentCopy[locale];
  const {
    feature,
    settingsReadable,
    canOpenTerminalModel,
    settingsReadOnly,
    terminalModel,
    settingsAccessDenied,
    reservesModelSlot,
    reservesPermissionSlot,
    goalReadable,
    goalDraftOffered,
    goalOffered,
    planOffered,
    resourcesReadable,
    resourcesOffered,
    attachmentOffered,
    attachmentAllowed,
  } =
    composerCapabilities ??
    existingSessionComposerCapabilities({
      access,
      agent: current?.agent,
      currentId: current?.id,
      capabilities,
      sessionId: selected,
      legacyReads: !managedAgent && typeof client.sessionCapabilities !== "function",
    });
  const offersGoalDraft =
    goalDraftOffered && feature("goal-set")?.available !== true && !!onStageGoal;
  const layout = composerLayoutCopy[locale];
  const term = (value: string) => composerTerm(locale, value);
  const reason = (code?: string) => codexReason(locale, code, "web").text;
  const reasonTitle = (code?: string) => (code ? reason(code) : undefined);
  const reasonDetail = (code?: string) => {
    const value = codexReason(locale, code, "web");
    return (
      <div className="text-xs text-muted-foreground">
        {value.text}
        {value.technical && (
          <details className="mt-1">
            <summary>{layout.details}</summary>
            <code className="break-all">{value.technical}</code>
          </details>
        )}
      </div>
    );
  };
  const loadGeneration = useRef(0);
  const loadFlight = useRef<
    | {
        generation: number;
        sections: Set<"settings" | "goal">;
        background: boolean;
        promise: Promise<void>;
      }
    | undefined
  >(undefined);
  const contextGeneration = useRef(0);
  const resourceScope = useRef({
    selected,
    client,
    bootId: access?.bootId,
    deviceId: access?.device?.id,
    advancedControl: access?.device?.advancedControl,
  });
  const contextAbort = useRef<AbortController | undefined>(undefined);
  const resourcesRef = useRef(resources);
  resourcesRef.current = resources;
  const contextLocation = useRef<{ id?: string; names: string[] }>({ names: [] });
  const [contextNames, setContextNames] = useState<string[]>([]);
  const [contextLoading, setContextLoading] = useState(false);
  const modelPanel = useComposerModelPanel();
  const usage = useRef<ContextUsageHandle>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const goalDraftRevision = useRef<number | undefined>(undefined);
  const attemptedStartupGoal = useRef<NewSessionGoalDraft | undefined>(undefined);
  const [goalDirty, setGoalDirty] = useState(false);
  const full = access?.device?.accessMode === "full";
  const [goalDialog, setGoalDialog] = useState<
    { kind: "draft"; objective: string; budget: string } | { kind: "native" }
  >();
  const [settings, setSettings] = useState<CodexSessionSettings>();
  const settingsExecutionScope = JSON.stringify([live?.executionMode, live?.connectionGeneration]);
  const { follower, writeScope, rememberRead, followerAuthority } = useComposerFollowerSettings(
    client,
    access,
    selected,
    live,
  );
  const settingsExecution = useRef<string | undefined>(undefined);
  const settingsScopeMatches =
    settings?.sessionId === selected &&
    resourceScope.current.client === client &&
    resourceScope.current.bootId === access?.bootId &&
    resourceScope.current.deviceId === access?.device?.id &&
    resourceScope.current.advancedControl === access?.device?.advancedControl;
  const fallbackProvider = sessionProviderCapabilities(current?.agent);
  const provider = (settingsScopeMatches ? settings?.provider : undefined) ?? fallbackProvider;
  const usesVariants = provider?.models.selection === "variants";
  const canClearEffort = provider?.models.clearEffort ?? isClaude;
  const preparesSettings = provider?.models.prepare === true;
  const [goal, setGoal] = useState<CodexGoalState>();
  const [context, setContext] = useState<CodexContextOptions>();
  const [settingsError, setSettingsError] = useState("");
  const [goalError, setGoalError] = useState("");
  const [contextError, setContextError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [resourceWarning, setResourceWarning] = useState("");
  const [saving, setSaving] = useState(false);
  const mutationFlight = useRef<symbol | undefined>(undefined);
  const changingSettings = useRef(false);
  const [preparingSettings, setPreparingSettings] = useState(false);
  const settingsPreparation = useRef<symbol | undefined>(undefined);
  const settingsReadVersion = useRef(0);
  const preparationAuthority = {
    selected,
    client,
    bootId: access?.bootId,
    deviceId: access?.device?.id,
    full,
    advancedControl: access?.device?.advancedControl,
    accessStatus: access?.status,
    execution: settingsExecutionScope,
    allowed:
      online &&
      settingsReadable &&
      feature("settings")?.available === true &&
      settingsNotice?.status !== "uncertain" &&
      !(settingsChangedHere && settings?.applicationStatus === "unknown") &&
      notice !== "uncertain" &&
      live?.status !== "outcome-unknown" &&
      live?.reason !== "control-outcome-unconfirmed" &&
      capabilities?.reason !== "control-outcome-unconfirmed",
  };
  const currentPreparation = useRef(preparationAuthority);
  currentPreparation.current = preparationAuthority;

  const [pending, setPendingSettings] = useState<PendingComposerSettings>();
  const pendingSettings =
    !pending?.followerAuthority || pending.followerAuthority === followerAuthority
      ? pending
      : undefined;
  const [objective, setObjective] = useState("");
  const [tokenBudget, setTokenBudget] = useState("");
  const compacting = live?.activity === "compacting";
  const running = live?.status !== "idle" || compacting;
  const currentUsageSettings =
    settingsScopeMatches &&
    (provider?.contextUsage !== "last-request" ||
      (!pendingSettings && (live?.revision === undefined || live.revision === settings?.revision)))
      ? settings
      : undefined;
  const usageCapacity =
    (provider?.contextUsage === "last-request" ||
      (currentUsageSettings?.executionMode === "claude-follower" &&
        live?.executionMode === "claude-follower")) &&
    currentUsageSettings?.applicationStatus !== "pending" &&
    currentUsageSettings?.applicationStatus !== "unknown"
      ? currentUsageSettings?.current.maxContextTokens
      : undefined;
  const applySettings = useCallback(
    (value: CodexSessionSettings, fromLive = false) => {
      if (value.sessionId !== selected) return;
      if (!fromLive) rememberRead(value);
      settingsExecution.current = settingsExecutionScope;
      setSettings((previous) => {
        if (!fromLive || previous?.sessionId !== value.sessionId) return value;
        const registered = value.provider ?? previous.provider;
        const source = registered?.contextUsage ?? fallbackProvider?.contextUsage;
        const keepHistory =
          previous.usage?.historical &&
          (source !== "last-request" || previous.revision === value.revision);
        return {
          ...value,
          provider: registered,
          historicalSettings: value.historicalSettings ?? previous.historicalSettings,
          usage: keepHistory ? previous.usage : value.usage,
        };
      });
    },
    [fallbackProvider, rememberRead, selected, settingsExecutionScope],
  );

  const loadContext = useCallback(
    async (directoryId?: string, names: string[] = []) => {
      if (!full || !selected || !online || !resourcesReadable) return;
      contextAbort.current?.abort();
      const abort = new AbortController();
      contextAbort.current = abort;
      const generation = ++contextGeneration.current;
      contextLocation.current = { id: directoryId, names };
      setContextLoading(true);
      setContextError("");
      try {
        const value = managedAgent
          ? await client.sessionResources(selected, managedAgent, directoryId, abort.signal)
          : await client.codexContextOptions(selected, directoryId, abort.signal);
        if (abort.signal.aborted || generation !== contextGeneration.current) return;
        setContext(value);
        setContextNames(names);

        // A directory response is only a partial catalog. Missing references may
        // belong to another folder; the host revalidates every reference on send.
        const current = resourcesRef.current;
        const visible = new Map(value.resources.map((item) => [item.id, item]));
        const next = current.flatMap((item) => {
          const refreshed = visible.get(item.id);
          return !refreshed ? [item] : refreshed.available ? [refreshed] : [];
        });
        if (next.length !== current.length) setResourceWarning(copy.resourceRemoved);
        if (next.some((item, index) => item !== current[index]) || next.length !== current.length)
          setResources(next);
      } catch (error) {
        if (!abort.signal.aborted && generation === contextGeneration.current) {
          if (modelReadDenied(error)) {
            setContext(undefined);
            setContextNames([]);
            contextLocation.current = { names: [] };
          }
          setContextError(unavailable(error));
        }
      } finally {
        if (!abort.signal.aborted && generation === contextGeneration.current)
          setContextLoading(false);
      }
    },
    [
      client,
      copy.resourceRemoved,
      full,
      online,
      selected,
      setResources,
      managedAgent,
      resourcesReadable,
    ],
  );

  useEffect(() => {
    if (resourcesReadable) return;
    contextGeneration.current++;
    contextAbort.current?.abort();
    contextLocation.current = { names: [] };
    setContext(undefined);
    setContextNames([]);
    setContextLoading(false);
    setContextError("");
  }, [resourcesReadable]);

  const load = useCallback(
    (background = false, section?: "settings" | "goal"): Promise<void> => {
      if (!full || !selected) return Promise.resolve();
      const generation = loadGeneration.current;
      const displayScope = modelDisplayScope.current;
      const pending = loadFlight.current;
      const sections = new Set<"settings" | "goal">(section ? [section] : ["settings", "goal"]);
      if (pending?.generation === generation) {
        for (const section of sections) pending.sections.add(section);
        pending.background &&= background;
        return pending.promise;
      }
      const flight = { generation, sections, background, promise: Promise.resolve() };
      flight.promise = (async () => {
        // Initial readiness, an idle revision and domain invalidations can arrive
        // together. Coalesce that batch before reading the affected sections.
        await Promise.resolve();
        while (flight.sections.size && generation === loadGeneration.current) {
          const quiet = flight.background;
          const readSettings = flight.sections.has("settings");
          const readVersion = settingsReadVersion.current;
          const readGoal = flight.sections.has("goal");
          flight.sections.clear();
          flight.background = true;
          const [settingsResult, goalResult] = await Promise.allSettled([
            readSettings && settingsReadable && settingsAgent
              ? client.sessionSettings(selected, settingsAgent)
              : Promise.resolve(undefined),
            readGoal && goalReadable
              ? managedAgent
                ? client.sessionGoals(selected, managedAgent)
                : client.codexGoals(selected)
              : Promise.resolve(undefined),
          ]);
          if (generation !== loadGeneration.current) return;
          if (readSettings) {
            if (
              readVersion === settingsReadVersion.current &&
              settingsResult.status === "fulfilled"
            ) {
              if (settingsResult.value) applySettings(settingsResult.value);
              else if (settingsReadable) setSettings(undefined);
              setSettingsError("");
            } else if (settingsResult.status === "rejected") {
              const denied = modelReadDenied(settingsResult.reason);
              if (denied) {
                forgetSessionModelDisplay(
                  client,
                  displayScope.access,
                  selected,
                  displayScope.agent,
                );
                settingsPreparation.current = undefined;
                setPreparingSettings(false);
              }
              if ((readVersion === settingsReadVersion.current && !quiet) || denied) {
                setSettings(undefined);
                setSettingsError(unavailable(settingsResult.reason));
              }
            }
          }
          if (readGoal) {
            if (goalResult.status === "fulfilled") {
              setGoal(goalResult.value);
              if (goalDraftRevision.current === undefined) {
                setObjective(goalResult.value?.goal?.objective ?? "");
                setTokenBudget(goalResult.value?.goal?.tokenBudget?.toString() ?? "");
              }
              setGoalError("");
            } else if (!quiet) {
              setGoal(undefined);
              setGoalError(unavailable(goalResult.reason));
            }
          }
        }
        if (loadFlight.current === flight) loadFlight.current = undefined;
      })().finally(() => {
        if (loadFlight.current === flight) loadFlight.current = undefined;
      });
      loadFlight.current = flight;
      return flight.promise;
    },
    [
      applySettings,
      client,
      full,
      selected,
      managedAgent,
      settingsAgent,
      settingsReadable,
      goalReadable,
    ],
  );

  useEffect(() => {
    loadGeneration.current++;
    goalDraftRevision.current = undefined;
    attemptedStartupGoal.current = undefined;
    setGoalDirty(false);
    setObjective("");
    setTokenBudget("");
    setSettings(undefined);
    setGoal(undefined);
    setContext(undefined);
    contextGeneration.current++;
    contextAbort.current?.abort();
    contextLocation.current = { names: [] };
    setContextNames([]);
    setContextLoading(false);

    // The composer owns selection resets and may have just restored a fork draft.
    // A host/device replacement still invalidates previously resolved context IDs.
    const previousScope = resourceScope.current;
    if (
      previousScope.selected !== selected ||
      previousScope.client !== client ||
      previousScope.bootId !== access?.bootId ||
      previousScope.deviceId !== access?.device?.id
    )
      setResources([]);
    resourceScope.current = {
      selected,
      client,
      bootId: access?.bootId,
      deviceId: access?.device?.id,
      advancedControl: access?.device?.advancedControl,
    };
    setGoalDialog(undefined);
    setAddOpen(false);
    setSaving(false);

    setPermissionsOpen(false);
    settingsPreparation.current = undefined;
    setPreparingSettings(false);
    setPendingSettings(undefined);
    setSettingsError("");
    setGoalError("");
    setContextError("");
    setMutationError("");
    setResourceWarning("");
    return () => {
      loadGeneration.current++;
      mutationFlight.current = undefined;
      changingSettings.current = false;
      settingsPreparation.current = undefined;
      contextGeneration.current++;
      contextAbort.current?.abort();
    };
  }, [
    selected,
    setResources,
    client,
    access?.bootId,
    access?.device?.id,
    access?.device?.advancedControl,
  ]);

  useEffect(() => {
    if (!full || !selected || !online || usageEpoch === "") {
      contextGeneration.current++;
      contextAbort.current?.abort();
      setContextLoading(false);
      return;
    }
    void load();
    void loadContext(contextLocation.current.id, contextLocation.current.names);
    // Re-read only the selected session after reconnect. Native changes arrive over SSE.
    return () => {
      loadGeneration.current++;
    };
  }, [
    full,
    online,
    selected,
    access?.bootId,
    access?.device?.id,
    access?.device?.advancedControl,
    usageEpoch,
    settingsReadable,
    goalReadable,
    resourcesReadable,
    settingsExecutionScope,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!full || !selected || !online) return;
    return subscribeSessionInvalidation(client, (id, domains) => {
      if (id && id !== selected) return;
      if (domains.some((domain) => ["settings", "goal", "usage", "ownership"].includes(domain)))
        void load(
          true,
          changingSettings.current && !domains.includes("goal") ? "settings" : undefined,
        );
    });
  }, [client, full, load, online, selected]);

  useEffect(() => {
    // Settings and goals use the conversation's CAS revision. An unrelated
    // idle update can advance it without invalidating either domain. Running
    // token revisions do not trigger reads; entering idle calibrates it once.
    if (
      full &&
      online &&
      live?.sessionId === selected &&
      live.status === "idle" &&
      live.revision !== undefined &&
      live.revision !== null
    )
      void load(true, changingSettings.current ? "settings" : undefined);
  }, [full, load, online, selected, live?.sessionId, live?.status, live?.revision]);

  useEffect(() => {
    if (live?.settings?.sessionId === selected) {
      applySettings({ ...live.settings, usage: live.usage ?? live.settings.usage }, true);
    } else if (live?.usage && settings?.sessionId === selected) {
      // The observer takes live usage directly. Keep the HTTP history report available
      // while an idle live snapshot only has a placeholder.
      setSettings((value) =>
        value && !value.usage?.historical ? { ...value, usage: live.usage } : value,
      );
    }
    if (live?.goal && goal?.sessionId === selected)
      setGoal((value) => (value ? { ...value, goal: live.goal } : value));
  }, [applySettings, goal?.sessionId, live, selected, settings?.sessionId]);

  useEffect(() => {
    if (
      !confirmsComposerSettings(settings, pendingSettings, {
        prepared: isClaude,
        variants: usesVariants,
        follower,
      })
    )
      return;
    setPendingSettings(undefined);
  }, [follower, isClaude, pendingSettings, settings, usesVariants]);

  /** Changes the settings or the goal; true once the host accepted the change. */
  function mutate(name: SessionAction, fields: ComposerMutationFields = {}) {
    const changesSettings = name === "settings";
    return runComposerSettingsMutation({
      action: name,
      fields,
      permitted: full && !compacting,
      settingsAllowed:
        !!settings?.available &&
        settingsScopeMatches &&
        settingsNotice?.status !== "uncertain" &&
        !settingsReadStale &&
        (capabilities?.sessionId !== selected || feature("settings")?.available === true),
      readRevision: changesSettings ? settings?.revision : goal?.revision,
      liveRevision: live?.revision,
      follower: follower ? { authority: followerAuthority, writeScope } : undefined,
      flight: mutationFlight,
      loadGeneration,
      send: codexAction,
      onStart: () => {
        changingSettings.current = changesSettings;
        setSaving(true);
        setMutationError("");
      },
      onAccepted: () => {
        if (name === "goal-set" && startupGoal) onStartupGoalHandled?.(true);
      },
      onPendingSettings: setPendingSettings,
      onGoalChanged: () => {
        goalDraftRevision.current = undefined;
        setGoalDirty(false);
      },
      refresh: () => load(false, changesSettings ? "settings" : undefined),
      onError: (error) => setMutationError(unavailable(error)),
      onSettle: () => {
        changingSettings.current = false;
        setSaving(false);
      },
    });
  }

  const settingsReadStale =
    !settingsReadable ||
    (follower && feature("settings")?.available === true && !writeScope) ||
    settingsExecution.current !== settingsExecutionScope ||
    (live?.revision !== undefined && settings?.revision !== live.revision);
  const goalReadStale = live?.revision !== undefined && goal?.revision !== live.revision;
  const closeAdd = () => {
    setAddOpen(false);
  };
  const openGoal = () => {
    closeAdd();
    if (offersGoalDraft || (!goalReadable && startupGoal)) {
      setGoalDialog({
        kind: "draft",
        objective: startupGoal?.value.objective ?? "",
        budget: startupGoal?.value.tokenBudget?.toString() ?? "",
      });
    } else {
      setGoalDialog({ kind: "native" });
      if (goalReadable && goalReadStale) void load();
    }
  };
  const prepareSettings = () => {
    if (!settingsReadable || !online) return;
    if (
      preparesSettings &&
      !running &&
      (!live?.executionMode || live.executionMode === "claude-managed") &&
      prepareComposerSettings({
        currentAuthority: currentPreparation,
        flight: settingsPreparation,
        loadGeneration,
        readVersion: settingsReadVersion,
        revision: live?.revision,
        onStart: () => {
          setPreparingSettings(true);
          setSettingsError("");
        },
        onPrepared: (value, currentRead) => {
          settingsExecution.current = settingsExecutionScope;
          if (currentRead) applySettings(value);
          else
            setSettings((previous) =>
              previous?.sessionId === selected ? mergePreparedCatalog(previous, value) : value,
            );
        },
        onError: (error) => setSettingsError(unavailable(error)),
        onSettle: () => setPreparingSettings(false),
      })
    )
      return;
    if (settingsReadStale || !settings?.available || settingsError) void load(false, "settings");
  };
  const stagedGoal = goalDirty ? undefined : startupGoal?.value;
  const persistedGoal = goal?.sessionId === selected ? goal.goal : undefined;
  const resetGoalEditor = () => {
    goalDraftRevision.current = undefined;
    setGoalDirty(false);
    setObjective(persistedGoal?.objective ?? "");
    setTokenBudget(persistedGoal?.tokenBudget?.toString() ?? "");
  };
  const closeGoal = () => {
    setGoalDialog(undefined);
  };
  const discardStartupGoal = () => {
    if (!onStartupGoalDiscarded || mutationFlight.current) return;
    resetGoalEditor();
    onStartupGoalDiscarded();
  };
  const disarmStartupGoal = () => {
    if (!startupGoal?.apply || attemptedStartupGoal.current === startupGoal.value) return;
    attemptedStartupGoal.current = startupGoal.value;
    onStartupGoalHandled?.(false);
  };
  const goalObjective = stagedGoal?.objective ?? objective;
  const goalBudget = stagedGoal ? (stagedGoal.tokenBudget?.toString() ?? "") : tokenBudget;
  const goalChanged = goalDirty && goalDraftRevision.current !== goal?.revision;
  const editGoal = () => {
    goalDraftRevision.current ??= goal?.revision;
    if (stagedGoal) {
      setObjective(goalObjective);
      setTokenBudget(goalBudget);
      disarmStartupGoal();
    }
    setGoalDirty(true);
  };
  const parsedBudget = goalBudget ? Number(goalBudget) : undefined;
  const budgetValid =
    parsedBudget === undefined || (Number.isSafeInteger(parsedBudget) && parsedBudget > 0);
  const goalDraftEditor = goalDialog?.kind === "draft" ? goalDialog : undefined;
  const goalDraftDisabled =
    !offersGoalDraft ||
    disabled ||
    saving ||
    notice === "uncertain" ||
    live?.status === "outcome-unknown" ||
    live?.reason === "control-outcome-unconfirmed" ||
    capabilities?.reason === "control-outcome-unconfirmed";
  const goalDraft = goalDraftEditor
    ? parseGoalDraft(goalDraftEditor.objective, goalDraftEditor.budget)
    : undefined;
  const saveGoalDraft = () => {
    if (goalDraftDisabled || !goalDraft) return;
    onStageGoal?.(goalDraft);
    closeGoal();
  };
  const goalFields = (fieldsDisabled: boolean, hideBudget: boolean) => (
    <ComposerGoalFields
      locale={locale}
      objective={goalDraftEditor?.objective ?? goalObjective}
      budget={goalDraftEditor?.budget ?? goalBudget}
      disabled={fieldsDisabled}
      hideBudget={hideBudget}
      onObjectiveChange={(value) => {
        if (goalDraftEditor) {
          setGoalDialog({ ...goalDraftEditor, objective: value });
          return;
        }
        editGoal();
        setObjective(value);
      }}
      onBudgetChange={(value) => {
        if (goalDraftEditor) {
          setGoalDialog({ ...goalDraftEditor, budget: value });
          return;
        }
        editGoal();
        setTokenBudget(value);
      }}
    />
  );
  const isCodex = current?.agent === "codex";
  const liveSettings =
    live?.sessionId === selected && live.settings?.sessionId === selected
      ? live.settings
      : undefined;
  const liveSelection = liveSettings && composerSettingsSelection(liveSettings, isClaude);
  const liveReport =
    liveSelection?.modelId || liveSelection?.effort ? liveSelection : liveSettings?.current;
  const scopedSettings = settingsScopeMatches ? settings : undefined;
  const selection =
    scopedSettings &&
    composerSettingsSelection(scopedSettings, isClaude, { live, staged: pendingSettings });
  const pendingModelChange =
    pendingSettings?.model !== undefined ||
    pendingSettings?.effort !== undefined ||
    pendingSettings?.serviceTierId !== undefined ||
    pendingSettings?.restoreDefaults === true;
  const permissionsOnlyPending =
    !pendingModelChange &&
    (pendingSettings?.mode !== undefined ||
      pendingSettings?.policyId !== undefined ||
      pendingSettings?.permissionMode !== undefined ||
      (settingsOnlyBlocked && settingsNotice?.target === "permissions"));
  const modelApplicationPending =
    scopedSettings?.applicationStatus === "pending" &&
    !permissionsOnlyPending &&
    (!isCodex || !canDisplayCodexModelFallback(scopedSettings));
  const reportedSettings =
    (isCodex || !scopedSettings) &&
    !modelApplicationPending &&
    (liveReport?.modelId || liveReport?.effort)
      ? liveReport
      : selection?.modelId || selection?.effort || !isCodex
        ? selection
        : scopedSettings?.current;
  const canShowCodexFallback =
    isCodex &&
    access?.device?.advancedControl === true &&
    !modelApplicationPending &&
    !pendingModelChange &&
    (!live || live.sessionId === selected);
  const fallbackSettings = canShowCodexFallback ? scopedSettings : undefined;
  const historicalSettings = fallbackSettings?.historicalSettings;
  const claudeReadFallbackAllowed =
    isClaude &&
    settingsNotice?.status !== "uncertain" &&
    !(settingsChangedHere && scopedSettings?.applicationStatus === "unknown") &&
    notice !== "uncertain" &&
    live?.status !== "outcome-unknown" &&
    live?.reason !== "control-outcome-unconfirmed" &&
    capabilities?.reason !== "control-outcome-unconfirmed";
  const claudeHistoricalModel = claudeReadFallbackAllowed
    ? scopedSettings?.historicalSettings
    : undefined;
  // Older Codex sessions can show a known model without prefilling the settings form.
  const visibleSettings =
    reportedSettings?.modelId || (!isClaude && reportedSettings?.effort)
      ? reportedSettings
      : claudeHistoricalModel?.modelId
        ? claudeHistoricalModel
        : historicalSettings?.modelId
          ? historicalSettings
          : undefined;
  const { showModelPicker, displayFallback, retainedEffortOptions } = useComposerModelDisplay({
    client,
    access,
    sessionId: selected,
    agent: currentAgent,
    denied: settingsAccessDenied,
    settingsReadable,
    reservesSlot: reservesModelSlot,
    provider,
    catalog: scopedSettings ?? liveSettings,
    observed: visibleSettings,
    historical: reportedSettings?.modelId ? undefined : visibleSettings,
    defaults: claudeReadFallbackAllowed ? scopedSettings?.defaults : fallbackSettings?.defaults,
    // A policy acknowledgement can echo older model history.
    holdCache:
      isCodex &&
      !reportedSettings?.modelId &&
      (permissionsOnlyPending || (settingsOnlyBlocked && settingsNotice?.status === "uncertain")),
  });
  const settingsControlScope = JSON.stringify([
    selected,
    access?.bootId,
    access?.device?.id,
    access?.device?.advancedControl,
  ]);
  const permissionsUseMode = isClaude || isDevin;
  const permissionTitle = permissionsUseMode ? agentCopy.permission : copy.executionPolicy;
  const settingsUnknown =
    settingsNotice?.status === "uncertain" ||
    (settingsChangedHere && scopedSettings?.applicationStatus === "unknown");
  const settingsLocked = composerSettingsWriteLocked({
    settings: scopedSettings,
    online,
    busy: disabled || busy || saving || preparingSettings,
    stale: settingsReadStale,
    uncertain: settingsUnknown || notice === "uncertain",
    live,
    capabilities,
    feature: feature("settings"),
  });
  const {
    permissionItems,
    permissionReadOnlyWithoutMenu,
    permissionLabel,
    permissionDescription,
    permissionRisky,
    changePermission,
    collaboration,
    planOn,
    planAvailable,
    canTogglePlan,
    canExitPlan,
    clearSavedMode,
    canClearSavedMode,
    setPlan,
    clearPlan,
    togglePlan,
    exitPlan,
  } = projectComposerSettingsControls({
    agent: settingsAgent,
    settings: scopedSettings,
    selection,
    live,
    sessionId: selected,
    locale,
    locked: settingsLocked,
    full,
    write: (fields) => mutate("settings", fields),
  });
  useEffect(() => {
    onPlan?.({ on: planOn, available: planAvailable });
  }, [onPlan, planOn, planAvailable]);
  const showPermissions =
    !settingsAccessDenied &&
    (reservesPermissionSlot ||
      (settingsReadable && (isCodex || permissionsUseMode || !!permissionItems.length)));
  const permissionTriggerLocked = disabled || permissionReadOnlyWithoutMenu;
  const writeStatus = settingsUnknown
    ? layout.settingsUnknown
    : settingsNotice?.status === "notDispatched"
      ? settingsNotice.reason
        ? reason(settingsNotice.reason)
        : t.notDispatched
      : undefined;
  const changePermissionsOpen = (open: boolean) => {
    setPermissionsOpen(open);
    if (!open) return;
    if (
      scopedSettings?.available &&
      !settingsReadStale &&
      !settingsError &&
      permissionItems.length > 0
    ) {
      if (preparesSettings) void load(true, "settings");
    } else prepareSettings();
  };
  const changeAddOpen = (open: boolean) => {
    if (!open) {
      closeAdd();
      return;
    }
    setAddOpen(true);
    void load();
  };
  const openModel = (page: "models" | "effort", refresh = false) =>
    modelPanel.open(page, full && !disabled && settingsReadable, refresh);
  useEffect(() => {
    // A submitted draft has at most one automatic dispatch. The existing action
    // controller owns its receipt, including after a reconnect.
    if (
      !startupGoal?.apply ||
      attemptedStartupGoal.current === startupGoal.value ||
      !selected ||
      !full ||
      !online ||
      !controlReady ||
      disabled ||
      busy ||
      saving ||
      compacting ||
      goalDirty ||
      goalDraftEditor ||
      notice === "uncertain" ||
      live?.sessionId !== selected ||
      live.status !== "idle" ||
      live.revision == null ||
      (startupGoal.afterRevision !== undefined && live.revision <= startupGoal.afterRevision) ||
      capabilities?.sessionId !== selected ||
      feature("goal-set")?.available !== true ||
      goal?.sessionId !== selected ||
      !goal.available ||
      !goal.actions.set?.available ||
      goal.goal ||
      goalReadStale
    )
      return;
    const { objective, tokenBudget } = startupGoal.value;
    disarmStartupGoal();
    void mutate("goal-set", {
      objective,
      intent: "start",
      tokenBudget: tokenBudget ?? null,
    });
  });
  useImperativeHandle(controlsRef, () => ({
    open: (panel) => {
      if (!full || disabled) return false;
      if (panel === "models" || panel === "effort") return openModel(panel);
      if (panel === "permissions" && showPermissions && !permissionTriggerLocked)
        changePermissionsOpen(true);
      else if (panel === "usage" && usage.current) usage.current.open();
      else if (panel === "goal" && (goalReadable || offersGoalDraft)) openGoal();
      else return false;
      return true;
    },
    plan: () => {
      if (!planAvailable) return false;
      if (!planOn) setPlan("plan");
      return true;
    },
  }));
  if (!full) return null;
  return (
    <>
      {mutationError && !goalDialog && (
        <p role="alert" className="px-1 text-xs text-destructive-text">
          {reason(mutationError)}
        </p>
      )}
      {notice === "notDispatched" &&
        (isClaude
          ? noticeReason === "claude-model-unsupported" ||
            noticeReason === "claude-effort-unsupported"
          : noticeReason === "unsupported-model" || noticeReason === "unsupported-effort") && (
          <div role="status" className="space-y-1 px-1 text-xs leading-5 text-muted-foreground">
            <p>{reason(noticeReason)}</p>
            <Button
              type="button"
              variant="link"
              className="h-auto min-h-11 whitespace-normal px-0 text-xs"
              disabled={disabled || !full}
              onClick={() => {
                void load(false, "settings");
                openModel(noticeReason?.includes("effort") ? "effort" : "models", true);
              }}
            >
              {copy.changeNextTurnModel}
            </Button>
          </div>
        )}
      <SessionComposerToolbar
        locale={locale}
        add={{
          label: copy.addContext,
          disabled: disabled,
          open: addOpen,
          onOpenChange: changeAddOpen,
          attachment: attachmentOffered
            ? {
                disabled: disabled || !attachmentAllowed,
                reason: reasonTitle(feature("attachments")?.reason),
                onPick: openPhoneFiles,
              }
            : undefined,
          resources: resourcesOffered
            ? {
                disabled: !resourcesReadable,
                reason: !resourcesReadable
                  ? reasonTitle(feature("resources")?.reason ?? feature("context")?.reason)
                  : undefined,
                page: context,
                path: contextNames,
                selected: resources,
                loading: contextLoading,
                error: contextError,
                offline: !online,
                selectable: !disabled && feature("context")?.available === true,
                selectionReason: feature("context")?.reason,
                reasonText: reason,
                load: loadContext,
                retry: () =>
                  void loadContext(contextLocation.current.id, contextLocation.current.names),
                onSelect: setResources,
              }
            : undefined,
          goal: goalOffered
            ? {
                selected: !!(startupGoal || persistedGoal) || undefined,
                disabled: !goalReadable && !offersGoalDraft && !startupGoal,
                reason: reasonTitle(feature("goal")?.reason ?? feature("goal-draft")?.reason),
                onOpen: openGoal,
              }
            : undefined,
          plan:
            planOffered || (collaboration && settingsReadable)
              ? {
                  active: planOn,
                  disabled: !canTogglePlan,
                  reason: reasonTitle(collaboration?.reason ?? feature("settings")?.reason),
                  onToggle: togglePlan,
                }
              : undefined,
          clearMode: clearSavedMode
            ? {
                disabled: !canClearSavedMode,
                onClear: clearPlan,
              }
            : undefined,
        }}
        permission={
          showPermissions
            ? {
                title: permissionTitle,
                label: permissionLabel ?? permissionTitle,
                description: permissionDescription,
                risky: permissionRisky,
                disabled: permissionTriggerLocked,
                side: "top",
                items: permissionItems,
                open: permissionsOpen,
                onOpenChange: changePermissionsOpen,
                onSelect: changePermission,
              }
            : undefined
        }
        plan={
          planOn
            ? {
                disabled: !canExitPlan,
                onRemove: exitPlan,
              }
            : undefined
        }
        goal={
          persistedGoal || startupGoal
            ? {
                detail: persistedGoal?.objective ?? goalObjective,
                disabled: !persistedGoal && (saving || disabled),
                onOpen: openGoal,
                onRemove: !persistedGoal && onStartupGoalDiscarded ? discardStartupGoal : undefined,
              }
            : undefined
        }
        actions={advancedActions}
        usage={
          <ContextUsageGauge
            fallback={currentUsageSettings?.usage}
            capacity={usageCapacity}
            source={provider?.contextUsage}
            usageRef={usage}
          />
        }
        model={
          showModelPicker
            ? {
                scope: settingsControlScope,
                settings: scopedSettings,
                selection: selection,
                reportedSettings: reportedSettings,
                displayFallback: displayFallback,
                retainedEffortOptions,
                provider: provider,
                clearEffort: canClearEffort,
                disabled: settingsLocked,
                triggerDisabled: false,
                readOnly: settingsReadOnly,
                settingsAuthority: followerAuthority,
                terminalModel: terminalModel,
                modelDefault:
                  reservesModelSlot && !settingsReadable ? false : provider?.models.modelDefault,
                saving: saving,
                loading: preparingSettings,
                ...modelPanel.modelActions({
                  settings: scopedSettings,
                  stale: settingsReadStale,
                  settingsError,
                  prepare: prepareSettings,
                  refresh: preparesSettings ? () => void load(true, "settings") : undefined,
                  terminal: {
                    offered: canOpenTerminalModel,
                    settingsReadable,
                    executionMode: live?.executionMode,
                    ready: controlReady,
                    online,
                    blocked: disabled || busy || running,
                    open: async () => !!(await codexAction("open-model-picker")),
                  },
                }),
                onChange: (change) =>
                  settingsLocked ? Promise.resolve(false) : mutate("settings", change),
              }
            : undefined
        }
        action={action}
      />
      {writeStatus && (
        <p role="status" className="px-3 text-xs text-muted-foreground">
          {writeStatus}
        </p>
      )}
      {goalDialog && (
        <Dialog
          panel
          footer={
            goalDraftEditor ? (
              <Button
                type="button"
                className="min-h-11"
                disabled={goalDraftDisabled || !goalDraft}
                onClick={saveGoalDraft}
              >
                {goalCopy.saveDraft}
              </Button>
            ) : goal?.available ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  className="min-h-11"
                  disabled={
                    busy ||
                    saving ||
                    compacting ||
                    goalChanged ||
                    goalReadStale ||
                    !goal.actions.set?.available ||
                    feature("goal-set")?.available !== true ||
                    !goalObjective.trim() ||
                    !budgetValid
                  }
                  title={reasonTitle(goal.actions.set?.reason || feature("goal-set")?.reason)}
                  onClick={() => {
                    disarmStartupGoal();
                    void mutate("goal-set", {
                      objective: goalObjective.trim(),
                      intent: goal.goal ? "update" : "start",
                      tokenBudget: parsedBudget ?? null,
                    });
                  }}
                >
                  {goal.goal ? copy.goalUpdate : copy.goalCreate}
                </Button>
                {goal.goal && offersGoalAction(goal.goal, "resume") ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={
                      busy ||
                      saving ||
                      compacting ||
                      goalReadStale ||
                      !goal.actions.resume?.available ||
                      feature("goal-resume")?.available !== true
                    }
                    title={reasonTitle(
                      goal.actions.resume?.reason || feature("goal-resume")?.reason,
                    )}
                    onClick={() => void mutate("goal-resume")}
                  >
                    {["budgetLimited", "usageLimited", "budget-exhausted"].includes(
                      goal.goal.status,
                    )
                      ? layout.tryResume
                      : copy.goalResume}
                  </Button>
                ) : offersGoalAction(goal.goal, "pause") ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={
                      busy ||
                      saving ||
                      compacting ||
                      goalReadStale ||
                      !goal.actions.pause?.available ||
                      feature("goal-pause")?.available !== true
                    }
                    title={reasonTitle(goal.actions.pause?.reason || feature("goal-pause")?.reason)}
                    onClick={() => void mutate("goal-pause")}
                  >
                    {copy.goalPause}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={
                    busy ||
                    saving ||
                    compacting ||
                    goalReadStale ||
                    !goal.actions.clear?.available ||
                    feature("goal-clear")?.available !== true
                  }
                  title={reasonTitle(goal.actions.clear?.reason || feature("goal-clear")?.reason)}
                  onClick={() => void mutate("goal-clear")}
                >
                  {copy.goalClear}
                </Button>
              </div>
            ) : undefined
          }
          title={copy.goals}
          closeLabel={copy.close}
          onClose={closeGoal}
        >
          {!goalDraftEditor && goalReadStale && (goal?.available || !!goalError) && (
            <div role="status" className="mb-3 text-xs text-muted-foreground">
              {layout.connecting}
              <Button type="button" variant="outline" onClick={() => void load()}>
                {layout.reloadDraft}
              </Button>
            </div>
          )}
          {goalDraftEditor ? (
            <section className="space-y-3">
              {!offersGoalDraft && (
                <p role="status" className="text-sm text-muted-foreground">
                  {copy.goalUnavailable}
                </p>
              )}
              {goalFields(goalDraftDisabled, provider?.create.goalBudget === "rounds")}
            </section>
          ) : !goal?.available ? (
            <p role="status" className="text-sm text-muted-foreground">
              {copy.goalUnavailable}
              {reason(goal?.reason || goalError)}
            </p>
          ) : (
            <section className="space-y-3">
              {goalChanged && (
                <div role="status" className="text-xs">
                  {layout.nativeChanged}
                  {!goalReadStale && (
                    <Button
                      variant="outline"
                      type="button"
                      onClick={() => {
                        goalDraftRevision.current = undefined;
                        setGoalDirty(false);
                        setObjective(goal.goal?.objective ?? "");
                        setTokenBudget(goal.goal?.tokenBudget?.toString() ?? "");
                      }}
                    >
                      {layout.reloadDraft}
                    </Button>
                  )}
                </div>
              )}
              {mutationError && (
                <p role="alert" className="text-xs text-destructive-text">
                  {reason(mutationError)}
                </p>
              )}
              {goal.goal && (
                <dl className="grid grid-cols-2 gap-2 rounded-lg border p-3 text-xs">
                  <dt>{copy.goalStatus}</dt>
                  <dd>
                    {term(goal.goal.status)}
                    {goal.goal.detail && (
                      <span className="block text-muted-foreground">{goal.goal.detail}</span>
                    )}
                  </dd>
                  {goal.goal.rounds ? (
                    <>
                      <dt>{copy.goalRounds}</dt>
                      <dd>{`${goal.goal.rounds.used} / ${goal.goal.rounds.limit}`}</dd>
                    </>
                  ) : (
                    <>
                      <dt>{copy.goalUsage}</dt>
                      <dd>
                        {goal.goal.tokensUsed?.toLocaleString() ?? copy.unavailable}
                        {goal.goal.tokenBudget
                          ? ` / ${goal.goal.tokenBudget.toLocaleString()}`
                          : ""}
                      </dd>
                      <dt>{copy.goalElapsed}</dt>
                      <dd>
                        {goal.goal.elapsedMs === undefined
                          ? copy.unavailable
                          : `${Math.round(goal.goal.elapsedMs / 1000)}s`}
                      </dd>
                    </>
                  )}
                </dl>
              )}
              {/* Why an action this goal offers is unavailable; with no goal only starting one. */}
              {(["set", "pause", "resume", "clear"] as const)
                .filter(
                  (action) =>
                    offersGoalAction(goal.goal, action) &&
                    (!goal.actions[action]?.available ||
                      feature(`goal-${action}`)?.available !== true),
                )
                .map((action) => (
                  <div key={action}>
                    {reasonDetail(
                      goal.actions[action]?.reason || feature(`goal-${action}`)?.reason,
                    )}
                  </div>
                ))}
              {goalFields(busy || saving || compacting, goal.budget === "rounds")}
            </section>
          )}
        </Dialog>
      )}

      {resources.map((item) => (
        <span
          key={item.id}
          className="inline-flex max-w-full items-center gap-1 rounded-full border pl-3 text-xs"
          aria-disabled={!item.available || undefined}
          title={!item.available ? copy.resourceRemoved : undefined}
        >
          <span className="truncate">{item.name}</span>
          <button
            type="button"
            className="grid size-11 shrink-0 place-items-center rounded hover:bg-accent"
            aria-label={`${copy.remove}: ${item.name}`}
            disabled={disabled}
            onClick={() => setResources(resources.filter((selected) => selected.id !== item.id))}
          >
            <X size={12} />
          </button>
        </span>
      ))}
      {resourceWarning && (
        <span role="alert" className="text-xs text-destructive-text">
          {resourceWarning}
        </span>
      )}
    </>
  );
}
