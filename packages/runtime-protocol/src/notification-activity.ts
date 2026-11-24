export type NotificationActivityCategory = "approval" | "question" | "verify" | "delegation";

export interface NotificationActivitySnapshot {
  /** Compare for equality within one authorized connection. */
  version: string;
  /** Epoch milliseconds when the host observed this data. */
  observedAt: number;
  waiting: number;
  running: number;
  /** Available in authenticated responses and encrypted alerts. */
  priority?: {
    sessionId: string;
    agent: string;
    category: NotificationActivityCategory;
    /** Number of sessions waiting in this category. */
    count: number;
    title?: string;
    /** Last known session update, or creation time if no update is known. */
    time?: string;
  };
}
