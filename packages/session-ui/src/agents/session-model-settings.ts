import type { SessionProviderCapabilities } from "@agentkib/web-client";
import { terminalModelSettings } from "./claude-code/model-settings";

export { hasManagedPreparedSettings } from "./claude-code/model-settings";

export function sessionModelSettings(provider?: SessionProviderCapabilities) {
  return provider?.connection?.kind === "terminal-bridge" && provider.models.nativePicker
    ? terminalModelSettings
    : undefined;
}
