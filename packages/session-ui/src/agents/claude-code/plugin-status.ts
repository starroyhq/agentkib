export type ClaudeBridgePluginInstallation = {
  scope: "user" | "project" | "local";
  version: string;
  projectPath?: string;
};

export type ClaudeBridgePluginStatus = {
  installedVersion: string | null;
  bundledVersion: string;
  status: "idle" | "updating" | "updated" | "failed";
  reason?: string;
  automaticEnabled?: boolean;
  canChangeAutomatic?: boolean;
  installations?: ClaudeBridgePluginInstallation[];
  installInstructions?: string;
};

function installation(value: unknown): value is ClaudeBridgePluginInstallation {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    (row.scope === "user" || row.scope === "project" || row.scope === "local") &&
    typeof row.version === "string" &&
    (row.projectPath === undefined || typeof row.projectPath === "string")
  );
}

export function readClaudeBridgePluginStatus(value: unknown): ClaudeBridgePluginStatus | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (
    (row.installedVersion !== null && typeof row.installedVersion !== "string") ||
    typeof row.bundledVersion !== "string" ||
    !["idle", "updating", "updated", "failed"].some((status) => row.status === status) ||
    (row.reason !== undefined && typeof row.reason !== "string") ||
    (row.automaticEnabled !== undefined && typeof row.automaticEnabled !== "boolean") ||
    (row.canChangeAutomatic !== undefined && typeof row.canChangeAutomatic !== "boolean") ||
    (row.installations !== undefined &&
      (!Array.isArray(row.installations) || !row.installations.every(installation))) ||
    (row.installInstructions !== undefined && typeof row.installInstructions !== "string")
  )
    return undefined;
  return value as ClaudeBridgePluginStatus;
}
