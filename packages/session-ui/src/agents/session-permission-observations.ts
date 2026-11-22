import type { SessionProviderDeclaration } from "@agentkib/web-client";
import { claudePermissionObservation } from "./claude-code/permission-observation";

export const terminalPermissionObservation = claudePermissionObservation;

export function sessionPermissionObservation(provider?: SessionProviderDeclaration) {
  return provider?.connection?.kind === "terminal-bridge"
    ? terminalPermissionObservation
    : undefined;
}
