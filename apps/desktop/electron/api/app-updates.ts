export interface AppUpdateAvailability {
  updates_enabled: boolean;
  updates_managed_by_store?: boolean;
}

export type AppUpdateInstallMode = "in-app" | "manual";
export interface AppUpdateInfo {
  current_version: string;
  version: string;
  published_at?: string;
  notes?: string;
  release_url: string;
  install_mode: AppUpdateInstallMode;
}
export type AppUpdateProgress =
  | { event: "started"; data: { content_length?: number } }
  | { event: "progress"; data: { downloaded: number; content_length?: number } }
  | { event: "finished" };
