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
  forgetSessionModelDisplay,
  managedAgentOf,
  canDisplayCodexModelFallback,
  sessionProviderCapabilities,
  type SessionAction,
  type CodexContextOptions,
  type CodexContextResource,
  type CodexGoalState,
  type CodexSettingValues,
  type CodexSessionSettings,
} from "@agentkib/web-client";
import {
  composerGoalCopy,
  ComposerGoalFields,
  ComposerModelPicker,
  SessionComposerToolbar,
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
import { Button } from "@/components/ui/button";
import { Dialog } from "../../components/dialog";
import { useSession } from "./session-context";
import { settingsNoticeGroup, type SettingsNotice } from "./use-session-controller";
import { composerLayoutCopy, composerTerm } from "./composer-layout-copy";
import { codexCopy, codexReason } from "./codex-copy";
import { subscribeSessionInvalidation } from "./session-events";
import {
  contextUsagePercent,
  ContextUsageGauge,
  type ContextUsageGaugeHandle,
} from "./context-usage";
import { sessionAgentCopy } from "./session-agent-copy";

export type CodexResource = CodexContextResource;

/** Opens composer controls; false when this device or session cannot show them now. */
export type ComposerControlsHandle = {
  open(dialog: "settings" | "goal"): boolean;
  openModel(page: "effort" | "models"): boolean;
  openStatus(): boolean;
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
  /** Lets commands and session actions open the same controls as the toolbar. */
  controlsRef?: Ref<ComposerControlsHandle>;
  /** Told when plan mode or the composer's ability to switch it changes. */
  onPlan?: (state: ComposerPlanState) => void;
  startupGoal?: { value: NewSessionGoalDraft; apply: boolean; afterRevision?: number };
  onStartupGoalHandled?: (applied: boolean) => void;
  onStartupGoalDiscarded?: () => void;
  onStageGoal?: (goal: NewSessionGoalDraft) => void;
};

function unavailable(error: unknown) {
  return error instanceof ApiError ? error.code : "request_failed";
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
  onStartupGoalHandled,
  onStartupGoalDiscarded,
  onStageGoal,
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
  } = useSession();
  const copy = codexCopy[locale];
  const isClaude = current?.agent === "claude-code";
  const isCodex = current?.agent === "codex";
  const settingsAgent = managedAgentOf(current?.agent);
  const managedAgent = settingsAgent === "codex" ? null : settingsAgent;
  const isDevin = managedAgent === "devin";
  const modelPanel = useComposerModelPanel();
  const usageGauge = useRef<ContextUsageGaugeHandle>(null);
  const agentCopy = sessionAgentCopy[locale];
  const goalProvider =
    current?.id === selected ? sessionProviderCapabilities(current.agent) : undefined;
  const goalRegistered = goalProvider?.composer?.goal === true;
  const {
    feature,
    settingsReadable,
    canOpenTerminalModel,
    settingsReadOnly,
    terminalModel,
    settingsAccessDenied,
    reservesModelSlot,
    reservesPermissionSlot,
    goalReadable: canReadGoal,
    goalDraftOffered,
    planOffered,
    resourcesReadable,
    resourcesOffered,
    attachmentOffered,
    attachmentAllowed,
  } = composerCapabilities ??
  existingSessionComposerCapabilities({
    access,
    agent: current?.agent,
    currentId: current?.id,
    capabilities,
    sessionId: selected,
    legacyReads: !managedAgent && typeof client.sessionCapabilities !== "function",
  });
  const goalReadable = goalRegistered && canReadGoal;
  const layout = composerLayoutCopy[locale];
  const term = (value: string) => composerTerm(locale, value);
  const reason = (code?: string) => codexReason(locale, code).text;
  const reasonTitle = (code?: string) => (code ? reason(code) : undefined);
  const loadGeneration = useRef(0);
  const loadFlight = useRef<
    | {
        generation: number;
        dirty: boolean;
        background: boolean;
        includeGoal: boolean;
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
  });
  const contextAbort = useRef<AbortController | undefined>(undefined);
  const resourcesRef = useRef(resources);
  resourcesRef.current = resources;
  const contextLocation = useRef<{ id?: string; names: string[] }>({ names: [] });
  const [contextNames, setContextNames] = useState<string[]>([]);
  const [contextLoading, setContextLoading] = useState(false);
  const goalDraftRevision = useRef<number | undefined>(undefined);
  const attemptedStartupGoal = useRef<NewSessionGoalDraft | undefined>(undefined);
  const [goalDirty, setGoalDirty] = useState(false);
  const full = access?.device?.accessMode === "full";
  const applyingStartupGoal = startupGoal?.apply === true;
  const modelAccess = useRef(access);
  modelAccess.current = access;
  const displayAgent = current?.id === selected ? current.agent : undefined;
  const [dialog, setDialog] = useState<"goal" | "goal-draft">();
  const offerGoalDraft =
    goalRegistered && goalDraftOffered && feature("goal-set")?.available !== true && !!onStageGoal;
  const editingGoalDraft = dialog === "goal-draft";
  const goalCopy = composerGoalCopy(locale);
  const [addOpen, setAddOpen] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const historyScope = JSON.stringify([
    selected,
    access?.bootId,
    access?.device?.id,
    full,
    access?.device?.advancedControl,
  ]);
  const [settingsSource, setSettingsSource] = useState<{
    scope: string;
    client: typeof client;
    execution: string;
    value: CodexSessionSettings;
  }>();
  const settingsExecutionScope = JSON.stringify([live?.executionMode, live?.connectionGeneration]);
  const { follower, writeScope, rememberRead, followerAuthority } = useComposerFollowerSettings(
    client,
    access,
    selected,
    live,
  );
  const settings =
    settingsSource?.scope === historyScope && settingsSource.client === client
      ? settingsSource.value
      : undefined;
  const settingsReceiptUncertain = settingsNotice?.status === "uncertain";
  const settingsUnknown =
    settingsReceiptUncertain || (settingsChangedHere && settings?.applicationStatus === "unknown");
  const provider =
    (settings?.sessionId === selected ? settings?.provider : undefined) ??
    sessionProviderCapabilities(current?.agent);
  const usesVariants = provider?.models.selection === "variants";
  const preparesSettings = provider?.models.prepare === true;
  const canPrepareSettings = preparesSettings && live?.executionMode === "claude-managed";
  const [settingsRead, setSettingsRead] = useState<{
    scope: string;
    client: typeof client;
    revision: number;
    values?: CodexSessionSettings["historicalSettings"];
    usage?: CodexSessionSettings["usage"];
    defaults?: CodexSessionSettings["defaults"];
  }>();
  const [goal, setGoal] = useState<CodexGoalState>();
  const [context, setContext] = useState<CodexContextOptions>();
  const [settingsError, setSettingsError] = useState("");
  const [goalError, setGoalError] = useState("");
  const [contextError, setContextError] = useState("");
  const [mutationFailure, setMutationFailure] = useState<{
    scope: string;
    client: typeof client;
    group: SettingsNotice["group"] | "goal";
    reason: string;
  }>();
  const mutationError =
    mutationFailure?.scope === historyScope && mutationFailure.client === client
      ? mutationFailure
      : undefined;
  const [resourceWarning, setResourceWarning] = useState("");
  const [saving, setSaving] = useState(false);
  const mutationFlight = useRef<symbol | undefined>(undefined);
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
      !settingsUnknown &&
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
  const pendingModelSettings =
    !!pendingSettings && settingsNoticeGroup(pendingSettings) !== "permissions";
  const [objective, setObjective] = useState("");
  const [tokenBudget, setTokenBudget] = useState("");
  const compacting = live?.activity === "compacting";
  const running = live?.status !== "idle" || compacting;
  const history =
    full &&
    access.device?.advancedControl === true &&
    settingsRead?.scope === historyScope &&
    settingsRead.client === client
      ? settingsRead
      : undefined;
  const canShowModelFallback =
    (isCodex
      ? canDisplayCodexModelFallback(settings)
      : settings?.applicationStatus !== "pending") &&
    !pendingModelSettings &&
    (!live || live.sessionId === selected);
  const observedModelFallback = canShowModelFallback ? history?.values : undefined;
  const settingsUsage =
    provider?.contextUsage !== "last-request" &&
    settings?.sessionId === selected &&
    !settings.usage?.historical
      ? settings.usage
      : undefined;
  // A last-request report belongs to the settings revision read with it.
  const historicalUsage =
    provider?.contextUsage === "last-request" &&
    (pendingModelSettings || (live?.revision !== undefined && history?.revision !== live.revision))
      ? undefined
      : history?.usage;
  const usageFallback =
    contextUsagePercent(settingsUsage) !== undefined
      ? settingsUsage
      : (historicalUsage ?? settingsUsage);

  const applySettings = useCallback(
    (value: CodexSessionSettings, fromLive = false) => {
      if (value.sessionId !== selected) return;
      if (!fromLive) rememberRead(value);
      setSettingsSource({ scope: historyScope, client, execution: settingsExecutionScope, value });
    },
    [client, historyScope, rememberRead, selected, settingsExecutionScope],
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
          if (error instanceof ApiError && [401, 403, 404, 410].includes(error.status)) {
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
    (background = false, includeGoal = true): Promise<void> => {
      if (!full || !selected) return Promise.resolve();
      const generation = loadGeneration.current;
      const pending = loadFlight.current;
      if (pending?.generation === generation) {
        pending.dirty = true;
        pending.background &&= background;
        pending.includeGoal ||= includeGoal;
        return pending.promise;
      }
      const flight = {
        generation,
        dirty: true,
        background,
        includeGoal,
        promise: Promise.resolve(),
      };
      flight.promise = (async () => {
        // Initial readiness, an idle revision and domain invalidations can arrive
        // together. Coalesce that batch before starting one pair of native reads.
        await Promise.resolve();
        while (flight.dirty && generation === loadGeneration.current) {
          const quiet = flight.background;
          const readGoal = goalReadable && flight.includeGoal;
          const readVersion = settingsReadVersion.current;
          flight.dirty = false;
          flight.background = true;
          flight.includeGoal = false;
          // The model can display as soon as its read settles, even if goals take longer.
          await Promise.all([
            (async () => {
              try {
                const value =
                  settingsReadable && settingsAgent
                    ? await client.sessionSettings(selected, settingsAgent)
                    : undefined;
                if (
                  generation !== loadGeneration.current ||
                  readVersion !== settingsReadVersion.current
                )
                  return;
                // Keep historical display data tied to the authorized read, even when live
                // settings replace the editable projection.
                setSettingsRead(
                  value?.sessionId === selected &&
                    (value.historicalSettings ||
                      value.usage?.historical ||
                      (!managedAgent && value.defaults.modelId))
                    ? {
                        scope: historyScope,
                        client,
                        revision: value.revision,
                        values: value.historicalSettings,
                        usage: value.usage?.historical ? value.usage : undefined,
                        defaults: value.defaults,
                      }
                    : undefined,
                );
                if (value) applySettings(value);
                else if (settingsReadable) setSettingsSource(undefined);
                setSettingsError("");
              } catch (error) {
                if (generation !== loadGeneration.current) return;
                const accessLost =
                  error instanceof ApiError && [401, 403, 404, 410].includes(error.status);
                if (accessLost) {
                  forgetSessionModelDisplay(client, modelAccess.current, selected, displayAgent);
                  settingsPreparation.current = undefined;
                  setPreparingSettings(false);
                }
                if ((readVersion === settingsReadVersion.current && !quiet) || accessLost) {
                  setSettingsSource(undefined);
                  setSettingsRead(undefined);
                  setSettingsError(unavailable(error));
                }
              }
            })(),
            (async () => {
              if (!readGoal) return;
              try {
                const value = managedAgent
                  ? await client.sessionGoals(selected, managedAgent)
                  : await client.codexGoals(selected);
                if (generation !== loadGeneration.current) return;
                setGoal(value);
                if (goalDraftRevision.current === undefined) {
                  setObjective(value?.goal?.objective ?? "");
                  setTokenBudget(value?.goal?.tokenBudget?.toString() ?? "");
                }
                setGoalError("");
              } catch (error) {
                if (generation !== loadGeneration.current || quiet) return;
                setGoal(undefined);
                setGoalError(unavailable(error));
              }
            })(),
          ]);
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
      displayAgent,
      settingsReadable,
      goalReadable,
      historyScope,
    ],
  );

  useEffect(() => {
    loadGeneration.current++;
    goalDraftRevision.current = undefined;
    attemptedStartupGoal.current = undefined;
    setGoalDirty(false);
    setObjective("");
    setTokenBudget("");
    setSettingsSource(undefined);
    setSettingsRead(undefined);
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
    };
    setDialog(undefined);
    setPermissionOpen(false);
    setAddOpen(false);

    setSaving(false);
    mutationFlight.current = undefined;
    settingsPreparation.current = undefined;
    setPreparingSettings(false);
    setPendingSettings(undefined);
    setSettingsError("");
    setGoalError("");
    setContextError("");
    setMutationFailure(undefined);
    setResourceWarning("");
    return () => {
      loadGeneration.current++;
      mutationFlight.current = undefined;
      settingsPreparation.current = undefined;
      contextGeneration.current++;
      contextAbort.current?.abort();
    };
  }, [selected, setResources, client, access?.bootId, access?.device?.id, historyScope]);

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
    usageEpoch,
    settingsReadable,
    goalReadable,
    resourcesReadable,
    settingsExecutionScope,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!full || !selected || !online) return;
    return subscribeSessionInvalidation(client, (id, domains) => {
      if (
        (!id || id === selected) &&
        domains.some((domain) => ["settings", "goal", "usage", "ownership"].includes(domain))
      )
        void load(
          true,
          domains.includes("goal") ||
            (domains.includes("ownership") && !domains.includes("settings")),
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
      void load(true, dialog === "goal" || applyingStartupGoal);
  }, [
    full,
    load,
    online,
    selected,
    live?.sessionId,
    live?.status,
    live?.revision,
    dialog,
    applyingStartupGoal,
  ]);

  useEffect(() => {
    if (live?.settings?.sessionId === selected) {
      applySettings(
        {
          ...live.settings,
          usage: live.usage ?? live.settings.usage,
        },
        true,
      );
    } else if (live?.usage && settings?.sessionId === selected) {
      setSettingsSource((source) =>
        source?.scope === historyScope && source.client === client
          ? { ...source, value: { ...source.value, usage: live.usage } }
          : source,
      );
    }
    if (live?.goal && goal?.sessionId === selected)
      setGoal((value) => (value ? { ...value, goal: live.goal } : value));
  }, [applySettings, client, goal?.sessionId, historyScope, live, selected, settings?.sessionId]);

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

  function mutate(name: SessionAction, fields: ComposerMutationFields = {}) {
    const changesSettings = name === "settings";
    return runComposerSettingsMutation({
      action: name,
      fields,
      permitted: full && !compacting,
      settingsAllowed:
        !!settings?.available &&
        !settingsUnknown &&
        !settingsReadStale &&
        (capabilities?.sessionId !== selected || feature("settings")?.available === true),
      readRevision: changesSettings ? settings?.revision : goal?.revision,
      liveRevision: live?.revision,
      follower: follower ? { authority: followerAuthority, writeScope } : undefined,
      flight: mutationFlight,
      loadGeneration,
      send: codexAction,
      onStart: () => {
        setSaving(true);
        setMutationFailure(undefined);
      },
      onAccepted: () => {
        if (name === "goal-set" && startupGoal) onStartupGoalHandled?.(true);
      },
      onPendingSettings: setPendingSettings,
      onGoalChanged: () => {
        goalDraftRevision.current = undefined;
        setGoalDirty(false);
      },
      refresh: () => load(false, !changesSettings),
      onError: (error) =>
        setMutationFailure({
          scope: historyScope,
          client,
          group: changesSettings ? settingsNoticeGroup(fields) : "goal",
          reason: unavailable(error),
        }),
      onSettle: () => setSaving(false),
    });
  }

  const settingsReadStale =
    !settingsReadable ||
    (follower && feature("settings")?.available === true && !writeScope) ||
    settingsSource?.execution !== settingsExecutionScope ||
    (live?.revision !== undefined && settings?.revision !== live.revision);
  const goalReadStale = live?.revision !== undefined && goal?.revision !== live.revision;
  const goalSnapshot = goalReadable && goal?.sessionId === selected ? goal : undefined;
  const activeGoal = goalSnapshot?.available ? goalSnapshot.goal : undefined;
  const goalStatus = activeGoal?.status;
  const retryGoal = ["budgetLimited", "usageLimited", "budget-exhausted"].includes(
    goalStatus ?? "",
  );
  const resumeGoal = retryGoal || goalStatus === "paused" || goalStatus === "blocked";
  const goalTurnAction = resumeGoal ? "resume" : "pause";
  const goalActionsLocked =
    disabled || busy || saving || compacting || goalReadStale || !goalSnapshot?.available;
  const goalLockReason = compacting
    ? reason("session-compacting")
    : goalReadable && goalReadStale
      ? layout.connecting
      : disabled || busy || saving
        ? reason("session-busy")
        : undefined;
  const goalActionDisabled = (action: keyof CodexGoalState["actions"]) =>
    goalActionsLocked ||
    !goalSnapshot?.actions?.[action]?.available ||
    feature(`goal-${action}`)?.available !== true;
  const goalActionTitle = (action: keyof CodexGoalState["actions"]) =>
    reasonTitle(
      goalSnapshot?.actions?.[action]?.reason ||
        feature(`goal-${action}`)?.reason ||
        (!goalSnapshot?.available
          ? goalSnapshot?.reason ||
            feature("goal")?.reason ||
            (goalReadable ? goalError : undefined)
          : undefined),
    ) ??
    goalLockReason ??
    (!goalSnapshot?.available ? copy.goalUnavailable : undefined);
  const prepareSettings = () => {
    if (!settingsReadable || !online) return;
    if (
      canPrepareSettings &&
      !running &&
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
          if (currentRead) applySettings(value);
          else
            setSettingsSource((previous) => ({
              scope: historyScope,
              client,
              execution: settingsExecutionScope,
              value:
                previous?.scope === historyScope && previous.client === client
                  ? mergePreparedCatalog(previous.value, value)
                  : value,
            }));
        },
        onError: (error) => setSettingsError(unavailable(error)),
        onSettle: () => setPreparingSettings(false),
      })
    )
      return;
    void load(!!settings?.available && !settingsReadStale && !settingsError, false);
  };
  const displayedSettings = settings
    ? settingsUnknown
      ? settings.current
      : composerSettingsSelection(settings, isClaude, { live, staged: pendingSettings })
    : undefined;
  const contextLimit =
    settings?.sessionId === selected &&
    (provider?.contextUsage !== "last-request" ||
      (!pendingModelSettings &&
        !settingsReadStale &&
        settings.applicationStatus !== "pending" &&
        settings.applicationStatus !== "unknown"))
      ? displayedSettings?.maxContextTokens
      : undefined;
  const liveSettings =
    provider !== undefined &&
    !preparesSettings &&
    live?.sessionId === selected &&
    live.settings?.sessionId === selected &&
    live.settings.revision >= (settings?.revision ?? 0)
      ? live.settings
      : undefined;
  const liveSelection = liveSettings && composerSettingsSelection(liveSettings, false);
  const reportedSettings =
    !settingsUnknown && settings?.applicationStatus !== "pending" && !pendingModelSettings
      ? liveSelection?.modelId || liveSelection?.effort
        ? liveSelection
        : liveSettings?.current
      : undefined;
  const claudeReadFallbackAllowed =
    isClaude &&
    !settingsUnknown &&
    notice !== "uncertain" &&
    live?.status !== "outcome-unknown" &&
    live?.reason !== "control-outcome-unconfirmed" &&
    capabilities?.reason !== "control-outcome-unconfirmed";
  const claudeHistoricalModel = claudeReadFallbackAllowed
    ? settings?.historicalSettings
    : undefined;
  const fallbackDefaults = claudeReadFallbackAllowed
    ? settings?.defaults
    : isCodex && canShowModelFallback
      ? history?.defaults
      : undefined;
  const observedModel: CodexSettingValues | undefined = [
    reportedSettings,
    displayedSettings,
    settings?.current,
    claudeHistoricalModel,
    observedModelFallback,
  ].find((value) => value?.modelId);
  const {
    showModelPicker,
    displayFallback: displayModelFallback,
    retainedEffortOptions,
  } = useComposerModelDisplay({
    client,
    access,
    sessionId: selected,
    agent: displayAgent,
    denied: settingsAccessDenied,
    settingsReadable,
    reservesSlot: reservesModelSlot,
    provider,
    catalog: settings ?? liveSettings,
    observed: observedModel,
    historical: claudeHistoricalModel?.modelId ? claudeHistoricalModel : observedModelFallback,
    defaults: fallbackDefaults,
    holdCache:
      settingsUnknown ||
      (isCodex && !!pendingSettings && !pendingModelSettings && !displayedSettings?.modelId),
    uncertain: settingsUnknown,
  });
  const showPermissions =
    !settingsAccessDenied &&
    (reservesPermissionSlot ||
      (settingsReadable &&
        (isCodex || isClaude || isDevin || !!settings?.options.policies?.length)));
  const changePermissionOpen = (open: boolean) => {
    setPermissionOpen(open);
    if (!open) return;
    const hasPermissionOptions =
      isClaude || isDevin
        ? settings?.options.permissionModes?.length
        : settings?.options.policies.length;
    if (settings?.available && !settingsReadStale && !settingsError && hasPermissionOptions) {
      if (preparesSettings) void load(true, false);
    } else prepareSettings();
  };
  const closeAdd = () => {
    setAddOpen(false);
  };
  const openGoal = () => {
    if (!goalRegistered) return;
    closeAdd();
    if (offerGoalDraft) {
      // Keep background native reads from replacing the local draft.
      goalDraftRevision.current = goalSnapshot?.revision ?? 0;
      setGoalDirty(false);
      setObjective(startupGoal?.value.objective ?? "");
      setTokenBudget(startupGoal?.value.tokenBudget?.toString() ?? "");
      setDialog("goal-draft");
      return;
    }
    setDialog("goal");
    if (goalReadable && goalReadStale) void load();
  };
  const openModel = (page: "models" | "effort", refresh = false) =>
    modelPanel.open(page, full && !disabled && settingsReadable, refresh);
  const stagedGoal = goalDirty ? undefined : startupGoal?.value;
  const disarmStartupGoal = () => {
    if (!startupGoal?.apply || attemptedStartupGoal.current === startupGoal.value) return;
    attemptedStartupGoal.current = startupGoal.value;
    onStartupGoalHandled?.(false);
  };
  const goalObjective = stagedGoal?.objective ?? objective;
  const goalBudget = stagedGoal ? (stagedGoal.tokenBudget?.toString() ?? "") : tokenBudget;
  const savedGoal =
    goalReadable && !goalSnapshot && live?.sessionId === selected ? live.goal : activeGoal;
  const selectedGoalDetail = savedGoal
    ? `${term(savedGoal.status)} · ${savedGoal.objective}`
    : startupGoal && goalObjective;
  const goalDraftLocked =
    disabled ||
    saving ||
    notice === "uncertain" ||
    live?.status === "outcome-unknown" ||
    live?.reason === "control-outcome-unconfirmed" ||
    capabilities?.reason === "control-outcome-unconfirmed";
  const resetGoalDraftEditor = () => {
    goalDraftRevision.current = undefined;
    setGoalDirty(false);
    setObjective(savedGoal?.objective ?? "");
    setTokenBudget(savedGoal?.tokenBudget?.toString() ?? "");
  };
  const closeGoal = () => {
    if (editingGoalDraft) resetGoalDraftEditor();
    setDialog(undefined);
  };
  const discardStartupGoal = () => {
    if (savedGoal || !startupGoal || goalDraftLocked || mutationFlight.current) return;
    onStartupGoalDiscarded?.();
    resetGoalDraftEditor();
  };
  const goalChanged = goalDirty && goalDraftRevision.current !== goal?.revision;
  const editGoal = () => {
    goalDraftRevision.current ??= goal?.revision;
    if (stagedGoal) {
      setObjective(goalObjective);
      setTokenBudget(goalBudget);
      if (!editingGoalDraft) disarmStartupGoal();
    }
    setGoalDirty(true);
  };
  const parsedBudget = goalBudget ? Number(goalBudget) : undefined;
  const budgetValid =
    parsedBudget === undefined || (Number.isSafeInteger(parsedBudget) && parsedBudget > 0);
  const parsedGoalDraft = editingGoalDraft ? parseGoalDraft(goalObjective, goalBudget) : undefined;
  const goalDraftDisabled = !offerGoalDraft || goalDraftLocked;
  const goalDraftTitle = !offerGoalDraft
    ? (reasonTitle(feature("goal-draft")?.reason) ?? copy.goalUnavailable)
    : undefined;
  const saveGoalDraft = () => {
    if (goalDraftDisabled || !parsedGoalDraft) return;
    onStageGoal?.(parsedGoalDraft);
    closeGoal();
  };
  const settingsWriteLocked = composerSettingsWriteLocked({
    settings: settings,
    online,
    busy: disabled || busy || saving || preparingSettings,
    stale: settingsReadStale,
    uncertain: settingsUnknown || notice === "uncertain",
    live,
    capabilities,
    feature: feature("settings"),
  });
  const menuTitle = isClaude || isDevin ? agentCopy.permission : copy.executionPolicy;
  const {
    permissionItems,
    permissionReadOnlyWithoutMenu,
    permissionLabel,
    permissionDescription,
    permissionHint,
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
    settings,
    selection: displayedSettings,
    live,
    sessionId: selected,
    locale,
    locked: settingsWriteLocked,
    full,
    write: (fields) => mutate("settings", fields),
  });
  const permissionTriggerLocked = disabled || permissionReadOnlyWithoutMenu;
  useEffect(() => {
    onPlan?.({ on: planOn, available: planAvailable });
  }, [onPlan, planOn, planAvailable]);
  const localSettingsNotice: SettingsNotice | undefined =
    settingsNotice ??
    (settingsUnknown
      ? { group: settingsNoticeGroup(pendingSettings ?? {}), status: "uncertain" }
      : mutationError && mutationError.group !== "goal"
        ? { group: mutationError.group, status: "notDispatched", reason: mutationError.reason }
        : undefined);
  const settingsMessage = localSettingsNotice
    ? localSettingsNotice.status === "uncertain"
      ? layout.settingsUnknown
      : (reasonTitle(localSettingsNotice.reason) ?? copy.settingUnavailable)
    : undefined;
  const modelMessage =
    showModelPicker &&
    (localSettingsNotice?.group === "model" ||
      (localSettingsNotice?.group === "settings" && !showPermissions));
  const permissionMessage =
    !modelMessage && (showPermissions || localSettingsNotice?.group === "permissions");
  useEffect(() => {
    // A submitted draft has at most one automatic dispatch. The existing action
    // controller owns its receipt, including after a reconnect.
    if (
      !goalReadable ||
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
      editingGoalDraft ||
      goalDirty ||
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
    open: (next) => {
      if (!full || disabled) return false;
      if (next === "settings") {
        if (!showPermissions || permissionTriggerLocked) return false;
        changePermissionOpen(true);
        return true;
      }
      if (!goalReadable && !offerGoalDraft) return false;
      openGoal();
      return true;
    },
    openModel,
    openStatus: () => {
      if (!full || disabled || !usageGauge.current) return false;
      usageGauge.current.open();
      return true;
    },
    plan: () => {
      if (!planAvailable) return false;
      if (!planOn) setPlan("plan");
      return true;
    },
  }));
  if (!full) return null;
  const settingsFeedback = settingsMessage && (
    <p
      role={localSettingsNotice?.status === "uncertain" ? "status" : "alert"}
      className={`max-w-64 px-1 text-xs leading-4 ${localSettingsNotice?.status === "uncertain" ? "text-muted-foreground" : "text-destructive-text"}`}
    >
      {settingsMessage}
    </p>
  );
  const goalFieldsDisabled = editingGoalDraft ? goalDraftDisabled : goalActionDisabled("set");
  const goalFields = dialog && (
    <div
      className="space-y-3"
      title={
        goalFieldsDisabled
          ? editingGoalDraft
            ? goalDraftTitle
            : goalActionTitle("set")
          : undefined
      }
    >
      <ComposerGoalFields
        locale={locale}
        objective={
          editingGoalDraft || goalSnapshot?.available
            ? goalObjective
            : (stagedGoal?.objective ?? "")
        }
        budget={
          editingGoalDraft || goalSnapshot?.available
            ? goalBudget
            : (stagedGoal?.tokenBudget?.toString() ?? "")
        }
        disabled={goalFieldsDisabled}
        hideBudget={(goalSnapshot?.budget ?? goalProvider?.create.goalBudget) === "rounds"}
        onObjectiveChange={(value) => {
          editGoal();
          setObjective(value);
        }}
        onBudgetChange={(value) => {
          editGoal();
          setTokenBudget(value);
        }}
      />
    </div>
  );

  return (
    <>
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
              disabled={disabled || !settingsReadable}
              onClick={() =>
                openModel(noticeReason?.includes("effort") ? "effort" : "models", true)
              }
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
          onOpenChange: (open) => {
            setAddOpen(open);
            if (open) void load(false, false);
          },
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
          goal: goalRegistered
            ? {
                selected: !!startupGoal || !!savedGoal,
                onOpen: openGoal,
              }
            : undefined,
          plan:
            planOffered || collaboration
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
                title: menuTitle,
                label:
                  permissionLabel ??
                  (isClaude || isDevin ? agentCopy.permission : copy.executionPolicy),
                description: permissionDescription,
                hint: permissionHint,
                risky: permissionRisky,
                disabled: permissionTriggerLocked,
                side: "top",
                open: permissionOpen,
                onOpenChange: changePermissionOpen,
                items: permissionItems,
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
          goalRegistered && (savedGoal || startupGoal)
            ? {
                detail: selectedGoalDetail,
                disabled: !savedGoal && goalDraftLocked,
                onOpen: openGoal,
                onRemove: !savedGoal && onStartupGoalDiscarded ? discardStartupGoal : undefined,
              }
            : undefined
        }
        actions={advancedActions}
        usage={
          <ContextUsageGauge
            gaugeRef={usageGauge}
            fallback={usageFallback}
            limit={contextLimit}
            source={provider?.contextUsage}
          />
        }
        model={
          showModelPicker
            ? {
                scope: `${selected}\0${access?.bootId ?? ""}\0${access?.device?.id ?? ""}\0${access?.device?.advancedControl ?? ""}`,
                settings: settings,
                provider: provider,
                selection: displayedSettings,
                reportedSettings: reportedSettings,
                displayFallback: displayModelFallback,
                verifiedHistoricalModel:
                  settingsReadable && reservesModelSlot
                    ? claudeHistoricalModel?.modelId
                    : undefined,
                retainedEffortOptions,
                disabled: settingsWriteLocked,
                triggerDisabled: false,
                readOnly: settingsReadOnly,
                settingsAuthority: followerAuthority,
                terminalModel: terminalModel,
                saving: saving,
                loading:
                  preparingSettings || (online && settingsReadable && !settings && !settingsError),
                readError: settingsError,
                ...modelPanel.modelActions({
                  settings: settings,
                  stale: settingsReadStale,
                  settingsError,
                  prepare: prepareSettings,
                  refresh: preparesSettings ? () => void load(true, false) : undefined,
                  terminal: {
                    offered: canOpenTerminalModel,
                    settingsReadable,
                    sessionId: selected,
                    live,
                    ready: controlReady,
                    online,
                    blocked: disabled || busy || running,
                    open: async () => !!(await codexAction("open-model-picker")),
                  },
                }),
                effortDefault: provider?.models.effortDefault ?? managedAgent !== null,
                modelDefault: !preparesSettings && provider?.models.modelDefault,
                clearEffort:
                  provider?.models.clearEffort === true &&
                  (!preparesSettings || canPrepareSettings),
                onChange: (fields) => mutate("settings", fields),
              }
            : undefined
        }
        action={action}
        permissionFeedback={permissionMessage && settingsFeedback}
        modelFeedback={modelMessage && settingsFeedback}
      />
      {!permissionMessage && !modelMessage && settingsFeedback}
      {goalRegistered && dialog && (
        <Dialog
          panel
          description={editingGoalDraft ? undefined : `${layout.selected}: ${resources.length}`}
          footer={
            editingGoalDraft ? (
              <Button
                type="button"
                className="disabled:pointer-events-auto"
                disabled={goalDraftDisabled || !parsedGoalDraft}
                title={goalDraftTitle}
                onClick={saveGoalDraft}
              >
                {goalCopy.saveDraft}
              </Button>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  className="min-h-11 disabled:pointer-events-auto"
                  disabled={
                    goalActionDisabled("set") ||
                    goalChanged ||
                    !goalObjective.trim() ||
                    !budgetValid
                  }
                  title={goalActionTitle("set")}
                  onClick={() => {
                    disarmStartupGoal();
                    void mutate("goal-set", {
                      objective: goalObjective.trim(),
                      intent: activeGoal ? "update" : "start",
                      tokenBudget: parsedBudget ?? null,
                    });
                  }}
                >
                  {activeGoal ? copy.goalUpdate : copy.goalCreate}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="disabled:pointer-events-auto"
                  disabled={
                    (!resumeGoal && goalStatus !== "active") || goalActionDisabled(goalTurnAction)
                  }
                  title={goalActionTitle(goalTurnAction)}
                  onClick={() => void mutate(`goal-${goalTurnAction}`)}
                >
                  {retryGoal ? layout.tryResume : resumeGoal ? copy.goalResume : copy.goalPause}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 disabled:pointer-events-auto"
                  disabled={!activeGoal || goalActionDisabled("clear")}
                  title={goalActionTitle("clear")}
                  onClick={() => void mutate("goal-clear")}
                >
                  {copy.goalClear}
                </Button>
              </div>
            )
          }
          title={copy.goals}
          closeLabel={copy.close}
          onClose={closeGoal}
        >
          {!editingGoalDraft &&
            goalReadable &&
            goalReadStale &&
            (goalSnapshot?.available || !!goalError) && (
              <div role="status" className="mb-3 text-xs text-muted-foreground">
                {layout.connecting}
                <Button type="button" variant="outline" onClick={() => void load()}>
                  {layout.reloadDraft}
                </Button>
              </div>
            )}
          {editingGoalDraft ? (
            goalFields
          ) : (
            <section className="space-y-3">
              {goalSnapshot?.available && goalChanged && (
                <div role="status" className="text-xs">
                  {layout.nativeChanged}
                  {!goalReadStale && (
                    <Button
                      variant="outline"
                      type="button"
                      onClick={() => {
                        goalDraftRevision.current = undefined;
                        setGoalDirty(false);
                        setObjective(activeGoal?.objective ?? "");
                        setTokenBudget(activeGoal?.tokenBudget?.toString() ?? "");
                      }}
                    >
                      {layout.reloadDraft}
                    </Button>
                  )}
                </div>
              )}
              {goalSnapshot?.available && mutationError?.group === "goal" && (
                <p role="alert" className="text-xs text-destructive-text">
                  {reason(mutationError.reason)}
                </p>
              )}
              {activeGoal && (
                <dl className="grid grid-cols-2 gap-2 rounded-lg border p-3 text-xs">
                  <dt>{copy.goalStatus}</dt>
                  <dd>
                    {term(activeGoal.status)}
                    {activeGoal.detail && (
                      <span className="block text-muted-foreground">{activeGoal.detail}</span>
                    )}
                  </dd>
                  {activeGoal.rounds ? (
                    <>
                      <dt>{copy.goalRounds}</dt>
                      <dd>{`${activeGoal.rounds.used} / ${activeGoal.rounds.limit}`}</dd>
                    </>
                  ) : (
                    <>
                      <dt>{copy.goalUsage}</dt>
                      <dd>
                        {activeGoal.tokensUsed?.toLocaleString() ?? copy.unavailable}
                        {activeGoal.tokenBudget
                          ? ` / ${activeGoal.tokenBudget.toLocaleString()}`
                          : ""}
                      </dd>
                      <dt>{copy.goalElapsed}</dt>
                      <dd>
                        {activeGoal.elapsedMs === undefined
                          ? copy.unavailable
                          : `${Math.round(activeGoal.elapsedMs / 1000)}s`}
                      </dd>
                    </>
                  )}
                </dl>
              )}
              {goalFields}
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
          <Button
            variant="bare"
            size="content"
            type="button"
            className="grid size-11 shrink-0 place-items-center rounded hover:bg-accent"
            aria-label={`${copy.remove}: ${item.name}`}
            disabled={disabled}
            onClick={() => setResources(resources.filter((selected) => selected.id !== item.id))}
          >
            <X size={12} />
          </Button>
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
