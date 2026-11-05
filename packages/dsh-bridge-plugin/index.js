// AgentKib connection for DeepSeek Harness. Install it into the profile you run, then restart DSH.
import { createBridge } from "./bridge.js";

export const name = "agentkib-dsh-bridge";
// Session control also needs `sessionController` (web and desktop profiles); without it the
// plugin still reports sessions and history, and AgentKib shows them read-only.
export const inject = ["agents", "sessionQuery"];

export function apply(ctx) {
  const bridge = createBridge(ctx);
  ctx.effect(() => () => bridge.close(), "agentkib-dsh-bridge connection");
}
