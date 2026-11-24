export type NotificationCategory = "approval" | "question" | "completed" | "failed";

export interface NotificationQuietHours {
  /** Host-local wall time in HH:mm. The start is inclusive and the end exclusive. */
  start: string;
  end: string;
}

/** Settings for notifications from a single host, shared across its paired devices. */
export interface NotificationPolicy {
  enabled: boolean;
  categories: Record<NotificationCategory, boolean>;
  onlyAway: boolean;
  quietHours: NotificationQuietHours | null;
}

export type NotificationPolicyPatch = Partial<Omit<NotificationPolicy, "categories">> & {
  categories?: Partial<NotificationPolicy["categories"]>;
};
