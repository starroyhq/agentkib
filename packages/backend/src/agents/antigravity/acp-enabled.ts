export const ANTIGRAVITY_ACP_DISABLED = "antigravity-acp-disabled";

/** Internal opt-in for development and synthetic ACP fixtures. */
export function antigravityAcpEnabled(environment: NodeJS.ProcessEnv): boolean {
  return environment.AGENTKIB_ENABLE_ANTIGRAVITY_ACP === "1";
}
