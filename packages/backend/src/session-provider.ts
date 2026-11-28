import {
  CODEX_MENU_COMMANDS,
  isSessionProviderAgent,
  sessionProviderCapabilities,
  sessionProviderDeclaration,
  type HistoryReference,
  type LiveSessionAgent,
  type SessionActivity,
  type SessionApprovalKind,
  type SessionCommandMenu,
  type SessionExecution,
  type SessionFeedback,
  type SessionProviderAgent,
  type SessionProviderDeclaration,
  type SessionQueueItemActions,
  type SessionQuestionReplyFields,
} from "@agentkib/runtime-protocol";
import { z } from "zod";
import { projectSessionExecution } from "./sessions/execution";
import type { ProviderControlValidator } from "./sessions/validate/types";

export { projectSessionExecution };

export interface SessionQuery {
  operation: "capabilities" | "inspect";
  sessionId: string;
  deviceId?: string;
  experimentalEnabled?: boolean;
}

interface SessionExecutor {
  live(sessionId: string, enabled: boolean): Promise<unknown>;
  /** Running turns confirmed by resident state, without connecting to a native process. */
  runningSessionIds?(): Iterable<string>;
  workerSettingsObservation?(sessionId: string, source?: "worker"): Promise<unknown>;
  query(request: SessionQuery): Promise<unknown>;
  control(request: Record<string, unknown>): Promise<unknown>;
  contextUsage(sessionId: string): Promise<unknown>;
  refreshWorkerUsageLimit?(sessionId: string): Promise<boolean>;
  queue?(request: Extract<SessionProviderRequest, { operation: "queue-list" }>): Promise<unknown>;
  readonly validateControl?: ProviderControlValidator;
  readonly typed?: TypedSessionProvider;
}

/** Each provider prepares its native execution environment within the original control request. */
export interface SessionProvider extends SessionExecutor {
  readonly agent: SessionProviderAgent;
  readonly createOperation: string;
  options(scope: { workspaceId?: unknown; includeModels?: boolean }): Promise<unknown>;
  workspaceResources?(workspaceId: string): Promise<unknown>;
  create(fields: Record<string, unknown>): Promise<unknown>;
  settingsState(request: Record<string, unknown>): Promise<unknown>;
  prepareSettings?(request: Record<string, unknown>): Promise<unknown>;
  updateSettings(request: Record<string, unknown>): Promise<unknown>;
}

export type SessionProviders = {
  readonly [Agent in SessionProviderAgent]: SessionProvider & {
    readonly agent: Agent;
  };
} & { readonly antigravity: SessionExecutor & { readonly agent: "antigravity" } };

type ReadScope = Omit<SessionQuery, "operation">;

type ControlScope = {
  sessionId: string;
  requestId: string;
  deviceId?: string;
  runtimeBootId: string;
  expectedRevision: number;
  experimentalEnabled: boolean;
};

type MessageFields = {
  text?: string;
  input?: unknown[];
  historyReferences?: HistoryReference[];
  historyInputHash?: string;
  resourceRefs?: { kind: string; id?: string; relativePath?: string }[];
  commandAccess?: "all" | "session";
};

type SettingsFields = {
  model?: string;
  effort?: string | null;
  serviceTier?: string | null;
  mode?: string | null;
  policyId?: string;
  permissionMode?: string;
  resetDefaults?: boolean;
  expectedSettingsScope?: string;
};

type ControlFields = {
  send: MessageFields;
  steer: MessageFields & { turnId: string };
  "queue-add": MessageFields;
  "queue-update": { queuedSubmissionId: string; text: string };
  "queue-delete": { queuedSubmissionId: string };
  "queue-steer": { queuedSubmissionId: string };
  "queue-reorder": { queuedSubmissionIds: string[] };
  "queue-start": object;
  "queue-pause": object;
  "queue-resume": object;
  stop: { turnId: string };
  approve: {
    turnId: string;
    approvalId: string | number;
    decision?: string;
    nativeDecision?: unknown;
  };
  answer: { turnId: string; questionId: string | number } & SessionQuestionReplyFields;
  settings: SettingsFields;
};

export type SessionProviderControlRequest = {
  [Operation in keyof ControlFields]: {
    operation: Operation;
  } & ControlScope &
    ControlFields[Operation];
}[keyof ControlFields];

export type SessionProviderRequest =
  | {
      operation: "create";
      workspaceId: string;
      requestId: string;
      deviceId: string;
      name?: string;
      prompt?: string;
      model?: string;
      effort?: string;
      serviceTier?: string;
      policyId?: string;
      permissionMode?: string;
      mode?: "plan";
      agentPreset?: string;
      verifyStartupModel?: true;
    }
  | ({ operation: "capabilities" } & ReadScope)
  | ({ operation: "inspect" } & ReadScope)
  | ({ operation: "live" } & ReadScope)
  | ({ operation: "queue-list"; limit?: number } & ReadScope)
  | { operation: "usage"; sessionId: string }
  | { operation: "settings-state"; sessionId: string; includeHistorical?: boolean }
  | ({ operation: "settings-prepare"; deviceId: string } & Omit<ControlScope, "requestId">)
  | SessionProviderControlRequest;

const resultScope = {
  sessionId: z.string().optional(),
  runtimeBootId: z.string().optional(),
  reason: z.string().nullish(),
};
const feature = z.looseObject({ available: z.boolean(), reason: z.string().nullish() });
const capabilities = z.looseObject({
  ...resultScope,
  sessionId: z.string(),
  status: z.string(),
  executionMode: z.string().optional(),
  features: z.record(z.string(), feature),
});
const approval = z.looseObject({
  requestId: z.union([z.string(), z.number()]),
  method: z.string().optional(),
  turnId: z.string().optional(),
  supported: z.boolean().optional(),
  availableDecisions: z.array(z.string()).optional(),
  options: z
    .array(
      z.looseObject({
        optionId: z.string(),
        name: z.string(),
        kind: z.string(),
      }),
    )
    .optional(),
  decisionOptions: z
    .array(
      z.looseObject({
        id: z.string(),
        label: z.string(),
        decision: z.unknown(),
        scope: z.enum(["once", "session", "persistent"]),
      }),
    )
    .optional(),
  presentation: z
    .enum(["command", "files", "network", "permissions", "tool", "mcp", "unknown"])
    .optional(),
});
const live = z.looseObject({
  ...resultScope,
  sessionId: z.string(),
  status: z.string(),
  revision: z.number(),
  executionMode: z.string().optional(),
  turnId: z.string().nullish(),
  sendEnabled: z.boolean(),
  stopEnabled: z.boolean().optional(),
  approvals: z.array(approval),
});
const control = z.looseObject({
  ...resultScope,
  requestId: z.string().optional(),
  accepted: z.boolean().optional(),
  completed: z.boolean().optional(),
  controlOutcome: z.enum(["accepted", "not-dispatched", "unknown"]).optional(),
});
const settings = z.looseObject({
  ...resultScope,
  available: z.boolean(),
  revision: z.number().optional(),
  writeScope: z.string().nullish(),
  applicationStatus: z.enum(["pending", "confirmed", "unknown"]).optional(),
});
const inspect = z.looseObject({
  ...resultScope,
  status: z.string().optional(),
  revision: z.number().optional(),
});
const usage = z.looseObject({
  ...resultScope,
  available: z.boolean(),
  state: z.enum(["ready", "pending", "stale", "unavailable"]).optional(),
  usedTokens: z.number().optional(),
  totalTokens: z.number().optional(),
  contextWindow: z.number().optional(),
  percent: z.number().optional(),
});
const queueItem = z.looseObject({
  id: z.string(),
  hasAttachments: z.boolean().optional(),
  status: z.enum(["pending", "claimed", "dispatched", "unknown"]).optional(),
  actions: z
    .partialRecord(
      z.enum(["update", "delete", "steer"]),
      z.object({ available: z.boolean(), reason: z.string().optional() }),
    )
    .optional(),
});
const queue = z.looseObject({
  ...resultScope,
  paused: z.boolean().optional(),
  requiresResume: z.boolean().optional(),
  data: z.array(queueItem),
});
const reportedCommands = z.array(
  z.object({
    name: z.string(),
    description: z.string().optional(),
    argumentHint: z.string().optional(),
    aliases: z.array(z.string()).optional(),
  }),
);
const queuedInput = z.array(z.object({ type: z.string(), text: z.string().optional() }));

type ControlResult = z.infer<typeof control> & { feedback?: readonly SessionFeedback[] };
type CapabilityResult = z.infer<typeof capabilities> & {
  provider?: SessionProviderDeclaration;
  execution: SessionExecution;
  /** Internal catalog. The host must gate this and legacy commands with the same send grant. */
  commandMenu?: SessionCommandMenu;
  feedback?: readonly SessionFeedback[];
};
type LiveResult = z.infer<typeof live> & {
  execution: SessionExecution;
  feedback?: readonly SessionFeedback[];
  activities?: readonly SessionActivity[];
  approvals: (z.infer<typeof approval> & { presentation?: SessionApprovalKind })[];
};

type SessionProviderResults = {
  [Operation in SessionProviderControlRequest["operation"]]: ControlResult;
} & {
  create: ControlResult;
  capabilities: CapabilityResult;
  inspect: z.infer<typeof inspect>;
  live: LiveResult;
  "queue-list": z.infer<typeof queue> & {
    data: (z.infer<typeof queueItem> & { actions?: SessionQueueItemActions })[];
  };
  usage: z.infer<typeof usage>;
  "settings-state": z.infer<typeof settings>;
  "settings-prepare": z.infer<typeof settings>;
};

export type SessionProviderOperation = keyof SessionProviderResults;
export type SessionProviderResponse<
  Operation extends SessionProviderOperation = SessionProviderOperation,
> = {
  [Key in Operation]: { operation: Key; result: SessionProviderResults[Key] };
}[Operation];

export interface TypedSessionProvider {
  readonly agent: LiveSessionAgent;
  request<Request extends SessionProviderRequest>(
    request: Request,
    source?: "worker",
  ): Promise<SessionProviderResponse<Request["operation"]>>;
  readonly validateControl?: ProviderControlValidator;
}

function parseResult<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("invalid-provider-response");
  return parsed.data;
}

function projectCommandMenu(agent: LiveSessionAgent, raw: unknown): SessionCommandMenu | undefined {
  if (agent === "codex")
    return {
      state: "ready",
      entries: CODEX_MENU_COMMANDS.map((name) => ({
        name,
        run: { kind: "client", command: name },
      })),
    };
  if (agent !== "claude-code" && agent !== "deepseek-harness") return undefined;
  const parsed = reportedCommands.safeParse(raw);
  // Claude uses an empty list both before the first worker report and for an empty catalog.
  if (!parsed.success || (agent === "claude-code" && parsed.data.length === 0)) return undefined;
  return {
    state: "ready",
    entries: parsed.data.map((entry) => ({
      ...entry,
      run:
        agent === "claude-code" && ["model", "effort", "rename", "goal"].includes(entry.name)
          ? { kind: "client", command: entry.name }
          : { kind: "native" },
    })),
  };
}

function projectFeedback(reason: unknown): { feedback?: readonly SessionFeedback[] } {
  // Provider reasons may contain human-readable native or filesystem errors.
  // Only stable code-shaped values belong in this projection.
  return typeof reason === "string" && /^[a-z][a-z0-9_-]{0,127}$/.test(reason)
    ? { feedback: [{ code: reason }] }
    : {};
}

function approvalKind(
  agent: LiveSessionAgent,
  value: z.infer<typeof approval>,
): SessionApprovalKind {
  switch (value.method) {
    case "item/commandExecution/requestApproval": {
      const context = value.requestContext;
      return context &&
        typeof context === "object" &&
        "networkApprovalContext" in context &&
        context.networkApprovalContext != null
        ? "network"
        : "command";
    }
    case "item/fileChange/requestApproval":
      return "files";
    case "item/permissions/requestApproval":
      return "permissions";
    case "mcpServer/elicitation/request":
      return "mcp";
    case "claude/can_use_tool":
    case "dsh/approval":
      return "tool";
    default:
      return agent === "antigravity" && value.toolCall != null ? "tool" : "unknown";
  }
}

function projectLive(agent: LiveSessionAgent, raw: unknown): LiveResult {
  const value = parseResult(live, raw);
  return {
    ...value,
    execution: projectSessionExecution(value),
    ...projectFeedback(value.reason),
    approvals: value.approvals.map((entry) => ({
      ...entry,
      presentation: entry.presentation ?? approvalKind(agent, entry),
    })),
  };
}

function projectCapabilities(agent: LiveSessionAgent, raw: unknown): CapabilityResult {
  const value = parseResult(capabilities, raw);
  const provider = sessionProviderDeclaration(agent);
  const commandMenu = projectCommandMenu(agent, value.commands);
  return {
    ...value,
    execution: projectSessionExecution(value),
    ...projectFeedback(value.reason),
    ...(provider ? { provider } : {}),
    ...(commandMenu ? { commandMenu } : {}),
  };
}

function projectQueue(raw: unknown): SessionProviderResults["queue-list"] {
  const value = parseResult(queue, raw);
  return {
    ...value,
    data: value.data.map((item) => {
      const input = queuedInput.safeParse(item.input);
      const hasAttachments =
        item.hasAttachments === true ||
        (input.success &&
          input.data.some(
            (entry) => entry.type !== "text" || entry.text?.startsWith("User attached file "),
          ));
      if (!hasAttachments) return item;
      // The host refuses text edits on queued input with attachments for every provider.
      return {
        ...item,
        actions: {
          ...item.actions,
          update: { available: false, reason: "queue_attachments_edit_unsupported" },
        },
      };
    }),
  };
}

function projectControl(_agent: LiveSessionAgent, raw: unknown): ControlResult {
  const value = parseResult(control, raw);
  return { ...value, ...projectFeedback(value.reason) };
}

export const sessionResultProjectors = {
  create: projectControl,
  capabilities: projectCapabilities,
  live: projectLive,
  inspect: (_agent, raw) => parseResult(inspect, raw),
  usage: (_agent, raw) => parseResult(usage, raw),
  "queue-list": (_agent, raw) => projectQueue(raw),
  "settings-state": (_agent, raw) => parseResult(settings, raw),
  "settings-prepare": (_agent, raw) => parseResult(settings, raw),
  settings: projectControl,
  send: projectControl,
  steer: projectControl,
  "queue-add": projectControl,
  "queue-update": projectControl,
  "queue-delete": projectControl,
  "queue-steer": projectControl,
  "queue-reorder": projectControl,
  "queue-start": projectControl,
  "queue-pause": projectControl,
  "queue-resume": projectControl,
  stop: projectControl,
  approve: projectControl,
  answer: projectControl,
} satisfies {
  [Operation in SessionProviderOperation]: (
    agent: LiveSessionAgent,
    raw: unknown,
  ) => SessionProviderResults[Operation];
};

type ExecuteSessionRequest = (request: SessionProviderRequest) => Promise<unknown>;

class SessionProviderAdapter implements TypedSessionProvider {
  readonly #provider: SessionProviders[LiveSessionAgent];
  readonly validateControl?: ProviderControlValidator;

  constructor(
    provider: SessionProviders[LiveSessionAgent],
    private readonly execute?: ExecuteSessionRequest,
  ) {
    this.#provider = provider;
    this.validateControl = provider.validateControl;
  }

  get agent(): LiveSessionAgent {
    return this.#provider.agent;
  }

  request<Request extends SessionProviderRequest>(
    request: Request,
  ): Promise<SessionProviderResponse<Request["operation"]>>;
  async request(request: SessionProviderRequest): Promise<SessionProviderResponse> {
    const { operation } = request;
    const raw = await (this.execute ? this.execute(request) : this.#execute(request));
    return {
      operation,
      result: sessionResultProjectors[operation](this.agent, raw),
    } as SessionProviderResponse;
  }

  async #execute(request: SessionProviderRequest): Promise<unknown> {
    const provider = this.#provider;
    const { operation } = request;
    switch (operation) {
      case "create": {
        if (!("create" in provider)) throw new Error("unsupported-session-provider-operation");
        const { prompt, ...fields } = request;
        const acceptsPrompt =
          sessionProviderCapabilities(provider.agent)?.create.mode === "with-first-message";
        return provider.create({
          ...fields,
          operation: provider.createOperation,
          ...(acceptsPrompt && prompt !== undefined ? { prompt } : {}),
        });
      }
      case "capabilities":
      case "inspect":
        return provider.query(request);
      case "live":
        return provider.live(request.sessionId, request.experimentalEnabled === true);
      case "usage":
        return provider.contextUsage(request.sessionId);
      case "queue-list":
        if (!provider.queue) throw new Error("unsupported-session-provider-operation");
        return provider.queue(request);
      case "settings-state":
        if (!("settingsState" in provider))
          throw new Error("unsupported-session-provider-operation");
        return provider.settingsState(request);
      case "settings-prepare":
        if (!("prepareSettings" in provider) || !provider.prepareSettings)
          throw new Error("unsupported-session-provider-operation");
        return provider.prepareSettings(request);
      case "settings":
        if (!("updateSettings" in provider))
          throw new Error("unsupported-session-provider-operation");
        return provider.updateSettings(request);
      default:
        return provider.control(request);
    }
  }
}

export class SessionProviderRegistry {
  readonly #providers: SessionProviders;

  constructor(providers: SessionProviders) {
    this.#providers = providers;
  }

  runningSessionIds(): Set<string> {
    const ids = new Set<string>();
    for (const provider of Object.values(this.#providers)) {
      for (const id of provider.runningSessionIds?.() ?? []) ids.add(id);
    }
    return ids;
  }

  get(agent: unknown) {
    return agent === "antigravity" ? this.#providers.antigravity : this.creatable(agent);
  }

  typed(agent: unknown, execute?: ExecuteSessionRequest): TypedSessionProvider | undefined {
    const provider = this.get(agent);
    return (
      provider?.typed ?? (provider ? new SessionProviderAdapter(provider, execute) : undefined)
    );
  }

  creatable(agent: unknown) {
    return isSessionProviderAgent(agent) ? this.#providers[agent] : undefined;
  }

  require(agent: unknown) {
    const provider = this.creatable(agent);
    if (!provider) throw new Error("unsupported-session-provider");
    return provider;
  }
}
