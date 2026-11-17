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
  readSessionModelDisplay,
  rememberSessionModelDisplay,
  sessionProviderCapabilities,
  type SessionAction,
  type SessionActionBody,
  type CodexContextOptions,
  type CodexContextResource,
  type CodexGoalState,
  type CodexSessionSettings,
} from "@agentkib/web-client";
import {
  ComposerGoalFields,
  ComposerModelPicker,
  ComposerModeChip,
  SessionComposerAddMenu,
  ComposerPermissionMenu,
  ComposerToolbar,
  composerGoalCopy,
  codexPolicyLabel,
  dshPolicyLabel,
  newSessionPermissions,
  parseGoalDraft,
  sessionCollaborationMode,
  sessionComposerCapabilities,
  type ComposerModelPickerHandle,
  type NewSessionGoalDraft,
} from "@agentkib/session-ui";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/dialog";
import { useSession } from "./session-context";
import { composerLayoutCopy, composerTerm } from "./composer-layout-copy";
import { codexCopyForSurface, codexReason } from "./codex-copy";
import { subscribeSessionInvalidation } from "./session-events";
import { ContextUsageGauge, useContextUsage, type ContextUsageHandle } from "./context-usage";
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

function settingsSelection(settings: CodexSessionSettings, isClaude: boolean) {
  if (!isClaude) return settings.selected ?? settings.current;
  return {
    ...settings.current,
    ...settings.selected,
    modelId: settings.selected?.modelId ?? settings.current.modelId,
    effort: settings.selected?.effort ?? settings.current.effort,
    permissionMode: settings.selected?.permissionMode ?? settings.current.permissionMode,
  };
}

function modelOption(settings: CodexSessionSettings | undefined, model: string | undefined) {
  if (!model) return undefined;
  return (
    settings?.options.models?.find((item) => item.id === model || item.resolvedModel === model) ??
    settings?.options.models?.find((item) => item.variants?.some((variant) => variant.id === model))
  );
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
  // Codex keeps its legacy route, which includes the last-used settings for inactive sessions.
  const managedAgent = current?.agent === "codex" ? null : managedAgentOf(current?.agent);
  const isDevin = managedAgent === "devin";
  const agentCopy = sessionAgentCopy[locale];
  const {
    feature,
    settingsReadable,
    settingsReadReason,
    reservesModelSlot,
    reservesPermissionSlot,
    goalReadable,
    goalDraftOffered,
    resourcesReadable,
    attachmentOffered,
    attachmentAllowed,
  } = sessionComposerCapabilities({
    capabilities,
    sessionId: selected,
    legacyReads: !managedAgent,
    attachmentsGranted: access?.device?.attachments === true,
    settingsSlots:
      isClaude &&
      current.id === selected &&
      access?.status === "approved" &&
      access.device?.accessMode === "full" &&
      access.device.advancedControl === true &&
      (live?.sessionId !== selected ||
        !live.executionMode ||
        live.executionMode === "claude-managed")
        ? sessionProviderCapabilities(current.agent)?.create
        : undefined,
  });
  const offersGoalDraft = goalDraftOffered && !goalReadable && !!onStageGoal;
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
  const modelPicker = useRef<ComposerModelPickerHandle>(null);
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
  const [pendingSettings, setPendingSettings] =
    useState<
      Pick<
        SessionActionBody,
        | "model"
        | "effort"
        | "mode"
        | "policyId"
        | "serviceTierId"
        | "restoreDefaults"
        | "permissionMode"
        | "expectedRevision"
      >
    >();
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
    provider?.contextUsage === "last-request" &&
    currentUsageSettings?.applicationStatus !== "pending" &&
    currentUsageSettings?.applicationStatus !== "unknown"
      ? currentUsageSettings?.current.maxContextTokens
      : undefined;
  const usageView = useContextUsage(
    currentUsageSettings?.usage,
    usageCapacity,
    provider?.contextUsage,
  );
  const supportsContextUsage = provider?.contextUsage !== "unsupported";
  const showContextUsage =
    supportsContextUsage &&
    (provider?.contextUsage !== "last-request" ||
      usageView.usage?.historical === true ||
      usageView.capacity !== undefined);

  const applySettings = useCallback(
    (value: CodexSessionSettings, fromLive = false) => {
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
    [fallbackProvider],
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
        if (!abort.signal.aborted && generation === contextGeneration.current)
          setContextError(unavailable(error));
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
          const readGoal = flight.sections.has("goal");
          flight.sections.clear();
          flight.background = true;
          const [settingsResult, goalResult] = await Promise.allSettled([
            readSettings && settingsReadable
              ? managedAgent
                ? client.sessionSettings(selected, managedAgent)
                : client.codexSessionSettings(selected)
              : Promise.resolve(undefined),
            readGoal && goalReadable
              ? managedAgent
                ? client.sessionGoals(selected, managedAgent)
                : client.codexGoals(selected)
              : Promise.resolve(undefined),
          ]);
          if (generation !== loadGeneration.current) return;
          if (readSettings) {
            if (settingsResult.status === "fulfilled") {
              if (settingsResult.value) applySettings(settingsResult.value);
              else setSettings(undefined);
              setSettingsError("");
            } else {
              const denied = modelReadDenied(settingsResult.reason);
              if (denied)
                forgetSessionModelDisplay(
                  client,
                  displayScope.access,
                  selected,
                  displayScope.agent,
                );
              if (!quiet || denied) {
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
    [applySettings, client, full, selected, managedAgent, settingsReadable, goalReadable],
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
    if (!settings?.available || !pendingSettings) return;
    const expected: Omit<typeof pendingSettings, "expectedRevision"> =
      pendingSettings.restoreDefaults
        ? {
            model: settings.defaults.modelId,
            effort: settings.defaults.effort,
            serviceTierId: settings.defaults.serviceTierId,
            permissionMode: settings.defaults.permissionMode,
          }
        : pendingSettings;
    const confirmed =
      (!(isClaude || usesVariants) ||
        (settings.applicationStatus === "confirmed" &&
          settings.revision > pendingSettings.expectedRevision)) &&
      settings.applicationStatus !== "pending" &&
      settings.applicationStatus !== "unknown" &&
      (expected.model === undefined ||
        settings.current.modelId === expected.model ||
        (isClaude &&
          !!settings.current.modelId &&
          settings.options.models.find((item) => item.id === expected.model)?.resolvedModel ===
            settings.current.modelId)) &&
      (expected.effort === undefined ||
        (isClaude && expected.effort === null
          ? settings.selected !== undefined && settings.selected.effort === undefined
          : settings.current.effort === expected.effort)) &&
      (expected.mode === undefined ||
        (expected.mode === null
          ? settings.selected !== undefined && settings.selected.mode === undefined
          : settings.current.mode === expected.mode)) &&
      (expected.policyId === undefined || settings.current.policyId === expected.policyId) &&
      (expected.permissionMode === undefined ||
        settings.current.permissionMode === expected.permissionMode) &&
      (expected.serviceTierId === undefined ||
        (expected.serviceTierId === null
          ? settings.current.serviceTierId == null ||
            (!usesVariants && settings.current.serviceTierId === settings.defaults.serviceTierId)
          : settings.current.serviceTierId === expected.serviceTierId));
    if (confirmed) {
      setPendingSettings(undefined);
    }
  }, [isClaude, pendingSettings, settings, usesVariants]);

  /** Changes the settings or the goal; true once the host accepted the change. */
  async function mutate(
    name: SessionAction,
    fields: Omit<
      Partial<SessionActionBody>,
      "requestId" | "bootId" | "sessionId" | "expectedRevision"
    > = {},
  ): Promise<boolean> {
    if (!full || mutationFlight.current || compacting) return false;
    const settingsMutation = name === "settings";
    if (settingsMutation && (!settingsScopeMatches || !settings?.available)) return false;
    const readRevision = name === "settings" ? settings?.revision : goal?.revision;
    if (live?.revision !== undefined && readRevision !== live.revision) return false;
    const generation = loadGeneration.current;
    const mutation = Symbol("settings-or-goal");
    mutationFlight.current = mutation;
    changingSettings.current = settingsMutation;
    setSaving(true);
    setMutationError("");
    try {
      const result = await codexAction(name, fields);
      if (!result || mutationFlight.current !== mutation) return false;
      if (name === "goal-set" && startupGoal) onStartupGoalHandled?.(true);
      if (settingsMutation && generation !== loadGeneration.current) return false;
      if (settingsMutation) {
        setPendingSettings({ ...fields, expectedRevision: readRevision ?? 0 });
      }
      if (name.startsWith("goal-")) {
        goalDraftRevision.current = undefined;
        setGoalDirty(false);
      }
      await load(false, settingsMutation ? "settings" : undefined);
      return true;
    } catch (error) {
      if (mutationFlight.current === mutation && generation === loadGeneration.current)
        setMutationError(unavailable(error));
      return false;
    } finally {
      if (mutationFlight.current === mutation) {
        mutationFlight.current = undefined;
        changingSettings.current = false;
        setSaving(false);
      }
    }
  }

  const settingsReadStale = live?.revision !== undefined && settings?.revision !== live.revision;
  const goalReadStale = live?.revision !== undefined && goal?.revision !== live.revision;
  const closeAdd = () => {
    setAddOpen(false);
  };
  const openGoal = () => {
    closeAdd();
    if (!goalReadable && (offersGoalDraft || startupGoal)) {
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
    if (preparesSettings && settingsPreparation.current) return;
    if (
      preparesSettings &&
      feature("settings")?.available &&
      access?.bootId &&
      selected &&
      live?.revision !== undefined &&
      (!live.executionMode || live.executionMode === "claude-managed") &&
      !running &&
      !settingsPreparation.current
    ) {
      const generation = loadGeneration.current;
      const preparation = Symbol("settings-prepare");
      settingsPreparation.current = preparation;
      setPreparingSettings(true);
      setSettingsError("");
      void client
        .prepareSessionSettings({
          sessionId: selected,
          bootId: access.bootId,
          expectedRevision: live.revision,
        })
        .then((value) => {
          if (generation === loadGeneration.current) applySettings(value);
        })
        .catch((error: unknown) => {
          if (generation === loadGeneration.current) setSettingsError(unavailable(error));
        })
        .finally(() => {
          // Observation changes invalidate response data, but must still release
          // this request's busy state. A different visit may own a new request.
          if (settingsPreparation.current === preparation) {
            settingsPreparation.current = undefined;
            setPreparingSettings(false);
          }
        });
      return;
    }
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
  // DeepSeek Harness's permission preset changes at once during a turn; its model waits.
  const presetWhileRunning =
    running && managedAgent === "deepseek-harness" && settings?.writable.policy?.available === true;
  const parsedBudget = goalBudget ? Number(goalBudget) : undefined;
  const budgetValid =
    parsedBudget === undefined || (Number.isSafeInteger(parsedBudget) && parsedBudget > 0);
  const goalDraftEditor = goalDialog?.kind === "draft" ? goalDialog : undefined;
  const goalDraftDisabled =
    !offersGoalDraft ||
    disabled ||
    !online ||
    !controlReady ||
    busy ||
    saving ||
    compacting ||
    notice === "uncertain";
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
  // Codex's execution policies; for DeepSeek Harness, its permission presets.
  // The host names policies in English only; show Codex's and DeepSeek Harness's own wording
  // per locale, and the host's text for an id neither knows.
  const policyText = (item: { id: string; name: string; description?: string }) => {
    const label =
      current?.agent === "deepseek-harness"
        ? dshPolicyLabel(item.id, locale)
        : codexPolicyLabel(item.id, locale);
    return { name: label?.name ?? item.name, description: label?.description ?? item.description };
  };
  const isCodex = current?.agent === "codex";
  const liveSettings =
    live?.sessionId === selected && live.settings?.sessionId === selected
      ? live.settings
      : undefined;
  const liveSelection = liveSettings && settingsSelection(liveSettings, isClaude);
  const liveReport =
    liveSelection?.modelId || liveSelection?.effort ? liveSelection : liveSettings?.current;
  const scopedSettings = settingsScopeMatches ? settings : undefined;
  const selection = scopedSettings && settingsSelection(scopedSettings, isClaude);
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
    (!live ||
      (live.sessionId === selected &&
        (live.status === "idle" || live.status === "unsupported") &&
        !live.executionLocation)) &&
    !compacting;
  const fallbackSettings = canShowCodexFallback ? scopedSettings : undefined;
  const historicalSettings = fallbackSettings?.historicalSettings;
  // Older Codex sessions can show a known model without prefilling the settings form.
  const visibleSettings =
    reportedSettings?.modelId || reportedSettings?.effort
      ? reportedSettings
      : historicalSettings?.modelId
        ? historicalSettings
        : fallbackSettings?.defaults.modelId
          ? fallbackSettings.defaults
          : undefined;
  const visibleModel = visibleSettings?.modelId;
  const visibleModelName = modelOption(scopedSettings ?? liveSettings, visibleModel)?.name;
  const visibleTier =
    visibleSettings &&
    "serviceTierId" in visibleSettings &&
    typeof visibleSettings.serviceTierId === "string"
      ? visibleSettings.serviceTierId
      : undefined;
  const retainRememberedModel =
    isCodex &&
    ((permissionsOnlyPending && canShowCodexFallback) ||
      (settingsOnlyBlocked &&
        settingsNotice?.status === "uncertain" &&
        (!live ||
          (live.sessionId === selected &&
            !live.executionLocation &&
            ["idle", "unsupported", "outcome-unknown"].includes(live.status))) &&
        !compacting));
  // A remembered label is only for the trigger. Settings and writes still use the current read.
  const cachedModel =
    !reportedSettings?.modelId &&
    (retainRememberedModel ||
      (!visibleModel && !visibleSettings?.effort && (!isCodex || canShowCodexFallback)))
      ? readSessionModelDisplay(client, access, selected, currentAgent)
      : undefined;
  const displayFallback =
    cachedModel ??
    (visibleModel && !reportedSettings?.modelId
      ? {
          modelId: visibleModel,
          effort: visibleSettings?.effort,
          name: visibleModelName,
          serviceTierId: visibleTier,
        }
      : undefined);
  useEffect(() => {
    if (!visibleModel || cachedModel) return;
    rememberSessionModelDisplay(client, access, selected, currentAgent, {
      modelId: visibleModel,
      name: visibleModelName,
      effort: visibleSettings?.effort,
      serviceTierId: visibleTier,
    });
  }, [
    access,
    client,
    selected,
    currentAgent,
    visibleModel,
    visibleModelName,
    visibleSettings?.effort,
    visibleTier,
    cachedModel,
  ]);
  const showModelPicker = settingsReadable || reservesModelSlot || !!cachedModel;
  const settingsControlScope = JSON.stringify([
    selected,
    access?.bootId,
    access?.device?.id,
    access?.device?.advancedControl,
  ]);
  const permissionsUseMode = isClaude || isDevin;
  const permissionTitle = permissionsUseMode ? agentCopy.permission : copy.executionPolicy;
  const settingsLocked =
    disabled ||
    busy ||
    saving ||
    compacting ||
    preparingSettings ||
    settingsReadStale ||
    !scopedSettings?.available ||
    feature("settings")?.available !== true ||
    settingsNotice?.status === "uncertain" ||
    notice === "uncertain" ||
    live?.status === "outcome-unknown";
  const permissionsLocked = settingsLocked || (running && !presetWhileRunning);
  const collaboration = sessionCollaborationMode(scopedSettings, selection);
  const clearSavedMode =
    isCodex &&
    !collaboration &&
    scopedSettings?.writable.mode.available &&
    !!scopedSettings.selected?.mode;
  const collaborationLocked =
    settingsLocked || !collaboration?.writable || (running && managedAgent !== "deepseek-harness");
  const canClearSavedMode = clearSavedMode && !settingsLocked && !running;
  const canTurnOffPlan =
    (!collaborationLocked && collaboration?.modes.includes("default")) || canClearSavedMode;
  const planOn =
    (collaboration?.field
      ? selection?.[collaboration.field]
      : (selection?.mode ?? selection?.permissionMode)) === "plan";
  const planAvailable = full && !collaborationLocked && !!collaboration?.modes.includes("plan");
  const toggledMode = planOn ? "default" : "plan";
  useEffect(() => {
    onPlan?.({ on: planOn, available: planAvailable });
  }, [onPlan, planOn, planAvailable]);
  const permissionModes = scopedSettings?.options.permissionModes;
  const permissionChoices = permissionsUseMode
    ? newSessionPermissions(
        isClaude ? "claude-code" : "devin",
        { available: true, permissionModes },
        locale,
      )?.choices
    : undefined;
  const permissionItems = permissionsUseMode
    ? (permissionModes ?? []).flatMap(({ id }) => {
        const choice = permissionChoices?.find((item) => item.id === id);
        return choice
          ? [
              {
                ...choice,
                disabled:
                  permissionsLocked || scopedSettings?.writable.permissionMode?.available !== true,
                selected: id === selection?.permissionMode,
                change: { permissionMode: id },
              },
            ]
          : [];
      })
    : (scopedSettings?.options.policies ?? []).map((item) => {
        const label = policyText(item);
        return {
          id: item.id,
          name: label.name,
          description: label.description ?? "",
          risky: item.id === "danger-full-access",
          disabled: permissionsLocked || scopedSettings?.writable.policy?.available !== true,
          selected: item.id === selection?.policyId,
          change: { policyId: item.id },
        };
      });
  const currentPermissionId = permissionsUseMode ? selection?.permissionMode : selection?.policyId;
  const currentPermission = permissionItems.find((item) => item.id === currentPermissionId);
  const permissionFeature = permissionsUseMode
    ? scopedSettings?.writable.permissionMode
    : scopedSettings?.writable.policy;
  const showPermissions =
    reservesPermissionSlot ||
    (settingsReadable && (isCodex || permissionsUseMode || !!permissionItems.length));
  const permissionTriggerLocked = disabled || (reservesPermissionSlot && !settingsReadable);
  const writeStatus =
    settingsNotice?.status === "uncertain"
      ? layout.settingsUnknown
      : settingsNotice?.status === "notDispatched"
        ? settingsNotice.reason
          ? reason(settingsNotice.reason)
          : t.notDispatched
        : undefined;
  const permissionWriteStatus = settingsNotice?.target === "permissions" ? writeStatus : undefined;
  const modelWriteStatus = settingsNotice?.target === "model" ? writeStatus : undefined;
  const settingsStatus =
    reservesModelSlot && !settingsReadable
      ? (reasonTitle(settingsReadReason) ??
        (capabilities?.sessionId === selected ? copy.settingUnavailable : layout.connecting))
      : mutationError || settingsError
        ? reason(mutationError || settingsError)
        : preparingSettings || settingsReadStale
          ? layout.connecting
          : !scopedSettings?.available
            ? (reasonTitle(scopedSettings?.reason) ?? copy.settingUnavailable)
            : !settingsNotice &&
                settingsChangedHere &&
                scopedSettings.applicationStatus === "unknown"
              ? layout.settingsUnknown
              : running
                ? presetWhileRunning
                  ? copy.settingsWhileRunningModel
                  : copy.settingsWhileRunning
                : feature("settings")?.available !== true
                  ? reasonTitle(feature("settings")?.reason)
                  : undefined;
  const permissionsStatus =
    permissionWriteStatus ??
    (presetWhileRunning && !settingsLocked && permissionFeature?.available
      ? undefined
      : (settingsStatus ??
        (permissionItems.every((item) => item.disabled)
          ? reasonTitle(permissionFeature?.reason)
          : undefined)));
  const changePermissionsOpen = (open: boolean) => {
    setPermissionsOpen(open);
    if (open) prepareSettings();
  };
  const changePermission = (id: string) => {
    const item = permissionItems.find((item) => item.id === id);
    if (item && !item.disabled && !item.selected) return mutate("settings", item.change);
  };
  const changeCollaboration = (mode: "default" | "plan") => {
    if (
      !collaborationLocked &&
      collaboration?.modes.includes(mode) &&
      mode !== collaboration.selected
    )
      void mutate("settings", collaboration.change(mode));
  };
  const clearCollaboration = () => {
    if (canClearSavedMode) void mutate("settings", { mode: null });
  };
  const turnOffPlan = () => {
    if (canClearSavedMode) clearCollaboration();
    else changeCollaboration("default");
  };
  const changeAddOpen = (open: boolean) => {
    if (!open) {
      closeAdd();
      return;
    }
    setAddOpen(true);
    void load();
  };
  const openModel = (page: "models" | "effort") => {
    if (!full || disabled || !settingsReadable || !modelPicker.current) return false;
    modelPicker.current.open(page);
    return true;
  };
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
      if (!planOn) changeCollaboration("plan");
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
                openModel(noticeReason?.includes("effort") ? "effort" : "models");
              }}
            >
              {copy.changeNextTurnModel}
            </Button>
          </div>
        )}
      <ComposerToolbar
        leading={
          <>
            <SessionComposerAddMenu
              locale={locale}
              label={copy.addContext}
              disabled={disabled}
              open={addOpen}
              onOpenChange={changeAddOpen}
              attachment={
                attachmentOffered
                  ? { disabled: disabled || !attachmentAllowed, onPick: openPhoneFiles }
                  : undefined
              }
              resources={
                resourcesReadable
                  ? {
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
                  : undefined
              }
              goal={
                goalReadable || offersGoalDraft
                  ? { selected: !!(startupGoal || persistedGoal) || undefined, onOpen: openGoal }
                  : undefined
              }
              plan={
                collaboration && settingsReadable
                  ? {
                      active: planOn,
                      disabled: collaborationLocked || !collaboration.modes.includes(toggledMode),
                      reason: settingsStatus ?? reasonTitle(collaboration.reason),
                      onToggle: () => changeCollaboration(toggledMode),
                    }
                  : undefined
              }
              clearMode={
                clearSavedMode
                  ? {
                      disabled: settingsLocked || running,
                      onClear: clearCollaboration,
                    }
                  : undefined
              }
            />
            {showPermissions && (
              <ComposerPermissionMenu
                title={permissionTitle}
                label={currentPermission?.name ?? permissionTitle}
                risky={currentPermission?.risky}
                disabled={permissionTriggerLocked}
                disabledReason={permissionTriggerLocked ? permissionsStatus : undefined}
                side="top"
                items={permissionItems}
                selected={currentPermission?.id}
                open={permissionsOpen}
                onOpenChange={changePermissionsOpen}
                status={permissionsStatus}
                blockItemsOnStatus={false}
                onSelect={(id) => void changePermission(id)}
              />
            )}
            {planOn && (
              <ComposerModeChip
                mode="plan"
                locale={locale}
                disabled={!canTurnOffPlan}
                onRemove={turnOffPlan}
              />
            )}
            {(persistedGoal || startupGoal) && (
              <ComposerModeChip
                mode="goal"
                locale={locale}
                detail={persistedGoal?.objective ?? goalObjective}
                disabled={!persistedGoal && (saving || disabled)}
                onOpen={openGoal}
                onRemove={!persistedGoal && onStartupGoalDiscarded ? discardStartupGoal : undefined}
              />
            )}
          </>
        }
        trailing={
          <>
            {advancedActions}
            {showContextUsage && (
              <ContextUsageGauge
                fallback={currentUsageSettings?.usage}
                capacity={usageCapacity}
                source={provider?.contextUsage}
                usageRef={usage}
              />
            )}
            {showModelPicker && (
              <ComposerModelPicker
                key={settingsControlScope}
                locale={locale}
                settings={scopedSettings}
                selection={selection}
                reportedSettings={reportedSettings}
                displayFallback={displayFallback}
                provider={provider}
                clearEffort={canClearEffort}
                disabled={disabled || !settingsReadable}
                triggerDisabled={reservesModelSlot && !settingsReadable}
                modelDefault={
                  reservesModelSlot && !settingsReadable ? false : provider?.models.modelDefault
                }
                saving={settingsLocked || running}
                status={modelWriteStatus ?? settingsStatus}
                pickerRef={modelPicker}
                onOpen={prepareSettings}
                onChange={(change) =>
                  settingsLocked || running ? Promise.resolve(false) : mutate("settings", change)
                }
              />
            )}
            {action}
          </>
        }
      />
      {permissionWriteStatus && (showPermissions || collaboration) && !permissionsOpen && (
        <p role="status" className="px-3 text-xs text-muted-foreground">
          {permissionWriteStatus}
        </p>
      )}
      {writeStatus && settingsNotice?.target === "settings" && (
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
