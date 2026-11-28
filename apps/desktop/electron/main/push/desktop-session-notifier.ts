import { homeSessionGroups, isSessionVisible, type HomeSession } from "@agentkib/session-catalog";
import {
  leadNotificationBusy,
  notificationSessionIds,
  notificationStates,
  type NotificationState,
} from "./notification-sessions";
import type { createDesktopNotificationPlatform } from "./desktop-notification-platform";
import { notificationTitle } from "./notification-title";

type NoticeKind = "approval" | "question" | "completed" | "failed";
type InteractionKind = "approval" | "question";
export type NotificationInteractionEvidence = Partial<Record<InteractionKind, readonly string[]>>;
type Notice =
  | { kind: InteractionKind; interactionId: string }
  | { kind: "completed" | "failed"; resultId: string };
type Platform = Pick<ReturnType<typeof createDesktopNotificationPlatform>, "show" | "dismiss">;
const interactionKinds = ["approval", "question"] as const;
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

/** Local delivery uses the verified catalog but never needs a remote subscription. */
export class DesktopSessionNotifier {
  #sessions?: Map<string, HomeSession>;
  #states = new Map<string, NotificationState>();
  #pending = new Map<string, Notice>();
  #shown = new Map<string, Notice>();
  #inFlight = new Map<string, Promise<void>>();
  #removals = new Map<string, Promise<void>>();
  #interactions = new Map<string, NotificationInteractionEvidence>();
  #read = new Set<string>();
  #results = new Map<string, string | null>();
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

  update(sessions: readonly HomeSession[] | undefined): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    this.#fresh = sessions !== undefined;
    if (!sessions) return Promise.resolve();
    const previous = this.#sessions;
    const rows = new Map(sessions.map((session) => [session.id, session]));
    this.#states = notificationStates(homeSessionGroups(sessions, { recent: 0 }));
    this.#sessions = rows;

    for (const id of this.#results.keys()) if (!rows.has(id)) this.#results.delete(id);
    for (const [id, row] of rows) {
      if (!this.#available(id)) continue;
      const state = this.#states.get(id);
      const read = row.readState;
      const before = this.#results.get(id);
      const resultId = read?.latestResult?.id;
      const working =
        state === "running" || state === "needs:approval" || state === "needs:question";
      // Remember the last proven result even when the entire next turn fits in one catalog batch.
      if (read?.freshness === "current" && (!working || before === undefined)) {
        this.#results.set(id, resultId ?? null);
        if (
          previous?.has(id) &&
          before !== undefined &&
          resultId &&
          resultId !== before &&
          (state === "result:completed" || state === "result:failed") &&
          !this.#read.has(JSON.stringify([id, resultId]))
        )
          this.#pending.set(id, {
            kind: state === "result:completed" ? "completed" : "failed",
            resultId,
          });
      } else if (working && before === undefined) {
        this.#results.set(id, resultId ?? null);
      }
      const shown = this.#shown.get(id);
      if (
        shown &&
        "resultId" in shown &&
        read?.status === "read" &&
        read.freshness === "current" &&
        resultId === shown.resultId
      )
        void this.#dismiss(id);
    }
    return this.refresh();
  }

  /** Only positively observed request identities can replace or withdraw an interaction card. */
  observeInteractions(
    sessionId: string,
    evidence: NotificationInteractionEvidence,
    seed = false,
  ): Promise<void> {
    if (this.#stopped || !this.options.enabled()) return Promise.resolve();
    const id = this.#knownId(sessionId) ?? sessionId;
    const before = this.#interactions.get(id);
    const next = { ...before, ...evidence };
    if (next.approval?.length || next.question?.length) this.#interactions.set(id, next);
    else this.#interactions.delete(id);

    let replaced = false;
    for (const notice of [this.#pending.get(id), this.#shown.get(id)]) {
      if (!notice || !("interactionId" in notice)) continue;
      const observed = evidence[notice.kind];
      if (!observed || observed.includes(notice.interactionId)) continue;
      if (this.#pending.get(id) === notice) this.#pending.delete(id);
      if (this.#shown.get(id) === notice) {
        replaced = true;
        void this.#dismiss(id);
      }
    }

    const shown = this.#shown.get(id);
    if ((!seed || replaced) && !(shown && "interactionId" in shown)) {
      for (const kind of interactionKinds) {
        const interactionId = evidence[kind]?.find(
          (candidate) => replaced || !before?.[kind]?.includes(candidate),
        );
        if (interactionId) {
          this.#pending.set(id, { kind, interactionId });
          break;
        }
      }
    }
    return this.refresh();
  }

  invalidateInteractions(): void {
    this.#interactions.clear();
    for (const [id, notice] of this.#pending)
      if ("interactionId" in notice) this.#pending.delete(id);
  }

  refresh(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (!this.options.enabled()) {
      this.#pending.clear();
      this.#interactions.clear();
      for (const id of this.#shown.keys()) void this.#dismiss(id);
    } else {
      for (const [id, notice] of this.#pending)
        if (this.#available(id) && !this.#inFlight.has(id)) this.#start(id, notice);
    }
    return Promise.all([...this.#inFlight.values(), ...this.#removals.values()]).then(() => {});
  }

  /** The host confirmed the acknowledgement for this exact result. */
  acknowledge(sessionId: string, resultId: string): void {
    const id = this.#knownId(sessionId) ?? sessionId;
    const key = JSON.stringify([id, resultId]);
    this.#read.delete(key);
    this.#read.add(key);
    if (this.#read.size > 256) this.#read.delete(this.#read.keys().next().value!);
    const pending = this.#pending.get(id);
    if (pending && "resultId" in pending && pending.resultId === resultId) this.#pending.delete(id);
    const shown = this.#shown.get(id);
    if (shown && "resultId" in shown && shown.resultId === resultId) void this.#dismiss(id);
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
    if (this.#shown.delete(id)) {
      const removal = this.options.platform.dismiss(id).catch(() => undefined);
      this.#removals.set(id, removal);
      await removal;
      if (this.#removals.get(id) === removal) this.#removals.delete(id);
    } else await this.#removals.get(id);
  }

  #available(id: string): HomeSession | undefined {
    const row = this.#sessions?.get(id);
    return this.#fresh &&
      row?.availability === "readable" &&
      !row.remote &&
      !row.archived &&
      isSessionVisible(row)
      ? row
      : undefined;
  }

  #current(id: string, notice: Notice): HomeSession | undefined {
    const row = this.#available(id);
    if (
      this.#stopped ||
      this.#pending.get(id) !== notice ||
      !row ||
      !this.options.delivery(notice.kind) ||
      notificationSessionIds(row).some(this.options.isViewing)
    )
      return undefined;
    if ("interactionId" in notice)
      return this.#interactions.get(id)?.[notice.kind]?.includes(notice.interactionId)
        ? row
        : undefined;
    return this.#states.get(id) === `result:${notice.kind}` &&
      row.readState?.latestResult?.id === notice.resultId &&
      row.readState.freshness === "current" &&
      !this.#read.has(JSON.stringify([id, notice.resultId]))
      ? row
      : undefined;
  }

  #start(id: string, notice: Notice): Promise<void> {
    const running = this.#deliver(id, notice)
      .catch(() => undefined)
      .finally(() => {
        this.#inFlight.delete(id);
        const next = this.#pending.get(id);
        if (next && next !== notice && this.#available(id)) return this.#start(id, next);
      });
    this.#inFlight.set(id, running);
    return running;
  }

  async #deliver(id: string, notice: Notice): Promise<void> {
    if (!this.#available(id)) return;
    const row = this.#current(id, notice);
    if (!row) {
      this.#pending.delete(id);
      return;
    }
    const isResult = "resultId" in notice;
    const shown = this.#shown.get(id);
    if (isResult && shown && "interactionId" in shown) return;
    if (isResult && leadNotificationBusy(row, [...(this.#sessions?.values() ?? [])], this.#states))
      return;

    const worker = await this.options.workerStatus(notificationSessionIds(row), notice.kind);
    const latest = this.#current(id, notice);
    if (!latest) {
      if (this.#available(id) && this.#pending.get(id) === notice) this.#pending.delete(id);
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
    await this.#dismiss(id);
    if (!this.#current(id, notice)) return;
    this.#shown.set(id, notice);
    try {
      const shown = await this.options.platform.show(
        {
          sessionId: id,
          title: notificationTitle(latest, copy[0]),
          body: copy[stateIndex[notice.kind]],
          silent: this.options.silent(),
        },
        () => !!this.#current(id, notice),
      );
      if (!shown && this.#shown.get(id) === notice) this.#shown.delete(id);
      // An acknowledgement or a newer state may have arrived while the OS was posting.
      if (shown && this.#shown.get(id) !== notice) await this.options.platform.dismiss(id);
    } finally {
      if (this.#pending.get(id) === notice) this.#pending.delete(id);
    }
  }
}
