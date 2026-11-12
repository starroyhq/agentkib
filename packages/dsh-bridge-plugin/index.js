// AgentKib connection for DeepSeek Harness. Install it into the profile you run, then restart DSH.
// AgentKib also mounts it by itself, with a `managed` config, into a DSH it starts in the
// background; that DSH reports only to that AgentKib and exits with it.
import { createBridge } from "./bridge.js";

export const name = "agentkib-dsh-bridge";
// Session control also needs `sessionController` (web and desktop profiles); without it the
// plugin still reports sessions and history, and AgentKib shows them read-only.
export const inject = ["agents", "sessionQuery"];

export function apply(ctx, config) {
  const bridge = createBridge(ctx, { managed: config?.managed });
  ctx.effect(() => () => bridge.close(), "agentkib-dsh-bridge connection");
}
