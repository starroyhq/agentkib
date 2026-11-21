import path from "node:path";
import { resolveCommand } from "../../command-resolution";
import { userHome } from "../../mcp-config-read";
import { handoffFileBootstrap, type HandoffProvider } from "../../sessions/handoff-provider";

export const codexHandoffProvider = {
  terminal: {
    cliName: "codex",
    executable: (env) => resolveCommand("codex", env),
    fileArguments: (filename) => [
      "-c",
      `developer_instructions='${handoffFileBootstrap(filename)}'`,
    ],
    native: {
      arguments: (sessionId, workspace) => ["resume", sessionId, "-C", workspace],
      root(env) {
        const home = userHome(env);
        return path.join(env.CODEX_HOME ?? path.join(home, ".codex"), "sessions");
      },
      readback: {
        kind: "jsonl",
        verify(records) {
          const payload = records[0]!.payload;
          if (
            records[0]!.type !== "session_meta" ||
            !payload ||
            typeof payload !== "object" ||
            typeof (payload as Record<string, unknown>).id !== "string"
          )
            throw new Error("Codex session metadata is invalid");
        },
      },
    },
  },
} satisfies HandoffProvider;
