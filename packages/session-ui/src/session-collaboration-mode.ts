import type {
  CodexSessionSettings,
  CodexSettingValues,
  SessionActionBody,
} from "@agentkib/web-client";

type CollaborationMode = "default" | "plan";

/** Map native options and writes to the composer’s Plan mode action. */
export function sessionCollaborationMode(
  settings: CodexSessionSettings | undefined,
  selection: CodexSettingValues | undefined,
  usePermissionMode = false,
) {
  if (!settings?.available) return undefined;
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
    modes: offered,
    selected,
    writable: field?.available === true,
    reason: field?.reason,
    change(mode: CollaborationMode): Pick<SessionActionBody, "mode" | "permissionMode"> {
      return usePermissionMode ? { permissionMode: mode } : { mode };
    },
  } as const;
}
