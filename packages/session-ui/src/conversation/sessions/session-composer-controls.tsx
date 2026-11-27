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
  type Access,
  type ConversationSessionSummary,
  type Live,
  type SessionAction,
  type SessionActionBody,
  type SessionCapabilities,
  type SessionGoalState,
  type SessionResource,
  type SessionResources,
  type SessionSettings,
  type SessionSettingValues,
  type WebClient,
} from "@agentkib/web-client";
import { subscribeSessionInvalidation } from "@agentkib/conversation-state";
import { ComposerGoalFields, composerGoalCopy } from "../../composer-add-menu";
import { mergePreparedCatalog, prepareComposerSettings } from "../../composer-settings-preparation";
import {
  runComposerSettingsMutation,
  type ComposerMutationFields,
} from "../../composer-settings-mutation";
import {
  composerSettingsSelection,
  projectComposerSettingsControls,
  composerSettingsWriteLocked,
  confirmsComposerSettings,
  type PendingComposerSettings,
} from "../../composer-session-settings";
import { contextUsagePercent } from "../../context-usage";
import { DelayedSpinner } from "../../loading-feedback";
import { sessionTurnStatus } from "../../session-turn-status";
import type { ContextUsageHandle } from "../../context-usage-indicator";
import type { InteractionLocale } from "../../interaction-model";
import { parseGoalDraft, type NewSessionGoalDraft } from "../../new-session-draft";
import {
  existingSessionComposerCapabilities,
  useComposerFollowerSettings,
} from "../../session-composer-capabilities";
import { SessionComposerToolbar } from "../../session-composer-toolbar";
import { SessionContextUsageGauge } from "../../session-context-usage-gauge";
import { settingsNoticeGroup } from "../../session-control-receipts";
import { useSessionPlatform } from "../../session-platform";
import { sessionModelSettings } from "../../agents/session-model-settings";
import { resolveSessionProvider, sessionProviderControlsDisabled } from "../../session-provider";
import { useComposerModelPanel } from "../../use-composer-model-panel";
import { useComposerModelDisplay } from "../../use-composer-model-display";
import { composerLayoutCopy, composerSettingsStatus, composerTerm } from "./composer-layout-copy";
import { sessionAgentCopy } from "./session-agent-copy";
import { sessionCopyForSurface, sessionReason } from "./session-copy";

/** Opens composer controls; false when this device or session cannot show them now. */
export type ComposerControlsHandle = {
  open(panel: "permissions" | "usage" | "models" | "effort" | "goal"): boolean;
  /** Turns plan mode on, as `/plan` does in Codex's composer; false when this session cannot. */
  plan(): boolean;
};
/** Whether plan mode is on, and whether the composer can turn it on. */
export type ComposerPlanState = { on: boolean; available: boolean };

type SettingsGroup = "permissions" | "model" | "settings";
type SettingsNotice = {
  target?: SettingsGroup;
  group?: SettingsGroup;
  status: "writing" | "uncertain" | "notDispatched";
  reason?: string;
};

type ComposerControlsSession = {
  blocksOutcome?(action: SessionAction): boolean;
  current?: ConversationSessionSummary;
  selected: string;
  client: WebClient;
  access?: Access;
  locale: InteractionLocale;
  live?: Live;
  busy: boolean;
  online: boolean;
  controlReady: boolean;
  refresh?(manual: boolean): Promise<unknown>;
  runSessionAction: (
    action: SessionAction,
    fields?: Partial<SessionActionBody>,
  ) => Promise<unknown>;
  capabilities?: SessionCapabilities;
  usageEpoch: string;
  notice?: string;
  noticeReason?: string;
  settingsChangedHere?: boolean;
  settingsNotice?: SettingsNotice;
  settingsOnlyBlocked?: boolean;
  t?: { notDispatched: string };
};

export type SessionComposerControlsProps = {
  session: ComposerControlsSession;
  composerCapabilities?: ReturnType<typeof existingSessionComposerCapabilities>;
  resources: SessionResource[];
  setResources: (resources: SessionResource[]) => void;
  openPhoneFiles: () => void;
  disabled: boolean;
  action?: ReactNode;
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

function modelReadDenied(error: unknown) {
  return error instanceof ApiError && [401, 403, 404, 410].includes(error.status);
}

export function SessionComposerControls({
  session,
  composerCapabilities,
  resources,
  setResources,
  openPhoneFiles,
  disabled,
  action,
  controlsRef,
  onPlan,
  startupGoal,
  onStartupGoalHandled,
  onStartupGoalDiscarded,
  onStageGoal,
}: SessionComposerControlsProps) {
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
    runSessionAction,
    capabilities,
    usageEpoch,
    notice,
    noticeReason,
    settingsChangedHere,
    settingsNotice,
    settingsOnlyBlocked,
    t,
  } = session;
  const {
    kind,
    components: { Button, SessionDialog },
    copy: platformCopy,
  } = useSessionPlatform();
  const desktop = kind === "desktop";
  const copy = sessionCopyForSurface(locale, kind);
  const declaration = resolveSessionProvider(
    current?.id === selected ? current : undefined,
    capabilities,
  );
  const registeredSettings = declaration && "models" in declaration ? declaration : undefined;
  const nativeAppSettings = declaration?.connection?.kind === "native-app";
  const settingsAgent = managedAgentOf(current?.agent);
  const providerDisabled = sessionProviderControlsDisabled(
    access,
    current?.id === selected ? current.agent : undefined,
    live?.sessionId === selected && live.reason
      ? live.reason
      : capabilities?.sessionId === selected
        ? capabilities.reason
        : undefined,
  );
  const managedAgent = nativeAppSettings ? null : settingsAgent;
  const modelPanel = useComposerModelPanel();
  const usageGauge = useRef<ContextUsageHandle>(null);
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
    settingsReadReason,
    modelRegistered,
    permissionRegistered,
    reservesModelSlot,
    reservesPermissionSlot,
    goalReadable: canReadGoal,
    goalDraftOffered,
    planOffered,
    resourcesReadable,
    resourcesOffered,
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
  const reason = (code?: string) =>
    sessionReason(locale, code, kind, platformCopy.unavailableReason).text;
  const reasonTitle = (code?: string) => (code ? reason(code) : undefined);
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
  const goalDraftRevision = useRef<number | undefined>(undefined);
  const attemptedStartupGoal = useRef<NewSessionGoalDraft | undefined>(undefined);
  const [goalDirty, setGoalDirty] = useState(false);
  const full = access?.device?.accessMode === "full";
  const applyingStartupGoal = startupGoal?.apply === true;
  const displayAgent =
    current?.id === selected && (desktop || current.availability === "readable")
      ? current.agent
      : undefined;
  const modelDisplayScope = useRef({ access, agent: displayAgent });
  modelDisplayScope.current = { access, agent: displayAgent };
  const [goalDialog, setGoalDialog] = useState<
    { kind: "goal" } | { kind: "goal-draft"; objective?: string; budget?: string }
  >();
  const offersGoalDraft =
    goalRegistered && goalDraftOffered && feature("goal-set")?.available !== true && !!onStageGoal;
  const goalDraftEditor = goalDialog?.kind === "goal-draft" ? goalDialog : undefined;
  const editingGoalDraft = goalDraftEditor !== undefined;
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
    value: SessionSettings;
  }>();
  const settingsExecutionScope = JSON.stringify([live?.executionMode, live?.connectionGeneration]);
  const { follower, writeScope, rememberRead, followerAuthority } = useComposerFollowerSettings(
    client,
    access,
    selected,
    live,
  );
  const settingsExecution = useRef<string | undefined>(undefined);
  const settings = desktop
    ? settingsSource?.scope === historyScope && settingsSource.client === client
      ? settingsSource.value
      : undefined
    : settingsSource?.value;
  const settingsScopeMatches =
    settings?.sessionId === selected &&
    resourceScope.current.client === client &&
    resourceScope.current.bootId === access?.bootId &&
    resourceScope.current.deviceId === access?.device?.id &&
    resourceScope.current.advancedControl === access?.device?.advancedControl;
  const scopedSettings = desktop || settingsScopeMatches ? settings : undefined;
  const settingsReceiptUncertain = settingsNotice?.status === "uncertain";
  const settingsUnknown =
    settingsReceiptUncertain ||
    (settingsChangedHere && scopedSettings?.applicationStatus === "unknown");
  const provider =
    (scopedSettings?.sessionId === selected ? scopedSettings?.provider : undefined) ??
    registeredSettings;
  const usesVariants = provider?.models.selection === "variants";
  const preparesSettings = provider?.models.prepare === true;
  const nativeModels = sessionModelSettings(registeredSettings);
  const currentLive = live?.sessionId === selected ? live : undefined;
  const canPrepareSettings =
    preparesSettings &&
    (nativeModels?.managed(currentLive) ||
      (!desktop && (!live || currentLive) && !live?.execution && !live?.executionMode));
  const [settingsRead, setSettingsRead] = useState<{
    scope: string;
    client: typeof client;
    revision: number;
    values?: SessionSettings["historicalSettings"];
    usage?: SessionSettings["usage"];
    defaults?: SessionSettings["defaults"];
  }>();
  const [goal, setGoal] = useState<SessionGoalState>();
  const [context, setContext] = useState<SessionResources>();
  const [settingsError, setSettingsError] = useState("");
  const [goalError, setGoalError] = useState("");
  const [contextError, setContextError] = useState("");
  const [mutationFailure, setMutationFailure] = useState<{
    scope: string;
    client: typeof client;
    kind: "settings" | "goal";
    reason: string;
  }>();
  const mutationError =
    !desktop || (mutationFailure?.scope === historyScope && mutationFailure.client === client)
      ? mutationFailure
      : undefined;
  const [resourceWarning, setResourceWarning] = useState("");
  const [saving, setSaving] = useState(false);
  const [settingWrite, setSettingWrite] = useState<{
    scope: string;
    control: "permission" | "plan";
    fields: ComposerMutationFields;
  }>();
  const [goalReloading, setGoalReloading] = useState(false);
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
      !settingsReceiptUncertain &&
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
  const pendingModelSettings =
    !!pendingSettings && settingsNoticeGroup(pendingSettings) !== "permissions";
  const [objective, setObjective] = useState("");
  const [tokenBudget, setTokenBudget] = useState("");
  const compacting = live?.activity === "compacting";
  const running = live?.status !== "idle" || compacting;
  const turnActive = !!sessionTurnStatus(selected, live, current?.externalTurn);
  const activeWrite = settingWrite?.scope === historyScope ? settingWrite : undefined;
  const history =
    full &&
    access.device?.advancedControl === true &&
    settingsRead?.scope === historyScope &&
    settingsRead.client === client
      ? settingsRead
      : undefined;
  const canShowModelFallback =
    (nativeAppSettings
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
    (value: SessionSettings, fromLive = false) => {
      if (value.sessionId !== selected) return;
      if (!fromLive) rememberRead(value);
      settingsExecution.current = settingsExecutionScope;
      setSettingsSource((previous) => {
        const source = { scope: historyScope, client, execution: settingsExecutionScope };
        if (desktop || !fromLive || previous?.value.sessionId !== value.sessionId)
          return { ...source, value };
        const registered = value.provider ?? previous.value.provider;
        const usageSource = registered?.contextUsage ?? registeredSettings?.contextUsage;
        const keepHistory =
          previous.value.usage?.historical &&
          (usageSource !== "last-request" || previous.value.revision === value.revision);
        return {
          ...source,
          value: {
            ...value,
            provider: registered,
            historicalSettings: value.historicalSettings ?? previous.value.historicalSettings,
            usage: keepHistory ? previous.value.usage : value.usage,
          },
        };
      });
    },
    [
      client,
      desktop,
      registeredSettings,
      historyScope,
      rememberRead,
      selected,
      settingsExecutionScope,
    ],
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
          const readGoal = flight.sections.has("goal") && (!desktop || goalReadable);
          flight.sections.clear();
          flight.background = true;
          await Promise.all([
            (async () => {
              if (!readSettings) return;
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
                // Desktop ties history to the last authorized HTTP read, independently of live.
                if (desktop)
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
                const denied = modelReadDenied(error);
                if (denied) {
                  forgetSessionModelDisplay(
                    client,
                    desktop ? modelDisplayScope.current.access : displayScope.access,
                    selected,
                    desktop ? displayAgent : displayScope.agent,
                  );
                  settingsPreparation.current = undefined;
                  setPreparingSettings(false);
                }
                if ((readVersion === settingsReadVersion.current && !quiet) || denied) {
                  setSettingsSource(undefined);
                  if (desktop) setSettingsRead(undefined);
                  setSettingsError(unavailable(error));
                }
              }
            })(),
            (async () => {
              if (!readGoal) return;
              try {
                const value = goalReadable
                  ? managedAgent
                    ? await client.sessionGoals(selected, managedAgent)
                    : await client.codexGoals(selected)
                  : undefined;
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
      desktop,
      displayAgent,
      full,
      historyScope,
      selected,
      managedAgent,
      settingsAgent,
      settingsReadable,
      goalReadable,
    ],
  );

  const resetScope = desktop ? historyScope : access?.device?.advancedControl;
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
      advancedControl: access?.device?.advancedControl,
    };
    setGoalDialog(undefined);
    setPermissionOpen(false);
    setAddOpen(false);

    setSaving(false);
    setSettingWrite(undefined);
    setGoalReloading(false);
    if (desktop) mutationFlight.current = undefined;
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
      changingSettings.current = false;
      settingsPreparation.current = undefined;
      contextGeneration.current++;
      contextAbort.current?.abort();
    };
  }, [selected, setResources, client, access?.bootId, access?.device?.id, desktop, resetScope]);

  const webAdvancedControl = desktop ? undefined : access?.device?.advancedControl;
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
    webAdvancedControl,
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
      if (!domains.some((domain) => ["settings", "goal", "usage", "ownership"].includes(domain)))
        return;
      const includeGoal = desktop
        ? domains.includes("goal") ||
          (domains.includes("ownership") && !domains.includes("settings"))
        : !changingSettings.current || domains.includes("goal");
      void load(true, includeGoal ? undefined : "settings");
    });
  }, [client, desktop, full, load, online, selected]);

  const desktopGoalDialog = desktop ? goalDialog?.kind : undefined;
  const desktopApplyingStartupGoal = desktop && applyingStartupGoal;
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
      void load(
        true,
        (
          desktop
            ? desktopGoalDialog === "goal" || desktopApplyingStartupGoal
            : !changingSettings.current
        )
          ? undefined
          : "settings",
      );
  }, [
    desktop,
    full,
    load,
    online,
    selected,
    live?.sessionId,
    live?.status,
    live?.revision,
    desktopGoalDialog,
    desktopApplyingStartupGoal,
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
        source &&
        (desktop
          ? source.scope === historyScope && source.client === client
          : !source.value.usage?.historical)
          ? { ...source, value: { ...source.value, usage: live.usage } }
          : source,
      );
    }
  }, [applySettings, client, desktop, historyScope, live, selected, settings?.sessionId]);

  useEffect(() => {
    if (live?.sessionId !== selected || !live.goal) return;
    const currentGoal = live.goal;
    setGoal((value) => (value?.sessionId === selected ? { ...value, goal: currentGoal } : value));
  }, [live, selected]);

  useEffect(() => {
    if (
      !confirmsComposerSettings(settings, pendingSettings, {
        prepared: preparesSettings,
        variants: usesVariants,
        follower,
      })
    )
      return;
    setPendingSettings(undefined);
  }, [follower, preparesSettings, pendingSettings, settings, usesVariants]);

  function mutate(
    name: SessionAction,
    fields: ComposerMutationFields = {},
    control?: "permission" | "plan",
  ) {
    const changesSettings = name === "settings";
    return runComposerSettingsMutation({
      action: name,
      fields,
      permitted: full && !compacting && (!changesSettings || !turnActive),
      settingsAllowed:
        !!settings?.available &&
        (desktop ? !settingsUnknown : settingsScopeMatches && !settingsReceiptUncertain) &&
        !settingsReadStale &&
        (capabilities?.sessionId !== selected || feature("settings")?.available === true),
      readRevision: changesSettings ? settings?.revision : goal?.revision,
      liveRevision: live?.revision,
      follower: follower ? { authority: followerAuthority, writeScope } : undefined,
      flight: mutationFlight,
      loadGeneration,
      send: runSessionAction,
      onStart: () => {
        if (!desktop) changingSettings.current = changesSettings;
        setSaving(true);
        if (control) setSettingWrite({ scope: historyScope, control, fields });
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
      refresh: () => load(false, changesSettings ? "settings" : undefined),
      onError: (error) =>
        setMutationFailure({
          scope: historyScope,
          client,
          kind: changesSettings ? "settings" : "goal",
          reason: unavailable(error),
        }),
      onSettle: () => {
        changingSettings.current = false;
        setSaving(false);
        setSettingWrite(undefined);
      },
    });
  }

  const settingsReadStale =
    !settingsReadable ||
    (follower && feature("settings")?.available === true && !writeScope) ||
    (desktop ? settingsSource?.execution : settingsExecution.current) !== settingsExecutionScope ||
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
  const goalActionDisabled = (action: keyof SessionGoalState["actions"]) =>
    goalActionsLocked ||
    !goalSnapshot?.actions?.[action]?.available ||
    feature(`goal-${action}`)?.available !== true;
  const goalActionTitle = (action: keyof SessionGoalState["actions"]) =>
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
          settingsExecution.current = settingsExecutionScope;
          if (currentRead) applySettings(value);
          else
            setSettingsSource((previous) => ({
              scope: historyScope,
              client,
              execution: settingsExecutionScope,
              value:
                previous &&
                (desktop
                  ? previous.scope === historyScope && previous.client === client
                  : previous.value.sessionId === selected)
                  ? mergePreparedCatalog(previous.value, value)
                  : value,
            }));
        },
        onError: (error) => setSettingsError(unavailable(error)),
        onSettle: () => setPreparingSettings(false),
      })
    )
      return;
    const ready = !!settings?.available && !settingsReadStale && !settingsError;
    if (desktop || !ready) void load(ready, "settings");
  };
  const displayedSettings = scopedSettings
    ? desktop && settingsUnknown
      ? scopedSettings.current
      : composerSettingsSelection(scopedSettings, preparesSettings, {
          live,
          staged: pendingSettings,
        })
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
    live?.sessionId === selected &&
    live.settings?.sessionId === selected &&
    (!desktop ||
      (provider !== undefined &&
        !preparesSettings &&
        live.settings.revision >= (settings?.revision ?? 0)))
      ? live.settings
      : undefined;
  const liveSelection =
    liveSettings && composerSettingsSelection(liveSettings, !desktop && preparesSettings);
  const liveReport =
    liveSelection?.modelId || liveSelection?.effort ? liveSelection : liveSettings?.current;
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
      (settingsOnlyBlocked === true && settingsNotice?.target === "permissions"));
  const modelApplicationPending =
    scopedSettings?.applicationStatus === "pending" &&
    !permissionsOnlyPending &&
    (!nativeAppSettings || !canDisplayCodexModelFallback(scopedSettings));
  const webReportedSettings =
    (nativeAppSettings || !scopedSettings) &&
    !modelApplicationPending &&
    (liveReport?.modelId || liveReport?.effort)
      ? liveReport
      : displayedSettings?.modelId || displayedSettings?.effort || !nativeAppSettings
        ? displayedSettings
        : scopedSettings?.current;
  const reportedSettings = desktop
    ? !settingsUnknown && settings?.applicationStatus !== "pending" && !pendingModelSettings
      ? liveReport
      : undefined
    : webReportedSettings;
  const claudeReadFallbackAllowed =
    preparesSettings &&
    !settingsUnknown &&
    notice !== "uncertain" &&
    live?.status !== "outcome-unknown" &&
    live?.reason !== "control-outcome-unconfirmed" &&
    capabilities?.reason !== "control-outcome-unconfirmed";
  const claudeHistoricalModel = claudeReadFallbackAllowed
    ? scopedSettings?.historicalSettings
    : undefined;
  const webFallbackSettings =
    nativeAppSettings &&
    access?.device?.advancedControl === true &&
    !modelApplicationPending &&
    !pendingModelChange &&
    (!live || live.sessionId === selected)
      ? scopedSettings
      : undefined;
  const fallbackDefaults = claudeReadFallbackAllowed
    ? scopedSettings?.defaults
    : desktop
      ? nativeAppSettings && canShowModelFallback
        ? history?.defaults
        : undefined
      : webFallbackSettings?.defaults;
  const webHistorical = webFallbackSettings?.historicalSettings;
  // An observed older model is display-only and cannot prefill current settings.
  const observedModel: SessionSettingValues | undefined = desktop
    ? [
        reportedSettings,
        displayedSettings,
        settings?.current,
        claudeHistoricalModel,
        observedModelFallback,
      ].find((value) => value?.modelId)
    : reportedSettings?.modelId || (!preparesSettings && reportedSettings?.effort)
      ? reportedSettings
      : claudeHistoricalModel?.modelId
        ? claudeHistoricalModel
        : webHistorical?.modelId
          ? webHistorical
          : undefined;
  const historicalModel = desktop
    ? claudeHistoricalModel?.modelId
      ? claudeHistoricalModel
      : observedModelFallback
    : reportedSettings?.modelId
      ? undefined
      : observedModel;
  const {
    displayFallback: displayModelFallback,
    retainedEffortOptions,
    canBrowseModelSettings,
  } = useComposerModelDisplay({
    client,
    access,
    sessionId: selected,
    agent: displayAgent,
    denied: settingsAccessDenied,
    settingsReadable,
    reservesSlot: reservesModelSlot,
    provider,
    catalog: scopedSettings ?? liveSettings,
    observed: observedModel,
    historical: historicalModel,
    defaults: fallbackDefaults,
    holdCache: desktop
      ? settingsUnknown ||
        (nativeAppSettings &&
          !!pendingSettings &&
          !pendingModelSettings &&
          !displayedSettings?.modelId)
      : nativeAppSettings &&
        !reportedSettings?.modelId &&
        (permissionsOnlyPending || (settingsOnlyBlocked === true && settingsReceiptUncertain)),
    uncertain: desktop && settingsUnknown,
  });
  const changePermissionOpen = (open: boolean) => {
    setPermissionOpen(open);
    if (!open) return;
    const hasPermissionOptions = desktop
      ? registeredSettings?.permissionField === "permissionMode"
        ? settings?.options.permissionModes?.length
        : settings?.options.policies.length
      : permissionItems.length > 0;
    if (scopedSettings?.available && !settingsReadStale && !settingsError && hasPermissionOptions) {
      if (preparesSettings) void load(true, "settings");
    } else prepareSettings();
  };
  const closeAdd = () => {
    setAddOpen(false);
  };
  const openGoal = () => {
    if (!goalRegistered) return;
    closeAdd();
    if (offersGoalDraft || (!desktop && !goalReadable && startupGoal)) {
      const objective = startupGoal?.value.objective ?? "";
      const budget = startupGoal?.value.tokenBudget?.toString() ?? "";
      if (desktop) {
        // Keep background native reads from replacing the local draft.
        goalDraftRevision.current = goalSnapshot?.revision ?? 0;
        setGoalDirty(false);
        setObjective(objective);
        setTokenBudget(budget);
        setGoalDialog({ kind: "goal-draft" });
      } else {
        setGoalDialog({ kind: "goal-draft", objective, budget });
      }
      return;
    }
    setGoalDialog({ kind: "goal" });
    if (goalReadable && goalReadStale) reloadGoal();
  };
  const reloadGoal = () => {
    const generation = loadGeneration.current;
    setGoalReloading(true);
    void load(false, "goal").finally(() => {
      if (generation === loadGeneration.current) setGoalReloading(false);
    });
  };
  const openModel = (page: "models" | "effort", refresh = false) =>
    modelPanel.open(
      page,
      full && !disabled && modelRegistered && !modelTriggerLocked && settingsReadable,
      refresh,
    );
  const stagedGoal = goalDirty ? undefined : startupGoal?.value;
  const disarmStartupGoal = () => {
    if (!startupGoal?.apply || attemptedStartupGoal.current === startupGoal.value) return;
    attemptedStartupGoal.current = startupGoal.value;
    onStartupGoalHandled?.(false);
  };
  const goalObjective = stagedGoal?.objective ?? objective;
  const goalBudget = stagedGoal ? (stagedGoal.tokenBudget?.toString() ?? "") : tokenBudget;
  // The live fallback is display-only until the host returns the selected goal snapshot.
  const savedGoal =
    goalReadable && !goalSnapshot && live?.sessionId === selected ? live.goal : activeGoal;
  const selectedGoalDetail = savedGoal
    ? `${term(savedGoal.status)} · ${savedGoal.objective}`
    : startupGoal && goalObjective;
  const goalDraftLocked =
    disabled ||
    saving ||
    (!session.blocksOutcome && notice === "uncertain") ||
    live?.status === "outcome-unknown" ||
    live?.reason === "control-outcome-unconfirmed" ||
    capabilities?.reason === "control-outcome-unconfirmed";
  const resetGoalDraftEditor = () => {
    goalDraftRevision.current = undefined;
    setGoalDirty(false);
    const goal = desktop ? savedGoal : activeGoal;
    setObjective(goal?.objective ?? "");
    setTokenBudget(goal?.tokenBudget?.toString() ?? "");
  };
  const closeGoal = () => {
    if (desktop && editingGoalDraft) resetGoalDraftEditor();
    setGoalDialog(undefined);
  };
  const goalChipLocked = desktop ? goalDraftLocked : saving || disabled;
  const discardStartupGoal = () => {
    if (
      savedGoal ||
      !startupGoal ||
      !onStartupGoalDiscarded ||
      goalChipLocked ||
      mutationFlight.current
    )
      return;
    if (!desktop) resetGoalDraftEditor();
    onStartupGoalDiscarded();
    if (desktop) resetGoalDraftEditor();
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
  const goalDraft = editingGoalDraft
    ? parseGoalDraft(
        goalDraftEditor.objective ?? goalObjective,
        goalDraftEditor.budget ?? goalBudget,
      )
    : undefined;
  const goalDraftDisabled = !offersGoalDraft || goalDraftLocked;
  const goalDraftTitle = !offersGoalDraft
    ? (reasonTitle(feature("goal-draft")?.reason) ?? copy.goalUnavailable)
    : undefined;
  const saveGoalDraft = () => {
    if (goalDraftDisabled || !goalDraft) return;
    onStageGoal?.(goalDraft);
    closeGoal();
  };
  const settingsWriteLocked = composerSettingsWriteLocked({
    settings: scopedSettings,
    online,
    busy: disabled || busy || saving || preparingSettings || turnActive,
    stale: settingsReadStale,
    uncertain:
      settingsUnknown ||
      !!session.blocksOutcome?.("settings") ||
      (!session.blocksOutcome && notice === "uncertain"),
    live,
    capabilities,
    feature: feature("settings"),
  });
  const menuTitle =
    registeredSettings?.permissionField === "permissionMode"
      ? agentCopy.permission
      : copy.executionPolicy;
  const {
    permissionItems,
    permissionField,
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
    provider: registeredSettings,
    settings: settingsAccessDenied ? undefined : scopedSettings,
    selection: settingsAccessDenied ? undefined : displayedSettings,
    live: settingsAccessDenied ? undefined : live,
    sessionId: selected,
    locale,
    locked: settingsWriteLocked,
    full,
    local: desktop,
    write: (fields, control) => mutate("settings", fields, control),
  });
  const nativePolicy =
    !settingsAccessDenied &&
    registeredSettings?.permissionField === "policyId" &&
    scopedSettings?.sessionId === selected
      ? scopedSettings.writable.policy
      : undefined;
  const nativePolicyReadOnlyReason =
    nativePolicy?.available === false && nativePolicy.reason?.startsWith("native-policy-")
      ? nativePolicy.reason
      : undefined;
  const previewPermission =
    activeWrite?.control === "permission"
      ? permissionItems.find(
          (item) => item.id === (activeWrite.fields.permissionMode ?? activeWrite.fields.policyId),
        )
      : undefined;
  const permissionCatalogEmpty =
    scopedSettings?.available &&
    permissionField?.available !== true &&
    !preparesSettings &&
    !permissionItems.length &&
    !permissionHint;
  const permissionTriggerLocked =
    providerDisabled ||
    disabled ||
    turnActive ||
    !!activeWrite ||
    permissionCatalogEmpty ||
    !!nativePolicyReadOnlyReason ||
    !online ||
    settingsAccessDenied ||
    (!settingsReadable && !reservesPermissionSlot && !permissionHint) ||
    permissionReadOnlyWithoutMenu;
  const permissionDisabledReason = providerDisabled
    ? undefined
    : turnActive
      ? copy.settingsWhileRunning
      : nativePolicyReadOnlyReason
        ? `${copy.nativePolicyReadOnly} ${reason(nativePolicyReadOnlyReason)}`
        : permissionTriggerLocked
          ? (reasonTitle(settingsReadReason || settingsError || permissionField?.reason) ??
            copy.settingUnavailable)
          : undefined;
  const modelTriggerLocked =
    providerDisabled ||
    turnActive ||
    settingsAccessDenied ||
    (!canBrowseModelSettings && !canOpenTerminalModel);
  const modelDisabledReason =
    modelTriggerLocked && !providerDisabled
      ? turnActive
        ? copy.settingsWhileRunning
        : (reasonTitle(settingsReadReason || settingsError || feature("settings")?.reason) ??
          copy.settingUnavailable)
      : undefined;
  useEffect(() => {
    onPlan?.({ on: planOn, available: planAvailable });
  }, [onPlan, planOn, planAvailable]);
  const localSettingsError =
    !settingsUnknown && !settingsNotice && mutationError?.kind === "settings"
      ? mutationError.reason
      : undefined;
  const writeStatus = composerSettingsStatus(
    locale,
    settingsUnknown
      ? { status: "uncertain" }
      : (settingsNotice ??
          (localSettingsError
            ? { status: "notDispatched", reason: localSettingsError }
            : undefined)),
    reason,
    t?.notDispatched ?? copy.settingUnavailable,
  );
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
      (!session.blocksOutcome && notice === "uncertain") ||
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
      if (panel === "permissions" && permissionRegistered && !permissionTriggerLocked)
        changePermissionOpen(true);
      else if (panel === "usage" && usageGauge.current) usageGauge.current.open();
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
  const ResourceButton = desktop ? Button : "button";
  const changeGoalField = (field: "objective" | "budget", value: string) => {
    if (!desktop && goalDraftEditor) {
      setGoalDialog({ ...goalDraftEditor, [field]: value });
      return;
    }
    editGoal();
    if (field === "objective") setObjective(value);
    else setTokenBudget(value);
  };
  const goalFieldObjective =
    goalDraftEditor?.objective ??
    (editingGoalDraft || goalSnapshot?.available ? goalObjective : (stagedGoal?.objective ?? ""));
  const goalFieldBudget =
    goalDraftEditor?.budget ??
    (editingGoalDraft || goalSnapshot?.available
      ? goalBudget
      : (stagedGoal?.tokenBudget?.toString() ?? ""));
  const goalFieldsDisabled = editingGoalDraft ? goalDraftDisabled : goalActionDisabled("set");
  const goalBudgetType =
    (editingGoalDraft ? undefined : goalSnapshot?.budget) ?? goalProvider?.create.goalBudget;
  const goalFields = goalDialog && (
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
        objective={goalFieldObjective}
        budget={goalFieldBudget}
        disabled={goalFieldsDisabled}
        hideBudget={goalBudgetType === "rounds"}
        onObjectiveChange={(value) => changeGoalField("objective", value)}
        onBudgetChange={(value) => changeGoalField("budget", value)}
      />
    </div>
  );

  return (
    <>
      {!desktop && mutationError?.kind === "goal" && !goalDialog && (
        <p role="alert" className="px-1 text-xs text-destructive-text">
          {reason(mutationError.reason)}
        </p>
      )}
      {notice === "notDispatched" &&
        (preparesSettings
          ? nativeModels?.rejectsModel(noticeReason)
          : noticeReason === "unsupported-model" || noticeReason === "unsupported-effort") && (
          <div role="status" className="space-y-1 px-1 text-xs leading-5 text-muted-foreground">
            <p>{reason(noticeReason)}</p>
            <Button
              type="button"
              variant="link"
              className="h-auto min-h-11 whitespace-normal px-0 text-xs"
              disabled={disabled || (desktop ? !settingsReadable : !full)}
              onClick={() => {
                if (!desktop) void load(false, "settings");
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
          saving: activeWrite?.control === "plan" && !planOn,
          open: addOpen,
          onOpenChange: (open) => {
            setAddOpen(open);
            if (open) void load(false, desktop ? "settings" : undefined);
          },
          attachment: {
            disabled: disabled || !attachmentAllowed,
            reason: reasonTitle(feature("attachments")?.reason),
            onPick: openPhoneFiles,
          },
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
                selected: !!(startupGoal || savedGoal) || (desktop ? false : undefined),
                onOpen: openGoal,
              }
            : undefined,
          plan:
            planOffered || (collaboration && (desktop || settingsReadable))
              ? {
                  active: planOn,
                  disabled: !canTogglePlan,
                  reason: turnActive
                    ? copy.settingsWhileRunning
                    : reasonTitle(collaboration?.reason ?? feature("settings")?.reason),
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
          permissionRegistered
            ? {
                title: menuTitle,
                label: nativePolicyReadOnlyReason
                  ? copy.nativePolicy
                  : (previewPermission?.name ?? permissionLabel),
                description: permissionDescription,
                hint: permissionHint,
                risky: previewPermission?.risky ?? permissionRisky,
                disabled: permissionTriggerLocked,
                saving: activeWrite?.control === "permission",
                disabledReason: permissionDisabledReason,
                side: "top",
                open: permissionOpen && !permissionTriggerLocked,
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
                disabledReason: turnActive ? copy.settingsWhileRunning : undefined,
                saving: activeWrite?.control === "plan",
                onRemove: exitPlan,
              }
            : undefined
        }
        goal={
          goalRegistered && (savedGoal || startupGoal)
            ? {
                detail: selectedGoalDetail,
                disabled: !savedGoal && goalChipLocked,
                onOpen: openGoal,
                onRemove: !savedGoal && onStartupGoalDiscarded ? discardStartupGoal : undefined,
              }
            : undefined
        }
        usage={
          <SessionContextUsageGauge
            session={session}
            surface={kind}
            usageRef={usageGauge}
            fallback={desktop ? usageFallback : currentUsageSettings?.usage}
            capacity={desktop ? contextLimit : usageCapacity}
            source={provider?.contextUsage}
          />
        }
        model={
          modelRegistered
            ? {
                scope: desktop
                  ? `${selected}\0${access?.bootId ?? ""}\0${access?.device?.id ?? ""}\0${access?.device?.advancedControl ?? ""}`
                  : JSON.stringify([
                      selected,
                      access?.bootId,
                      access?.device?.id,
                      access?.device?.advancedControl,
                    ]),
                settings: settingsAccessDenied ? undefined : scopedSettings,
                provider,
                modelNameFallback: nativeModels?.displayName,
                selection: settingsAccessDenied ? undefined : displayedSettings,
                reportedSettings: settingsAccessDenied ? undefined : reportedSettings,
                displayFallback: settingsAccessDenied ? undefined : displayModelFallback,
                verifiedHistoricalModel:
                  settingsReadable && reservesModelSlot
                    ? claudeHistoricalModel?.modelId
                    : undefined,
                retainedEffortOptions,
                disabled: settingsWriteLocked,
                triggerDisabled: modelTriggerLocked,
                disabledReason: modelDisabledReason,
                writeDisabledReason: (field) =>
                  reasonTitle(
                    scopedSettings?.writable[field]?.reason || feature("settings")?.reason,
                  ) ?? copy.settingUnavailable,
                readOnly: settingsReadOnly,
                settingsAuthority: followerAuthority,
                terminalModel: terminalModel,
                terminalPickerVisible: desktop,
                terminalPickerDisabledReason:
                  reasonTitle(feature("open-model-picker")?.reason) ?? copy.settingUnavailable,
                saving: saving,
                loading:
                  preparingSettings || (online && settingsReadable && !settings && !settingsError),
                readError: settingsError,
                ...modelPanel.modelActions({
                  settings: scopedSettings,
                  stale: settingsReadStale,
                  settingsError,
                  prepare: prepareSettings,
                  refresh: preparesSettings ? () => void load(true, "settings") : undefined,
                  terminal: {
                    modelSettings: nativeModels,
                    offered: desktop && canOpenTerminalModel,
                    settingsReadable,
                    sessionId: selected,
                    live,
                    ready: controlReady,
                    online,
                    blocked: disabled || busy || running,
                    open: async () => !!(await runSessionAction("open-model-picker")),
                  },
                }),
                effortDefault: desktop
                  ? (provider?.models.effortDefault ?? managedAgent !== null)
                  : undefined,
                modelDefault: desktop
                  ? !preparesSettings && provider?.models.modelDefault
                  : reservesModelSlot && !settingsReadable
                    ? false
                    : provider?.models.modelDefault,
                clearEffort: desktop
                  ? provider?.models.clearEffort === true &&
                    (!preparesSettings || canPrepareSettings)
                  : (provider?.models.clearEffort ?? preparesSettings),
                onChange: (fields) =>
                  !desktop && settingsWriteLocked
                    ? Promise.resolve(false)
                    : mutate("settings", fields),
              }
            : undefined
        }
        action={action}
      />
      {writeStatus && !session.blocksOutcome?.("settings") && (
        <div
          role="alert"
          className="absolute inset-x-0 bottom-full z-20 mb-2 flex items-center justify-between gap-2 rounded-lg border bg-background px-3 py-2 text-xs text-destructive-text shadow-sm"
        >
          <span>{writeStatus}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!online || busy || saving}
            onClick={() => {
              if (!settingsUnknown && (settingsNotice?.target ?? settingsNotice?.group) === "model")
                openModel("effort", true);
              else if (!settingsUnknown && permissionRegistered && !permissionTriggerLocked)
                changePermissionOpen(true);
              else void (session.refresh ? session.refresh(true) : load(false, "settings"));
            }}
          >
            {settingsUnknown ? layout.reloadDraft : copy.settings}
          </Button>
        </div>
      )}
      {goalRegistered && goalDialog && (
        <SessionDialog
          panel
          description={
            desktop && !editingGoalDraft ? `${layout.selected}: ${resources.length}` : undefined
          }
          footer={
            editingGoalDraft ? (
              <Button
                type="button"
                className={
                  desktop ? "disabled:pointer-events-auto" : "min-h-11 disabled:pointer-events-auto"
                }
                disabled={goalDraftDisabled || !goalDraft}
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
            (goalSnapshot?.available || !!goalError || goalReloading) && (
              <div className="mb-3">
                <Button
                  type="button"
                  variant="outline"
                  aria-busy={goalReloading || undefined}
                  disabled={goalReloading}
                  onClick={reloadGoal}
                >
                  <DelayedSpinner active={goalReloading} />
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
              {goalSnapshot?.available && mutationError?.kind === "goal" && (
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
        </SessionDialog>
      )}

      {resources.map((item) => (
        <span
          key={item.id}
          className="inline-flex max-w-full items-center gap-1 rounded-full border pl-3 text-xs"
          aria-disabled={!item.available || undefined}
          title={!item.available ? copy.resourceRemoved : undefined}
        >
          <span className="truncate">{item.name}</span>
          <ResourceButton
            {...(desktop ? { variant: "bare", size: "content" } : {})}
            type="button"
            className="grid size-11 shrink-0 place-items-center rounded hover:bg-accent"
            aria-label={`${copy.remove}: ${item.name}`}
            disabled={disabled}
            onClick={() => setResources(resources.filter((selected) => selected.id !== item.id))}
          >
            <X size={12} />
          </ResourceButton>
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
