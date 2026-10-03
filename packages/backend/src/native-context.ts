import path from "node:path";
import { userHome } from "./mcp-config-read";
import { pathIdentity } from "./paths";
import { compareUtf8 } from "./workspaces";
import type { NativeContext } from "./workspaces";

/** Resolve the ordered Agent configuration homes consumed by workspace and discovery planning. */
export function nativeContext(environment: NodeJS.ProcessEnv): NativeContext {
  const home =
      process.platform === "win32"
        ? (environment.USERPROFILE ?? environment.HOME ?? userHome(environment))
        : userHome(environment),
    config =
      environment.XDG_CONFIG_HOME && path.isAbsolute(environment.XDG_CONFIG_HOME)
        ? environment.XDG_CONFIG_HOME
        : path.join(home, ".config"),
    candidates = [
      environment.CODEX_HOME ?? path.join(home, ".codex"),
      environment.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"),
      path.join(home, ".cursor"),
      path.join(config, "opencode"),
      environment.OPENCLAW_STATE_DIR ?? path.join(home, ".openclaw"),
      environment.HERMES_HOME ?? path.join(home, ".hermes"),
      environment.GROK_HOME ?? path.join(home, ".grok"),
      path.join(home, ".gemini"),
      environment.DSH_HOME ?? path.join(home, ".dsh"),
    ],
    homes = new Map<string, string>();
  for (const candidate of candidates) {
    const identity = pathIdentity(candidate);
    if (!homes.has(identity)) homes.set(identity, candidate);
  }
  const agentkib_home =
    environment.AGENTKIB_HOME ??
    path.join(
      home,
      environment.AGENTKIB_APP_FLAVOR === "ai.agentkib.dev" ? ".agentkib-dev" : ".agentkib",
    );
  const identity = pathIdentity(agentkib_home);
  if (!homes.has(identity)) homes.set(identity, agentkib_home);
  const agent_homes = [...homes.entries()]
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([, value]) => value);
  return { agent_homes, agentkib_home };
}
