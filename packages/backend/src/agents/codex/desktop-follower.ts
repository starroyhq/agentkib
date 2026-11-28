import path from "node:path";
import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
import { managedSessionHasUnknownCommands, readUnknownManagedCommands } from "../../managed-ledger";
import { canonicalize, pathIdentity } from "../../paths";
import type { LaneObserver } from "../../sessions/lane-observer";
import type { BackendStore } from "../../store";
import { CodexDesktopApp, type CodexDesktopWriter } from "./codex-desktop-app";
import { CodexFollowerBridge } from "./codex-follower-bridge";
import {
  codexEndpointNotListening,
  CodexDesktopConnectionError,
  CodexFollowerConnection,
} from "./codex-follower-connection";
import type { CodexFollowerState } from "./codex-follower-state";
import { CodexFollowerStream } from "./codex-follower-stream";
import { readManagedRecords, type ManagedRecord } from "./managed-records";

const FOLLOWER_RETRY_MS = 5_000;
const FOLLOWER_IDLE_MS = 30_000;
/** How long a send waits for the Codex app to take a thread it was asked to show. */
const HANDOFF_TIMEOUT_MS = 8_000;
const HANDOFF_POLL_MS = 250;

const MAX_MACOS_IPC_PATH_BYTES = 103;

function followerEndpoint(home: string) {
  return path.join(home, "ipc", "ipc.sock");
}

export type WorkerLiveRead = "read" | "send";

function codexDesktopFailure(error: unknown): string {
  return error instanceof CodexDesktopConnectionError
    ? error.code
    : "codex-desktop-owner-unavailable";
}

type CodexDesktopHandoff = { follower: CodexFollowerRecord; revision: number } | { reason: string };

export type CodexFollowerRecord = {
  bridge: CodexFollowerBridge;
  workspaceId: string;
  nativeId: string;
};

type CachedFollower = CodexFollowerRecord & {
  stream: CodexFollowerStream;
  workspace: string;
  lastUsed: number;
};

type CodexDesktopFollowerDependencies = {
  dataDir: string;
  store: BackendStore;
  environment: NodeJS.ProcessEnv;
  runtimeBootId: string;
  assertManagedHome(record: ManagedRecord): string;
  writerLock(record: ManagedRecord): string;
  inactiveRecord(sessionId: string): Promise<ManagedRecord>;
  assertOpen(): void;
  isShuttingDown(): boolean;
  isSessionObserved(sessionId: string): boolean | undefined;
  publishConversationEvent(
    sessionId: string,
    type: "state" | "text-delta" | "item-upsert" | "snapshot",
    payload: Record<string, unknown>,
    live: Record<string, unknown>,
    item?: Record<string, unknown>,
  ): void;
  hasLaneObserver(): boolean;
  observeLane(notify: (observer: LaneObserver) => void): void;
};

export class CodexDesktopFollower {
  #codexFollowers = new Map<string, CachedFollower>();
  #codexFollowerFlights = new Map<string, Promise<CachedFollower>>();
  #followerMisses = new Map<
    string,
    {
      at: number;
      home: string;
      nativeId: string | null | undefined;
      writer?: CodexDesktopWriter;
    }
  >();
  /** Sessions whose last owner discovery answered that nobody holds the thread's window. */
  #ownerMissing = new Set<string>();
  /** When a send last asked the Codex app for a thread and the app did not take it. */
  #handoffFailures = new Map<string, number>();
  readonly #desktopApp: CodexDesktopApp;
  readonly #handoffTimeoutMs: number;
  #handoffFlights = new Map<string, Promise<CodexDesktopHandoff>>();

  constructor(private readonly dependencies: CodexDesktopFollowerDependencies) {
    const { environment } = dependencies;
    this.#desktopApp = new CodexDesktopApp(environment);
    const handoffTimeout = Number(environment.AGENTKIB_CODEX_HANDOFF_TIMEOUT_MS);
    this.#handoffTimeoutMs =
      environment.AGENTKIB_CODEX_HANDOFF_TIMEOUT_MS !== undefined &&
      Number.isSafeInteger(handoffTimeout) &&
      handoffTimeout > 0
        ? handoffTimeout
        : HANDOFF_TIMEOUT_MS;
  }

  closeDiscovery(): void {
    this.#desktopApp.close();
  }

  closeFollowers(): void {
    for (const follower of this.#codexFollowers.values()) follower.bridge.close();
    this.#codexFollowers.clear();
  }

  get(sessionId: string): CodexFollowerRecord | undefined {
    return this.#codexFollowers.get(sessionId);
  }

  disconnect(sessionId: string): void {
    this.#followerMisses.delete(sessionId);
    this.#ownerMissing.delete(sessionId);
    const follower = this.#codexFollowers.get(sessionId);
    if (follower) {
      this.#codexFollowers.delete(sessionId);
      follower.bridge.close();
    }
  }

  #recentMiss(record: ManagedRecord) {
    const miss = this.#followerMisses.get(record.id);
    return miss &&
      miss.home === record.home &&
      miss.nativeId === record.native_id &&
      Date.now() - miss.at < FOLLOWER_RETRY_MS
      ? miss
      : undefined;
  }

  desktopOwnerUnavailable(record: ManagedRecord): boolean {
    return !!this.#recentMiss(record)?.writer;
  }

  /** Codex desktop IPC compatibility: confirmed no listener for the desktop writer. */
  async #recordMiss(
    record: ManagedRecord,
    error: unknown,
  ): Promise<CodexDesktopWriter | undefined> {
    let writer: CodexDesktopWriter | undefined;
    if (codexEndpointNotListening(error) && record.native_id) {
      try {
        const endpoint = followerEndpoint(this.dependencies.assertManagedHome(record));
        // Codex can map a long direct socket path to a shorter one.
        if (Buffer.byteLength(endpoint) <= MAX_MACOS_IPC_PATH_BYTES)
          writer = await this.#desktopApp.writerOwner(this.dependencies.writerLock(record));
      } catch {
        // Without ownership evidence the existing wait queue remains available.
      }
    }
    this.#followerMisses.set(record.id, {
      at: Date.now(),
      home: record.home,
      nativeId: record.native_id,
      writer,
    });
    return writer;
  }

  /** Resident native overlays also seed subscriptions that have not received any events yet. */
  readSnapshot(sessionId: string): ReturnType<CodexFollowerStream["snapshot"]> | undefined {
    const follower = this.#codexFollowers.get(sessionId);
    if (!follower?.bridge.connected || follower.bridge.selectedState?.revision == null)
      return undefined;
    return follower.stream.snapshot();
  }

  activeTurn(nativeId: string, workspaceIdentity: string): string | null {
    for (const follower of this.#codexFollowers.values()) {
      if (
        follower.nativeId === nativeId &&
        pathIdentity(follower.workspace) === workspaceIdentity &&
        follower.bridge.connected
      ) {
        const state = follower.bridge.selectedState;
        if (state?.status === "running" || state?.status === "awaiting-approval") {
          const turnId = state.activeTurn();
          if (turnId) return turnId;
        }
      }
    }
    return null;
  }

  retireIdle(): void {
    for (const [id, follower] of this.#codexFollowers) {
      if (
        !this.dependencies.isSessionObserved(id) &&
        Date.now() - follower.lastUsed >= FOLLOWER_IDLE_MS
      ) {
        this.#codexFollowers.delete(id);
        follower.bridge.close();
      }
    }
  }

  async connect(record: ManagedRecord): Promise<CachedFollower> {
    if (!CodexFollowerConnection.supported()) throw new Error("platform-unsupported");
    if (!record.native_id) throw new Error("native-session-unconfirmed");
    const workspace = canonicalize(this.dependencies.store.workspacePath(record.workspace_id));
    if (pathIdentity(workspace) !== pathIdentity(canonicalize(record.workspace)))
      throw new Error("session-workspace-mismatch");
    const home = this.dependencies.assertManagedHome(record);
    const nativeId = record.native_id;
    const sessionId = record.id;
    const cached = this.#codexFollowers.get(sessionId);
    if (
      cached?.bridge.connected &&
      cached.nativeId === nativeId &&
      cached.workspaceId === record.workspace_id
    ) {
      cached.lastUsed = Date.now();
      return cached;
    }
    if (cached) {
      this.#codexFollowers.delete(sessionId);
      cached.bridge.close();
    }

    const pending = this.#codexFollowerFlights.get(sessionId);
    if (pending) return pending;
    const flight = this.#connect(record, workspace, nativeId, home);
    this.#codexFollowerFlights.set(sessionId, flight);
    try {
      return await flight;
    } finally {
      if (this.#codexFollowerFlights.get(sessionId) === flight)
        this.#codexFollowerFlights.delete(sessionId);
    }
  }

  async #connect(
    record: ManagedRecord,
    workspace: string,
    nativeId: string,
    home: string,
  ): Promise<CachedFollower> {
    const sessionId = record.id;
    if (this.#codexFollowers.size >= 8) {
      const candidates = [...this.#codexFollowers.entries()]
        .filter(
          ([id, value]) =>
            id !== sessionId &&
            !this.dependencies.isSessionObserved(id) &&
            value.bridge.selectedState?.status === "idle" &&
            value.bridge.selectedState.approvals(false).length === 0,
        )
        .sort(([, left], [, right]) => left.lastUsed - right.lastUsed);
      const [retireId, retire] = candidates[0] ?? [];
      if (!retireId || !retire) throw new Error("live-session-busy");
      this.#codexFollowers.delete(retireId);
      retire.bridge.close();
    }
    let bridge: CodexFollowerBridge | undefined;
    const stream = new CodexFollowerStream();
    const watch = { running: new Set<string>(), waiting: "" };
    const publish = (snapshot: ReturnType<CodexFollowerState["streamSnapshot"]>) => {
      const state = bridge?.selectedState;
      if (!state) return;
      const live = this.#projectLive(record, state, true, bridge?.connection?.desktopVersion);
      stream.publish(snapshot, live, (type, payload, live, item) =>
        this.dependencies.publishConversationEvent(sessionId, type, payload, live, item),
      );
      this.#observeFollowedLane(sessionId, state, live, watch);
    };
    bridge = await CodexFollowerBridge.connect(followerEndpoint(home), nativeId, publish);
    try {
      const latest =
        readManagedRecords(this.dependencies.dataDir, this.dependencies.store).find(
          (item) => item.id === sessionId,
        ) ?? (await this.dependencies.inactiveRecord(sessionId));
      this.dependencies.assertOpen();
      if (latest.native_id !== nativeId || latest.workspace_id !== record.workspace_id)
        throw new Error("session-unavailable");
      const follower = {
        bridge,
        stream,
        workspaceId: record.workspace_id,
        workspace,
        nativeId,
        lastUsed: Date.now(),
      };
      this.#codexFollowers.set(sessionId, follower);
      if (bridge.selectedState) publish(bridge.selectedState.streamSnapshot());
      return follower;
    } catch (error) {
      bridge.close();
      throw error;
    }
  }

  /**
   * A turn of a session the Codex app runs, seen through its follower: a lead hears that it
   * ended, or waits for the person, as of the turns AgentKib runs. Only turns this follower saw
   * running count as ended.
   */
  #observeFollowedLane(
    sessionId: string,
    state: CodexFollowerState,
    live: Record<string, unknown>,
    watch: { running: Set<string>; waiting: string },
  ): void {
    if (!this.dependencies.hasLaneObserver()) return;
    for (const turn of state.turnOutcomes()) {
      if (turn.running) watch.running.add(turn.turnId);
      else if (watch.running.delete(turn.turnId) && turn.meta) {
        const { outcome, duration_ms } = turn.meta;
        this.dependencies.observeLane((observer) =>
          observer.turnEnded(
            sessionId,
            turn.turnId,
            outcome === "aborted" ? "cancelled" : (outcome ?? "ended"),
            duration_ms ?? null,
          ),
        );
      }
    }
    const waiting =
      live.status === "awaiting-approval" || live.status === "waiting-input"
        ? `${String(live.turnId ?? "")}:${String(live.status)}`
        : "";
    if (waiting && waiting !== watch.waiting)
      this.dependencies.observeLane((observer) =>
        observer.waiting(
          sessionId,
          typeof live.turnId === "string" ? live.turnId : null,
          String(live.status),
        ),
      );
    watch.waiting = waiting;
  }

  /** A connected follower still tracking the record's native conversation with a valid snapshot. */
  attached(record: { id: string; native_id?: string | null }): CachedFollower | undefined {
    const follower = this.#codexFollowers.get(record.id);
    return follower?.bridge.connected &&
      follower.nativeId === record.native_id &&
      (follower.bridge.selectedState?.revision ?? null) !== null
      ? follower
      : undefined;
  }

  #projectLive(
    record: ManagedRecord,
    state: CodexFollowerState,
    controls: boolean,
    codexDesktopVersion: string | undefined,
  ): Record<string, unknown> {
    const unknown = managedSessionHasUnknownCommands(this.dependencies.dataDir, record.id);
    const live = state.live(controls && !unknown);
    return {
      ...live,
      ...(record.snapshot?.settingsStaged === true ? { sendEnabled: false } : {}),
      // The follower transport does not forward user-input answers.
      questions: (Array.isArray(live.questions) ? live.questions : []).map((question) => ({
        ...question,
        supported: false,
      })),
      sessionId: record.id,
      runtimeBootId: this.dependencies.runtimeBootId,
      workspaceId: record.workspace_id,
      executionMode: "codex-follower",
      codexDesktopVersion,
      executionLocation: "external",
      connectionGeneration: state.settingsWriteScope,
      ownershipReason: null,
      ...(unknown
        ? { reason: "control-outcome-unconfirmed", sendEnabled: false, stopEnabled: false }
        : {}),
    };
  }

  async live(
    record: ManagedRecord,
    inactive: Record<string, unknown>,
    controls: boolean,
    worker?: WorkerLiveRead,
  ): Promise<Record<string, unknown> | undefined> {
    if (
      inactive.ownershipReason !== "codex-owner-busy" ||
      (inactive.reason !== "codex-owner-busy" &&
        (inactive.reason !== "control-outcome-unconfirmed" ||
          !readUnknownManagedCommands(this.dependencies.dataDir, record.id).some(
            ({ evidence }) =>
              evidence?.operation === "settings" && evidence.executionMode === "codex-follower",
          )))
    )
      return undefined;
    const sending = worker === "send";
    const refused = (reason: string) =>
      sending && inactive.reason === "codex-owner-busy"
        ? { ...inactive, sendEnabled: false, reason }
        : undefined;
    const unavailable = (writer: CodexDesktopWriter | undefined) =>
      writer && !worker && inactive.reason === "codex-owner-busy"
        ? {
            ...inactive,
            reason: REMOTE_ERROR_CODES.codexDesktopIpcUnavailable,
            codexDesktopVersion: writer.version,
            sendEnabled: false,
            stopEnabled: false,
            ownerWaitAvailable: false,
          }
        : undefined;
    if (!CodexFollowerConnection.supported()) return refused("platform-unsupported");
    const miss = this.#recentMiss(record);
    if (!sending && miss) return unavailable(miss.writer);
    // Passive checks may follow a proven running turn. For an idle lock, only inspect
    // an already attached owner's active turn and leave the normal idle expiry alone.
    const cached =
      worker && !controls && !isObject(inactive.externalTurn) ? this.attached(record) : null;
    if (
      worker &&
      !controls &&
      !isObject(inactive.externalTurn) &&
      !cached?.bridge.selectedState?.activeTurn()
    )
      return undefined;
    try {
      const follower = cached ?? (await this.connect(record));
      const state = cached?.bridge.selectedState ?? (await follower.bridge.observeLive());
      if (!cached) follower.lastUsed = Date.now();
      this.#ownerMissing.delete(record.id);
      this.#followerMisses.delete(record.id);
      const live = this.#projectLive(
        record,
        state,
        controls,
        follower.bridge.connection?.desktopVersion,
      );
      if (!worker) return live;
      const active = typeof live.turnId === "string" ? live.turnId : null;
      const nativeTurn = isObject(inactive.externalTurn) ? inactive.externalTurn.turnId : null;
      const nativeProgress =
        nativeTurn && active && nativeTurn !== active ? null : inactive.workerProgress;
      const commands = !active || nativeTurn === active ? inactive.commands : undefined;
      const { items } = follower.stream.snapshot();
      const output = active
        ? items.filter((item) => item.turn_id === active && item.kind === "agent-message").at(-1)
        : undefined;
      const content = typeof output?.content === "string" ? output.content : "";
      // The owner can briefly say idle while the lock and rollout still prove an open turn.
      // A new owner item or text is progress, but a tool status refresh is not.
      return {
        ...live,
        externalTurn: inactive.externalTurn,
        ...(commands !== undefined ? { commands } : {}),
        ...(active || typeof nativeProgress === "string"
          ? {
              workerProgress: JSON.stringify([
                nativeProgress,
                output?.id,
                content.length,
                content.slice(-128),
              ]),
            }
          : {}),
        ...(output?.truncated === true ? { streamTextTruncated: true } : {}),
      };
    } catch (error) {
      const follower = this.#codexFollowers.get(record.id);
      if (follower) {
        this.#codexFollowers.delete(record.id);
        follower.bridge.close();
      }
      const reason = codexDesktopFailure(error);
      const writer = await this.#recordMiss(record, error);
      if (reason === "codex-desktop-owner-missing") {
        this.#ownerMissing.add(record.id);
        const handoff = sending ? await this.handoffLive(record, inactive, controls) : undefined;
        return handoff ?? refused(reason);
      }
      this.#ownerMissing.delete(record.id);
      return unavailable(writer) ?? refused(reason);
    }
  }

  /**
   * The Codex app's server holds the thread and no window answers for it: sending stays open,
   * and a send asks the app to show the thread (`handoff`). The session still reads as in
   * use in Codex; `ownerHandoff` tells a client it may send. Not offered again for a minute
   * after the app did not take the thread.
   */
  async handoffLive(
    record: ManagedRecord,
    inactive: Record<string, unknown>,
    controls: boolean,
  ): Promise<Record<string, unknown> | undefined> {
    const failed = this.#handoffFailures.get(record.id);
    if (
      !controls ||
      inactive.reason !== "codex-owner-busy" ||
      inactive.ownershipReason !== "codex-owner-busy" ||
      !record.native_id ||
      record.snapshot?.settingsStaged === true ||
      !this.#ownerMissing.has(record.id) ||
      (failed !== undefined && Date.now() - failed < 60_000) ||
      !CodexFollowerConnection.supported() ||
      managedSessionHasUnknownCommands(this.dependencies.dataDir, record.id)
    )
      return undefined;
    if (!(await this.#desktopApp.running())) return undefined;
    return { ...inactive, sendEnabled: true, ownerHandoff: true };
  }

  /**
   * Asks the running Codex app to show a thread its server holds with no window answering for
   * it, then follows the app. Only a send asks: opening the session in AgentKib must not move
   * the app's page. Never launches the app, never takes the writer lock and sends nothing by
   * itself; a refusal leaves the session in use in Codex.
   */
  async handoff(record: ManagedRecord): Promise<CodexDesktopHandoff> {
    if (!CodexFollowerConnection.supported()) return { reason: "platform-unsupported" };
    if (!record.native_id) return { reason: "native-session-unconfirmed" };
    const pending = this.#handoffFlights.get(record.id);
    if (pending) return pending;
    const flight = this.#runHandoff(record, record.native_id);
    this.#handoffFlights.set(record.id, flight);
    try {
      const handed = await flight;
      if ("follower" in handed) this.#handoffFailures.delete(record.id);
      else this.#handoffFailures.set(record.id, Date.now());
      return handed;
    } finally {
      if (this.#handoffFlights.get(record.id) === flight) this.#handoffFlights.delete(record.id);
    }
  }

  async #runHandoff(record: ManagedRecord, nativeId: string): Promise<CodexDesktopHandoff> {
    const attach = async (): Promise<CodexDesktopHandoff> => {
      try {
        const follower = await this.connect(record);
        const state = await follower.bridge.observeLive();
        follower.lastUsed = Date.now();
        this.#ownerMissing.delete(record.id);
        this.#followerMisses.delete(record.id);
        return state.revision === null
          ? { reason: "codex-desktop-ipc-incompatible" }
          : { follower, revision: state.revision };
      } catch (error) {
        const follower = this.#codexFollowers.get(record.id);
        if (follower) {
          this.#codexFollowers.delete(record.id);
          follower.bridge.close();
        }
        await this.#recordMiss(record, error);
        return { reason: codexDesktopFailure(error) };
      }
    };
    // A window may have opened the thread since the session was last looked at.
    const first = await attach();
    if (!("reason" in first) || first.reason !== "codex-desktop-owner-missing") return first;
    if (!(await this.#desktopApp.running())) return first;
    if (!(await this.#desktopApp.openThread(nativeId)))
      return { reason: "codex-desktop-thread-open-failed" };
    const deadline = Date.now() + this.#handoffTimeoutMs;
    while (Date.now() < deadline && !this.dependencies.isShuttingDown()) {
      await new Promise((resolve) => setTimeout(resolve, HANDOFF_POLL_MS));
      const attached = await attach();
      if (!("reason" in attached) || attached.reason !== "codex-desktop-owner-missing")
        return attached;
    }
    return first;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
