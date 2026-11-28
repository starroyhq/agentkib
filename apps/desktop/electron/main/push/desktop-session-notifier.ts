import {
  displaySessionTitle,
  homeSessionGroups,
  type HomeSession,
} from "@agentkib/session-catalog";
import {
  leadNotificationBusy,
  notificationSessionIds,
  notificationStates,
  type NotificationState,
} from "./notification-sessions";
import type { createDesktopNotificationPlatform } from "./desktop-notification-platform";

type NoticeKind = "approval" | "question" | "completed" | "failed";
type Notice = { kind: NoticeKind; state: NotificationState; resultId?: string };
type Platform = Pick<ReturnType<typeof createDesktopNotificationPlatform>, "show" | "dismiss">;
const knownInteractionStates = new Set([
  "idle",
  "running",
  "starting",
  "awaiting-approval",
  "waiting-input",
]);
const notificationCopy = {
  "zh-CN": ["未命名会话", "等待审批", "等待回答", "已完成", "失败"],
  "zh-Hant": ["未命名會話", "等待審批", "等待回答", "已完成", "失敗"],
  "en-US": [
    "Untitled session",
    "Waiting for approval",
    "Waiting for answer",
    "Completed",
    "Failed",
  ],
  "ja-JP": ["名前のないセッション", "承認待ち", "回答待ち", "完了", "失敗"],
} as const;
const stateIndex = { approval: 1, question: 2, completed: 3, failed: 4 } as const;
const resultState = (state: NotificationState) => state.startsWith("result:");

/** Local delivery uses the verified catalog but never needs a remote subscription. */
export class DesktopSessionNotifier {
  #sessions?: Map<string, HomeSession>;
  #states = new Map<string, NotificationState>();
  #pending = new Map<string, Notice>();
  #shown = new Map<string, Notice>();
  #inFlight = new Set<string>();
  #read = new Set<string>();
  #workedSince = new Map<string, string | null>();
  #fresh = false;
  #stopped = false;

  constructor(
    private readonly options: {
      platform: Platform;
      enabled(): boolean;
      delivery(kind: NoticeKind): boolean;
      workerResults(): boolean;
      workerStatus(
        ids: readonly string[],
        kind: NoticeKind,
      ): Promise<{ worker: boolean; delegated: boolean }>;
      isViewing(sessionId: string): boolean;
      silent(): boolean;
      locale(): keyof typeof notificationCopy;
    },
  ) {}

  update(sessions: readonly HomeSession[] | undefined): void {
    if (this.#stopped) return;
    this.#fresh = sessions !== undefined;
    if (!sessions) return;
    const next = notificationStates(homeSessionGroups(sessions, { recent: 0 }));
    const rows = new Map(sessions.map((session) => [session.id, session]));
    for (const id of this.#workedSince.keys()) {
      if (!rows.has(id)) this.#workedSince.delete(id);
    }
    for (const [id, state] of next) {
      const previous = this.#states.get(id);
      const readState = rows.get(id)?.readState;
      const resultId = readState?.latestResult?.id;
      if (state === "running" || state === "needs:approval" || state === "needs:question") {
        if (!this.#workedSince.has(id)) this.#workedSince.set(id, resultId ?? null);
        if (
          this.#sessions &&
          state !== previous &&
          state !== "running" &&
          this.#shown.get(id)?.state !== state
        ) {
          this.#pending.set(id, {
            state,
            kind: state === "needs:approval" ? "approval" : "question",
          });
        }
      } else if (
        (state === "result:completed" || state === "result:failed") &&
        readState?.freshness === "current" &&
        resultId &&
        this.#workedSince.has(id) &&
        resultId !== this.#workedSince.get(id)
      ) {
        this.#workedSince.delete(id);
        if (!this.#read.has(JSON.stringify([id, resultId]))) {
          this.#pending.set(id, {
            state,
            kind: state === "result:completed" ? "completed" : "failed",
            resultId,
          });
        }
      }
    }
    this.#states = next;
    this.#sessions = rows;

    for (const [id, notice] of this.#shown) {
      const row = rows.get(id);
      if (!row) continue;
      if (resultState(notice.state)) {
        const read = row.readState;
        if (
          read?.status === "read" &&
          read.freshness === "current" &&
          read.latestResult?.id === notice.resultId
        )
          void this.#dismiss(id);
      } else {
        const status = row.continuation?.status;
        if (
          status &&
          knownInteractionStates.has(status) &&
          next.get(id) !== "needs:verify" &&
          next.get(id) !== notice.state
        )
          void this.#dismiss(id);
      }
    }
    this.refresh();
  }

  refresh(): void {
    if (this.#stopped) return;
    if (!this.options.enabled()) {
      this.#pending.clear();
      for (const id of this.#shown.keys()) void this.#dismiss(id);
      return;
    }
    for (const [id, notice] of this.#pending) {
      if (this.#inFlight.has(id)) continue;
      this.#start(id, notice);
    }
  }

  /** The host confirmed the acknowledgement for this exact result. */
  acknowledge(sessionId: string, resultId: string): void {
    const id = this.#knownId(sessionId) ?? sessionId;
    const key = JSON.stringify([id, resultId]);
    this.#read.delete(key);
    this.#read.add(key);
    if (this.#read.size > 256) this.#read.delete(this.#read.keys().next().value!);
    if (this.#pending.get(id)?.resultId === resultId) this.#pending.delete(id);
    if (this.#shown.get(id)?.resultId === resultId) void this.#dismiss(id);
  }

  click(sessionId: string): void {
    void this.#dismiss(sessionId);
  }

  get hasDelivered(): boolean {
    return this.#shown.size > 0;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#pending.clear();
    const delivered = [...this.#shown.keys()];
    this.#shown.clear();
    await Promise.allSettled([...delivered.map((id) => this.options.platform.dismiss(id))]);
  }

  #knownId(id: string): string | undefined {
    if (this.#sessions?.has(id)) return id;
    const rows = [...(this.#sessions?.values() ?? [])].filter((row) =>
      notificationSessionIds(row).includes(id),
    );
    return rows.length === 1 ? rows[0]?.id : undefined;
  }

  async #dismiss(id: string): Promise<void> {
    if (this.#shown.delete(id)) await this.options.platform.dismiss(id).catch(() => undefined);
  }

  #current(id: string, notice: Notice): HomeSession | undefined {
    const row = this.#sessions?.get(id);
    if (
      !this.#fresh ||
      this.#stopped ||
      this.#pending.get(id) !== notice ||
      this.#states.get(id) !== notice.state ||
      !row ||
      (notice.resultId !== undefined &&
        (row.readState?.latestResult?.id !== notice.resultId ||
          row.readState.freshness !== "current" ||
          this.#read.has(JSON.stringify([id, notice.resultId])))) ||
      !this.options.delivery(notice.kind) ||
      notificationSessionIds(row).some(this.options.isViewing)
    )
      return undefined;
    return row;
  }

  #start(id: string, notice: Notice): void {
    this.#inFlight.add(id);
    void this.#deliver(id, notice)
      .catch(() => undefined)
      .finally(() => {
        this.#inFlight.delete(id);
        const next = this.#pending.get(id);
        if (next && next !== notice) this.#start(id, next);
      });
  }

  async #deliver(id: string, notice: Notice): Promise<void> {
    if (!this.#fresh) return;
    const row = this.#current(id, notice);
    if (!row) {
      this.#pending.delete(id);
      return;
    }
    const isResult = resultState(notice.state);
    if (isResult && leadNotificationBusy(row, [...(this.#sessions?.values() ?? [])], this.#states))
      return;

    const worker = await this.options.workerStatus(notificationSessionIds(row), notice.kind);
    const latest = this.#current(id, notice);
    if (!latest) {
      if (this.#fresh && this.#pending.get(id) === notice) this.#pending.delete(id);
      return;
    }
    if (worker.delegated) return;
    if (
      isResult &&
      (worker.worker || latest.orchestration?.role === "worker") &&
      !this.options.workerResults()
    ) {
      this.#pending.delete(id);
      return;
    }
    if (
      isResult &&
      leadNotificationBusy(latest, [...(this.#sessions?.values() ?? [])], this.#states)
    )
      return;

    const copy = notificationCopy[this.options.locale()];
    const title = displaySessionTitle(latest.title, copy[0]).replace(/\s+/g, " ").trim() || copy[0];
    await this.#dismiss(id);
    if (!this.#current(id, notice)) return;
    this.#shown.set(id, notice);
    try {
      const shown = await this.options.platform.show(
        {
          sessionId: id,
          title: [...title].slice(0, 100).join(""),
          body: copy[stateIndex[notice.kind]],
          silent: this.options.silent(),
        },
        () => !!this.#current(id, notice),
      );
      if (!shown && this.#shown.get(id) === notice) this.#shown.delete(id);
      // An acknowledgement or a newer state may have arrived while the OS was posting.
      if (shown && (!this.#current(id, notice) || this.#shown.get(id) !== notice)) {
        this.#shown.delete(id);
        await this.options.platform.dismiss(id);
      }
    } finally {
      if (this.#pending.get(id) === notice) this.#pending.delete(id);
    }
  }
}
