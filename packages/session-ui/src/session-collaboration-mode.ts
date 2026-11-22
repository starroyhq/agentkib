import type {
  SessionSettings,
  SessionSettingValues,
  SessionActionBody,
} from "@agentkib/web-client";

type CollaborationMode = "default" | "plan";

/** Map native options and writes to the composer’s Plan mode action. */
export function sessionCollaborationMode(
  settings: SessionSettings | undefined,
  selection: SessionSettingValues | undefined,
) {
  if (!settings?.available) return undefined;
  const usePermissionMode =
    !settings.options.collaborationModes?.some(({ id }) => id === "plan") &&
    settings.options.permissionModes?.some(({ id }) => id === "plan") === true;
  const options = usePermissionMode
    ? settings.options.permissionModes
    : settings.options.collaborationModes;
  const modes: CollaborationMode[] = ["plan", "default"];
  const offered = modes.filter((mode) => options?.some((option) => option.id === mode));
  if (!offered.includes("plan")) return undefined;
  const native = usePermissionMode ? selection?.permissionMode : selection?.mode;
  const selected = native === "plan" || native === "default" ? native : undefined;
  const field = usePermissionMode ? settings.writable.permissionMode : settings.writable.mode;
  return {
    field: usePermissionMode ? "permissionMode" : "mode",
    modes: offered,
    selected,
    writable: field?.available === true,
    reason: field?.reason,
    change(mode: CollaborationMode): Pick<SessionActionBody, "mode" | "permissionMode"> {
      return usePermissionMode ? { permissionMode: mode } : { mode };
    },
  } as const;
}
