import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useState,
  useRef,
  type ReactNode,
  type Ref,
} from "react";
import {
  ArrowLeft,
  ChevronRight,
  Folder,
  Goal,
  Lightbulb,
  Paperclip,
  Search,
  X,
} from "lucide-react";
import {
  ApiError,
  forgetSessionModelDisplay,
  canDisplayCodexModelFallback,
  readSessionModelDisplay,
  rememberSessionModelDisplay,
  sessionProviderCapabilities,
  type SessionAction,
  type SessionActionBody,
  type ClaudePermissionMode,
  type DevinPermissionMode,
  type CodexContextOptions,
  type CodexContextResource,
  type CodexGoalState,
  type CodexSettingValues,
  type CodexSessionSettings,
  type ManagedAgent,
} from "@agentkib/web-client";
import {
  codexPolicyLabel,
  composerAddCopy,
  ComposerAddAction,
  ComposerAddMenu,
  ComposerPlanAction,
  ComposerModelPicker,
  ComposerPermissionMenu,
  dshPolicyLabel,
  newSessionPermissions,
  planModeCopy,
  sessionCollaborationMode,
  type ComposerModelPickerHandle,
} from "@agentkib/session-ui";
import { Button } from "@/components/ui/button";
import { Disclosure, DisclosureSummary } from "@/components/ui/disclosure";
import { Input } from "@/components/ui/input";
import { NativeCheckbox } from "@/components/ui/native-checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Dialog } from "../../components/dialog";
import { useSession } from "./session-context";
import { settingsNoticeGroup, type SettingsNotice } from "./use-session-controller";
import { composerLayoutCopy, composerTerm } from "./composer-layout-copy";
import { codexCopy, codexReason } from "./codex-copy";
import { subscribeSessionInvalidation } from "./session-events";
import {
  contextUsagePercent,
  ContextUsageGauge,
  useContextUsage,
  type ContextUsageGaugeHandle,
} from "./context-usage";
import { sessionAgentCopy } from "./session-agent-copy";
import { ComposerToolbar } from "../../../ComposerFrame";

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
};

function unavailable(error: unknown) {
  return error instanceof ApiError ? error.code : "request_failed";
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

/** Permission mode IDs accepted by Devin's settings action. */
const DEVIN_PERMISSION_IDS: readonly DevinPermissionMode[] = [
  "auto",
  "accept-edits",
  "smart",
  "dangerous",
];
const CLAUDE_PERMISSION_IDS: readonly ClaudePermissionMode[] = ["default", "plan", "acceptEdits"];

export function CodexComposerControls({
  resources,
  setResources,
  openPhoneFiles,
  disabled,
  action,
  advancedActions,
  controlsRef,
  onPlan,
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
  // Claude Code, DeepSeek Harness and Devin read through the shared managed routes, and only
  // what their capabilities offer; DeepSeek Harness otherwise follows the Codex settings rules.
  const managedAgent: ManagedAgent | null = isClaude
    ? "claude-code"
    : current?.agent === "deepseek-harness"
      ? "deepseek-harness"
      : current?.agent === "devin"
        ? "devin"
        : null;
  const isDevin = managedAgent === "devin";
  const modelPicker = useRef<ComposerModelPickerHandle>(null);
  const usageGauge = useRef<ContextUsageGaugeHandle>(null);
  const refreshModelOnOpen = useRef(false);
  const agentCopy = sessionAgentCopy[locale];
  const feature = (name: string) =>
    (
      capabilities?.features as
        | Record<string, { available: boolean; reason?: string } | undefined>
        | undefined
    )?.[name];
  const settingsReadable =
    !managedAgent ||
    feature("settings-state")?.available === true ||
    feature("settings")?.available === true;
  const goalReadable =
    !managedAgent ||
    ["goal", "goal-set", "goal-pause", "goal-resume", "goal-clear"].some(
      (key) => feature(key)?.available,
    );
  const resourcesReadable =
    !managedAgent ||
    feature("resources")?.available === true ||
    feature("context")?.available === true;
  const layout = composerLayoutCopy[locale];
  const addCopy = composerAddCopy(locale);
  const term = (value: string) => composerTerm(locale, value);
  const reason = (code?: string) => codexReason(locale, code).text;
  const reasonTitle = (code?: string) => (code ? reason(code) : undefined);
  const reasonDetail = (code?: string) => {
    const value = codexReason(locale, code);
    return (
      <div className="text-xs text-muted-foreground">
        {value.text}
        {value.technical && (
          <Disclosure className="mt-1">
            <DisclosureSummary>{layout.details}</DisclosureSummary>
            <code className="break-all">{value.technical}</code>
          </Disclosure>
        )}
      </div>
    );
  };
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
  const [goalDirty, setGoalDirty] = useState(false);
  const full = access?.device?.accessMode === "full";
  const modelAccess = useRef(access);
  modelAccess.current = access;
  const displayAgent = current?.id === selected ? current.agent : undefined;
  const [dialog, setDialog] = useState<"goal">();
  const [addOpen, setAddOpen] = useState(false);
  const [browsingContext, setBrowsingContext] = useState(false);
  const focusAddNavigation = useRef(false);
  const focusNavigationRow = useCallback((row: HTMLDivElement | null) => {
    if (!row || !focusAddNavigation.current) return;
    focusAddNavigation.current = false;
    row.querySelector("button")?.focus();
  }, []);
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
    value: CodexSessionSettings;
  }>();
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
  const [saved, setSaved] = useState(false);
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
  const pendingModelSettings =
    !!pendingSettings && settingsNoticeGroup(pendingSettings) !== "permissions";
  const [query, setQuery] = useState("");
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
    !compacting &&
    (isCodex
      ? canDisplayCodexModelFallback(settings)
      : settings?.applicationStatus !== "pending") &&
    !pendingModelSettings &&
    (!live ||
      (live.sessionId === selected &&
        (live.status === "idle" || live.status === "unsupported") &&
        !live.executionLocation));
  const observedModelFallback =
    history && canShowModelFallback
      ? history.values?.modelId
        ? history.values
        : isCodex
          ? history.defaults
          : undefined
      : undefined;
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
  const usageView = useContextUsage(usageFallback, provider?.contextUsage);

  const applySettings = useCallback(
    (value: CodexSessionSettings) => {
      if (value.sessionId !== selected) return;
      setSettingsSource({ scope: historyScope, client, value });
    },
    [client, historyScope, selected],
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
        setQuery("");
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
          flight.dirty = false;
          flight.background = true;
          flight.includeGoal = false;
          const [settingsResult, goalResult] = await Promise.allSettled([
            settingsReadable
              ? managedAgent
                ? client.sessionSettings(selected, managedAgent)
                : client.codexSessionSettings(selected)
              : Promise.resolve(undefined),
            readGoal
              ? managedAgent
                ? client.sessionGoals(selected, managedAgent)
                : client.codexGoals(selected)
              : Promise.resolve(undefined),
          ]);
          if (generation !== loadGeneration.current) return;
          if (settingsResult.status === "fulfilled") {
            const value = settingsResult.value;
            // Keep historical display data tied to the authorized read, even when live settings
            // replace the editable projection.
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
            else setSettingsSource(undefined);
            setSettingsError("");
          } else {
            const error = settingsResult.reason;
            const accessLost =
              error instanceof ApiError && [401, 403, 404, 410].includes(error.status);
            if (accessLost)
              forgetSessionModelDisplay(client, modelAccess.current, selected, displayAgent);
            if (!quiet || accessLost) {
              setSettingsSource(undefined);
              setSettingsRead(undefined);
              setSettingsError(unavailable(error));
            }
          }
          if (!readGoal) continue;
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
      displayAgent,
      settingsReadable,
      goalReadable,
      historyScope,
    ],
  );

  useEffect(() => {
    loadGeneration.current++;
    goalDraftRevision.current = undefined;
    setGoalDirty(false);
    setSettingsSource(undefined);
    setSettingsRead(undefined);
    setGoal(undefined);
    setContext(undefined);
    contextGeneration.current++;
    contextAbort.current?.abort();
    contextLocation.current = { names: [] };
    setContextNames([]);
    setContextLoading(false);
    setQuery("");
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
    setBrowsingContext(false);
    focusAddNavigation.current = false;
    setSaved(false);
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
      void load(true, dialog === "goal");
  }, [full, load, online, selected, live?.sessionId, live?.status, live?.revision, dialog]);

  useEffect(() => {
    if (live?.settings?.sessionId === selected) {
      applySettings({
        ...live.settings,
        usage: live.usage ?? live.settings.usage,
      });
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
      (!isClaude ||
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
        (expected.effort === null
          ? isClaude
            ? settings.selected !== undefined && settings.selected.effort === undefined
            : settings.current.effort === undefined
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
          ? settings.current.serviceTierId === undefined
          : settings.current.serviceTierId === expected.serviceTierId));
    if (confirmed) {
      setPendingSettings(undefined);
      setSaved(true);
    }
  }, [isClaude, pendingSettings, settings]);

  async function mutate(
    name: SessionAction,
    fields: Omit<
      Partial<SessionActionBody>,
      "requestId" | "bootId" | "sessionId" | "expectedRevision"
    > = {},
  ) {
    if (!full || mutationFlight.current || compacting || (name === "settings" && settingsUnknown))
      return false;
    const readRevision = name === "settings" ? settings?.revision : goal?.revision;
    if (live?.revision !== undefined && readRevision !== live.revision) return false;
    setSaving(true);
    setSaved(false);
    setMutationFailure(undefined);
    const generation = loadGeneration.current;
    const mutation = Symbol("settings-or-goal");
    mutationFlight.current = mutation;
    try {
      const result = await codexAction(name, fields);
      if (generation !== loadGeneration.current) return false;
      if (result) {
        if (name === "settings") {
          setPendingSettings({ ...fields, expectedRevision: readRevision ?? 0 });
        }
        if (name.startsWith("goal-")) {
          goalDraftRevision.current = undefined;
          setGoalDirty(false);
        }
        await load(false, name !== "settings");
        return true;
      }
      return false;
    } catch (error) {
      if (generation === loadGeneration.current)
        setMutationFailure({
          scope: historyScope,
          client,
          group: name === "settings" ? settingsNoticeGroup(fields) : "goal",
          reason: unavailable(error),
        });
      return false;
    } finally {
      // Reconnection can invalidate reads without replacing this mutation's busy owner.
      if (mutationFlight.current === mutation) {
        mutationFlight.current = undefined;
        setSaving(false);
      }
    }
  }

  const settingsReadStale = live?.revision !== undefined && settings?.revision !== live.revision;
  const goalReadStale = live?.revision !== undefined && goal?.revision !== live.revision;
  const prepareSettings = () => {
    if (
      canPrepareSettings &&
      !settingsUnknown &&
      !running &&
      feature("settings")?.available &&
      access?.bootId &&
      selected &&
      live.revision !== undefined
    ) {
      if (settingsPreparation.current) return;
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
    void load(false, false);
  };
  const displayedSettings = settings
    ? settingsUnknown
      ? settings.current
      : settingsSelection(settings, isClaude)
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
  const supportsContextUsage = provider?.contextUsage !== "unsupported";
  const showContextUsage =
    supportsContextUsage &&
    (provider?.contextUsage !== "last-request" ||
      usageView.usage?.historical === true ||
      contextLimit !== undefined);
  const liveSettings =
    provider !== undefined &&
    !preparesSettings &&
    live?.sessionId === selected &&
    live.settings?.sessionId === selected &&
    live.settings.revision >= (settings?.revision ?? 0)
      ? live.settings
      : undefined;
  const liveSelection = liveSettings && settingsSelection(liveSettings, false);
  const reportedSettings =
    !settingsUnknown && settings?.applicationStatus !== "pending" && !pendingModelSettings
      ? liveSelection?.modelId || liveSelection?.effort
        ? liveSelection
        : liveSettings?.current
      : undefined;
  const cachedModelDisplay =
    !isCodex || canShowModelFallback || settingsReceiptUncertain
      ? readSessionModelDisplay(client, access, selected, displayAgent)
      : undefined;
  const displayModelFallback =
    observedModelFallback?.modelId && !(settingsUnknown && cachedModelDisplay)
      ? {
          ...observedModelFallback,
          name:
            cachedModelDisplay?.modelId === observedModelFallback.modelId
              ? cachedModelDisplay.name
              : undefined,
        }
      : cachedModelDisplay;
  const observedModel: CodexSettingValues | undefined = [
    reportedSettings,
    displayedSettings,
    settings?.current,
    observedModelFallback,
  ].find((value) => value?.modelId);
  const observedModelId = observedModel?.modelId;
  const observedModelName = observedModelId
    ? (settings ?? liveSettings)?.options.models.find(
        (option) => option.id === observedModelId || option.resolvedModel === observedModelId,
      )?.name
    : undefined;
  const observedEffort = observedModel?.effort;
  const observedServiceTier = observedModel?.serviceTierId;
  useEffect(() => {
    if (!observedModelId || settingsUnknown) return;
    rememberSessionModelDisplay(client, access, selected, displayAgent, {
      modelId: observedModelId,
      name: observedModelName,
      effort: observedEffort,
      serviceTierId: observedServiceTier,
    });
  }, [
    access,
    client,
    displayAgent,
    observedEffort,
    observedModelId,
    observedModelName,
    observedServiceTier,
    selected,
    settingsUnknown,
  ]);
  const showModelPicker =
    (settingsReadable || !!cachedModelDisplay) &&
    (!provider ||
      preparesSettings ||
      !settings?.available ||
      settings.options.models.length > 0 ||
      !!observedModelId ||
      !!cachedModelDisplay);
  const showPermissions =
    settingsReadable && (isCodex || isClaude || isDevin || !!settings?.options.policies?.length);
  const changePermissionOpen = (open: boolean) => {
    setPermissionOpen(open);
    if (!open) return;
    if (
      (canPrepareSettings && !settingsUnknown) ||
      !settings?.available ||
      settingsReadStale ||
      settingsError
    )
      prepareSettings();
  };
  const closeAdd = () => {
    setAddOpen(false);
    setBrowsingContext(false);
    focusAddNavigation.current = false;
  };
  const openGoal = () => {
    closeAdd();
    setDialog("goal");
    if (goalReadStale) void load();
  };
  const openModel = (page: "effort" | "models", refresh = false) => {
    if (!full || disabled || !settingsReadable || !modelPicker.current) return false;
    refreshModelOnOpen.current = refresh;
    modelPicker.current.open(page);
    return true;
  };
  const availableResources = (context?.resources ?? []).filter((item) => {
    const needle = query.trim().toLocaleLowerCase();
    return !needle || `${item.name} ${item.description ?? ""}`.toLocaleLowerCase().includes(needle);
  });
  const resourceGroups = [
    {
      label: copy.computerFiles,
      items: availableResources.filter((item) => item.kind === "file" || item.kind === "directory"),
    },
    {
      label: copy.skillsPlugins,
      items: availableResources.filter(
        (item) => item.kind === "skill" || item.kind === "plugin" || item.kind === "app",
      ),
    },
  ];
  const goalChanged = goalDirty && goalDraftRevision.current !== goal?.revision;
  const editGoal = () => {
    goalDraftRevision.current ??= goal?.revision;
    setGoalDirty(true);
  };
  // DeepSeek Harness's permission preset changes at once during a turn; its model waits.
  const presetWhileRunning =
    running && managedAgent === "deepseek-harness" && settings?.writable.policy?.available === true;
  const settingDisabled =
    disabled || busy || saving || preparingSettings || feature("settings")?.available !== true;
  const parsedBudget = tokenBudget ? Number(tokenBudget) : undefined;
  const budgetValid =
    parsedBudget === undefined || (Number.isSafeInteger(parsedBudget) && parsedBudget > 0);
  const permissionTriggerLocked =
    disabled ||
    (!settingsUnknown &&
      isDevin &&
      (!online ||
        busy ||
        saving ||
        running ||
        feature("settings")?.available !== true ||
        (settings?.available === true && !settings.writable.permissionMode?.available)));
  const settingsWriteLocked =
    settingDisabled ||
    compacting ||
    !online ||
    !settings?.available ||
    settingsReadStale ||
    settingsUnknown;
  const permissionWriteLocked = settingsWriteLocked || (running && !presetWhileRunning);
  const permissionModes =
    settings?.available && (isClaude || isDevin)
      ? newSessionPermissions(
          isClaude ? "claude-code" : "devin",
          { available: true, permissionModes: settings.options.permissionModes },
          locale,
        )
      : undefined;
  const permissionChoices = permissionModes?.choices.flatMap((choice) => {
    const permissionMode = (isDevin ? DEVIN_PERMISSION_IDS : CLAUDE_PERMISSION_IDS).find(
      (id) => id === choice.id,
    );
    return permissionMode && !(isClaude && permissionMode === "plan")
      ? [
          {
            ...choice,
            selected: permissionMode === displayedSettings?.permissionMode,
            disabled: permissionWriteLocked || !settings?.writable.permissionMode?.available,
            fields: { permissionMode },
          },
        ]
      : [];
  });
  const menuTitle = isDevin
    ? agentCopy.nextTurnPermission
    : isClaude
      ? agentCopy.permission
      : copy.executionPolicy;
  const policies = (settings?.options.policies ?? []).map((item) => {
    const label =
      managedAgent === "deepseek-harness"
        ? dshPolicyLabel(item.id, locale)
        : codexPolicyLabel(item.id, locale);
    return {
      id: item.id,
      name: label?.name ?? item.name,
      description: label?.description ?? item.description,
      risky: item.id === "full-access-on-request" || item.id === "danger-full-access",
      selected: item.id === displayedSettings?.policyId,
      disabled: permissionWriteLocked || !settings?.writable.policy?.available,
      fields: { policyId: item.id },
    };
  });
  const permissionItems = isClaude || isDevin ? (permissionChoices ?? []) : policies;
  const collaboration = sessionCollaborationMode(settings, displayedSettings, isClaude);
  const clearSavedMode =
    isCodex && !collaboration && settings?.writable.mode.available && !!settings.selected?.mode;
  const attachmentOffered =
    capabilities?.sessionId === selected && feature("attachments")?.available === true;
  const attachmentAllowed = attachmentOffered && access?.device?.attachments === true;
  const canAdd = resourcesReadable || goalReadable || !!collaboration || attachmentAllowed;
  const planOn = isClaude
    ? displayedSettings?.permissionMode === "plan"
    : displayedSettings?.mode === "plan";
  const planAvailable =
    full &&
    !settingsWriteLocked &&
    (!running || managedAgent === "deepseek-harness") &&
    collaboration?.writable === true;
  useEffect(() => {
    onPlan?.({ on: planOn, available: planAvailable });
  }, [onPlan, planOn, planAvailable]);
  const setPlan = (on: boolean) => {
    const mode = on ? "plan" : "default";
    if (!planAvailable || !collaboration?.modes.includes(mode) || planOn === on) return;
    void mutate("settings", collaboration.change(mode));
  };
  const selectedPermission = (permissionChoices ?? policies).find((item) => item.selected);
  const permissionLabel =
    selectedPermission?.name ??
    (isClaude
      ? agentCopy.permissionUnknown
      : isDevin
        ? agentCopy.permission
        : copy.executionPolicy);
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
  const permissionStatus =
    settingsUnknown || (permissionMessage && localSettingsNotice)
      ? undefined
      : preparingSettings
        ? layout.connecting
        : !settings?.available || settingsReadStale
          ? (reasonTitle(settingsError || settings?.reason) ?? layout.connecting)
          : running
            ? presetWhileRunning
              ? copy.settingsWhileRunningModel
              : copy.settingsWhileRunning
            : permissionItems.every((item) => item.disabled)
              ? (reasonTitle(
                  feature("settings")?.reason ??
                    (isClaude || isDevin
                      ? settings.writable.permissionMode?.reason
                      : settings.writable.policy?.reason),
                ) ?? copy.settingUnavailable)
              : saved
                ? copy.settingsSaved
                : undefined;
  useImperativeHandle(controlsRef, () => ({
    open: (next) => {
      if (!full || disabled) return false;
      if (next === "settings") {
        if (!showPermissions || permissionTriggerLocked) return false;
        changePermissionOpen(true);
        return true;
      }
      if (!goalReadable) return false;
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
      if (!planOn) setPlan(true);
      return true;
    },
  }));
  if (!full) return null;
  const quickStatus =
    settingsUnknown || (modelMessage && localSettingsNotice)
      ? undefined
      : settingsError
        ? reason(settingsError)
        : preparingSettings
          ? layout.connecting
          : !settings?.available
            ? reason(settings?.reason) || copy.settingUnavailable
            : running
              ? presetWhileRunning
                ? copy.settingsWhileRunningModel
                : copy.settingsWhileRunning
              : settingsReadStale && !saving
                ? layout.connecting
                : undefined;
  const settingsFeedback = settingsMessage && (
    <p
      role={localSettingsNotice?.status === "uncertain" ? "status" : "alert"}
      className={`max-w-64 px-1 text-xs leading-4 ${localSettingsNotice?.status === "uncertain" ? "text-muted-foreground" : "text-destructive-text"}`}
    >
      {settingsMessage}
    </p>
  );

  const contextBrowser = addOpen && browsingContext && resourcesReadable && (
    <section className="mt-1 space-y-2 border-t px-1 pt-2">
      <div ref={focusNavigationRow}>
        <ComposerAddAction
          label={addCopy.back}
          icon={<ArrowLeft className="size-4" aria-hidden />}
          onClick={() => {
            focusAddNavigation.current = true;
            setBrowsingContext(false);
          }}
        />
      </div>
      <div className="flex min-w-0 items-center gap-2 rounded-lg border p-2">
        <Button
          type="button"
          variant="outline"
          className="min-h-9 shrink-0"
          disabled={!context?.parentId || contextLoading || !online}
          onClick={() => void loadContext(context?.parentId, contextNames.slice(0, -1))}
        >
          <ArrowLeft size={16} />
          {layout.parentDirectory}
        </Button>
        <span className="min-w-0 break-words px-1 text-xs text-muted-foreground">
          {[layout.contextRoot, ...contextNames].join(" / ")}
        </span>
      </div>
      {contextLoading && (
        <p role="status" className="text-sm">
          {layout.contextLoading}
        </p>
      )}
      {contextError && (
        <div role="alert" className="space-y-2 text-sm">
          {reason(contextError)}
          <Button
            type="button"
            variant="outline"
            disabled={contextLoading || !online}
            onClick={() =>
              void loadContext(contextLocation.current.id, contextLocation.current.names)
            }
          >
            {layout.contextRetry}
          </Button>
        </div>
      )}
      {!context ? (
        <p role="status" className="text-sm text-muted-foreground">
          {!contextLoading && !contextError ? copy.resourceUnavailable : null}
        </p>
      ) : (
        <>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label={copy.resourceSearch}
              placeholder={copy.resourceSearch}
              value={query}
              className="h-10 pl-9"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <p className="text-sm text-muted-foreground">{copy.directoryReference}</p>
          <div className="space-y-2">
            {availableResources.length === 0 && (
              <p className="text-sm text-muted-foreground">{copy.resourceEmpty}</p>
            )}
            {resourceGroups.map(
              (group) =>
                group.items.length > 0 && (
                  <section key={group.label} className="space-y-2">
                    <h3 className="text-xs font-medium text-muted-foreground">{group.label}</h3>
                    {group.items.map((item) => {
                      const checked = resources.some((selected) => selected.id === item.id);
                      return (
                        <div
                          key={item.id}
                          className={`flex items-center gap-2 rounded-lg border p-3 text-sm transition-colors ${checked ? "border-primary/40 bg-primary/5" : "hover:bg-muted/30"}`}
                        >
                          <label className="flex min-w-0 flex-1 items-start gap-3">
                            <NativeCheckbox
                              checked={checked}
                              disabled={
                                !item.available ||
                                contextLoading ||
                                !online ||
                                disabled ||
                                feature("context")?.available !== true
                              }
                              title={reasonTitle(item.reason || feature("context")?.reason)}
                              onChange={(event) =>
                                setResources(
                                  event.target.checked
                                    ? [...resources, item]
                                    : resources.filter((selected) => selected.id !== item.id),
                                )
                              }
                            />
                            <span className="min-w-0">
                              <span className="block break-words font-medium">{item.name}</span>
                              <span className="block text-xs text-muted-foreground">
                                {term(item.kind)}
                                {item.description ? ` · ${item.description}` : ""}
                                {!item.available || feature("context")?.available !== true
                                  ? ` · ${reason(item.reason || feature("context")?.reason)}`
                                  : ""}
                              </span>
                            </span>
                          </label>
                          {item.kind === "directory" && item.navigationId && (
                            <Button
                              type="button"
                              variant="ghost"
                              className="size-11 shrink-0 p-0"
                              aria-label={`${layout.enterDirectory}: ${item.name}`}
                              disabled={
                                contextLoading ||
                                !online ||
                                disabled ||
                                !item.available ||
                                feature("context")?.available !== true
                              }
                              onClick={() =>
                                void loadContext(item.navigationId, [...contextNames, item.name])
                              }
                            >
                              <ChevronRight size={18} />
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </section>
                ),
            )}
          </div>
        </>
      )}
      {resources.length > 0 && (
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-xs text-muted-foreground">
            {layout.selected}: {resources.length}
          </span>
          <Button type="button" size="sm" onClick={closeAdd}>
            {layout.done}
          </Button>
        </div>
      )}
    </section>
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
      <ComposerToolbar
        leading={
          <>
            <ComposerAddMenu
              label={copy.addContext}
              disabled={disabled || !canAdd}
              disabledReason={!canAdd ? addCopy.unavailable : undefined}
              open={addOpen}
              onOpenChange={(open) => {
                if (!open) {
                  closeAdd();
                  return;
                }
                setAddOpen(true);
                void load(false, false);
              }}
            >
              {contextBrowser || (
                <>
                  {(!managedAgent || attachmentOffered) && (
                    <ComposerAddAction
                      label={copy.uploadFromPhone}
                      icon={<Paperclip className="size-4" aria-hidden />}
                      disabled={disabled || !attachmentAllowed}
                      onClick={() => {
                        closeAdd();
                        openPhoneFiles();
                      }}
                    />
                  )}
                  {resourcesReadable && (
                    <div ref={focusNavigationRow}>
                      <ComposerAddAction
                        label={addCopy.filesAndFolders}
                        icon={<Folder className="size-4" aria-hidden />}
                        onClick={() => {
                          focusAddNavigation.current = true;
                          setBrowsingContext(true);
                          if (!context && !contextLoading)
                            void loadContext(
                              contextLocation.current.id,
                              contextLocation.current.names,
                            );
                        }}
                      />
                    </div>
                  )}
                  {goalReadable && (
                    <ComposerAddAction
                      label={copy.goals}
                      icon={<Goal className="size-4" aria-hidden />}
                      onClick={openGoal}
                    />
                  )}
                  {collaboration && (
                    <ComposerPlanAction
                      label={planModeCopy(locale).title}
                      active={planOn}
                      disabled={
                        !planAvailable || !collaboration.modes.includes(planOn ? "default" : "plan")
                      }
                      disabledReason={reasonTitle(collaboration.reason)}
                      onToggle={() => {
                        closeAdd();
                        setPlan(!planOn);
                      }}
                    />
                  )}
                  {clearSavedMode && (
                    <ComposerAddAction
                      label={planModeCopy(locale).clear}
                      icon={<Lightbulb className="size-4" aria-hidden />}
                      disabled={settingsWriteLocked || running}
                      onClick={() => {
                        closeAdd();
                        void mutate("settings", { mode: null });
                      }}
                    />
                  )}
                </>
              )}
            </ComposerAddMenu>
            <div
              className={
                permissionMessage && settingsFeedback
                  ? "grid min-w-0 justify-items-start"
                  : "contents"
              }
            >
              {showPermissions && (
                <ComposerPermissionMenu
                  title={menuTitle}
                  label={permissionLabel}
                  risky={selectedPermission?.risky}
                  disabled={permissionTriggerLocked}
                  disabledReason={permissionTriggerLocked ? permissionStatus : undefined}
                  side="top"
                  open={permissionOpen}
                  onOpenChange={changePermissionOpen}
                  status={permissionStatus}
                  blockItemsOnStatus={false}
                  items={permissionItems}
                  onSelect={(id) => {
                    const choice = permissionItems.find((item) => item.id === id);
                    if (choice && !choice.selected && !choice.disabled)
                      void mutate("settings", choice.fields);
                  }}
                />
              )}
              {permissionMessage && settingsFeedback}
            </div>
          </>
        }
        trailing={
          <>
            {advancedActions}
            {showContextUsage && (
              <ContextUsageGauge
                gaugeRef={usageGauge}
                fallback={usageFallback}
                limit={contextLimit}
                source={provider?.contextUsage}
              />
            )}
            <div
              className={
                modelMessage && settingsFeedback ? "grid min-w-0 justify-items-end" : "contents"
              }
            >
              {showModelPicker && (
                <ComposerModelPicker
                  key={`${selected}\0${access?.bootId ?? ""}\0${access?.device?.id ?? ""}\0${usageEpoch ?? ""}`}
                  pickerRef={modelPicker}
                  locale={locale}
                  settings={settings}
                  provider={provider}
                  selection={displayedSettings}
                  reportedSettings={reportedSettings}
                  displayFallback={displayModelFallback}
                  disabled={settingDisabled || running || settingsReadStale || settingsUnknown}
                  saving={saving}
                  status={quickStatus}
                  onOpen={() => {
                    const refresh = refreshModelOnOpen.current;
                    refreshModelOnOpen.current = false;
                    if (
                      refresh ||
                      settingsReadStale ||
                      !settings?.available ||
                      !settings.options.models.length
                    )
                      prepareSettings();
                  }}
                  // Claude Code and DeepSeek Harness report no effort for the model's own default.
                  effortDefault={provider?.models.effortDefault ?? managedAgent !== null}
                  // A live session can still be resolving its selected model during preparation.
                  modelDefault={!preparesSettings && provider?.models.modelDefault}
                  clearEffort={
                    provider?.models.clearEffort === true &&
                    (!preparesSettings || canPrepareSettings)
                  }
                  onChange={(fields) => mutate("settings", fields)}
                />
              )}
              {modelMessage && settingsFeedback}
            </div>
            {action}
          </>
        }
      />
      {!permissionMessage && !modelMessage && settingsFeedback}
      {goal?.goal && (
        <Button
          type="button"
          variant="ghost"
          className="h-auto min-h-11 w-full justify-start overflow-hidden px-2 text-xs"
          aria-label={copy.goals}
          onClick={openGoal}
        >
          <Goal className="shrink-0" size={16} />
          <span className="shrink-0">{term(goal.goal.status)}</span>
          <span className="truncate">{goal.goal.objective}</span>
        </Button>
      )}
      {dialog === "goal" && (
        <Dialog
          panel
          description={`${layout.selected}: ${resources.length}`}
          footer={
            goal?.available ? (
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
                    !objective.trim() ||
                    !budgetValid
                  }
                  title={reasonTitle(goal.actions.set?.reason || feature("goal-set")?.reason)}
                  onClick={() =>
                    void mutate("goal-set", {
                      objective: objective.trim(),
                      intent: goal.goal ? "update" : "start",
                      tokenBudget: parsedBudget ?? null,
                    })
                  }
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
          onClose={() => setDialog(undefined)}
        >
          {goalReadStale && (goal?.available || !!goalError) && (
            <div role="status" className="mb-3 text-xs text-muted-foreground">
              {layout.connecting}
              <Button type="button" variant="outline" onClick={() => void load()}>
                {layout.reloadDraft}
              </Button>
            </div>
          )}
          {!goal?.available ? (
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
              {mutationError?.group === "goal" && (
                <p role="alert" className="text-xs text-destructive-text">
                  {reason(mutationError.reason)}
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
              <label className="block space-y-1 text-sm">
                {copy.goalObjective}
                <Textarea
                  className="min-h-24 w-full rounded-md border bg-background p-2"
                  value={objective}
                  disabled={busy || saving || compacting}
                  onChange={(event) => {
                    editGoal();
                    setObjective(event.target.value);
                  }}
                />
              </label>
              {/* A goal bounded by rounds takes no token budget. */}
              {goal.budget !== "rounds" && (
                <label className="block space-y-1 text-sm">
                  {copy.goalBudget}
                  <Input
                    type="number"
                    min={1}
                    value={tokenBudget}
                    disabled={busy || saving || compacting}
                    onChange={(event) => {
                      editGoal();
                      setTokenBudget(event.target.value);
                    }}
                  />
                </label>
              )}
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
