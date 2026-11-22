import { sessionConnectionPanels } from "@agentkib/session-ui";
import { sessionProviderDeclaration } from "@agentkib/web-client";
import { expect, it } from "vitest";
import { webSessionPlatform } from "../conversation/session-platform";

it.each(["claude-code", "deepseek-harness"] as const)(
  "does not register desktop connection settings for %s on Web",
  (agent) => {
    const connection = sessionProviderDeclaration(agent)?.connection;
    expect(connection).toBeDefined();
    expect(sessionConnectionPanels(connection?.kind, webSessionPlatform)).toBeUndefined();
  },
);
