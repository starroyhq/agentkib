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
  /** Optional on version 1 hosts. Version 2 defaults to suppressing Worker results. */
  workerResults?: boolean;
}

export type NotificationPolicyPatch = Partial<Omit<NotificationPolicy, "categories">> & {
  categories?: Partial<NotificationPolicy["categories"]>;
};

export type DesktopNotificationPermission =
  | "not-determined"
  | "denied"
  | "authorized"
  | "unsupported"
  | "unknown";

/** Local desktop IPC. The existing policy's enabled and onlyAway fields apply to the phone. */
export interface DesktopNotificationSettings {
  policy: Required<NotificationPolicy>;
  /** The user's preference, independent of the current operating system permission. */
  desktopEnabled: boolean;
  permission: DesktopNotificationPermission;
}

/** Persist the desktop switch separately from edits to the shared/mobile policy. */
export type DesktopNotificationSettingsPatch =
  | (NotificationPolicyPatch & { desktopEnabled?: never })
  | ({ desktopEnabled: boolean } & { [Key in keyof NotificationPolicyPatch]?: never });
