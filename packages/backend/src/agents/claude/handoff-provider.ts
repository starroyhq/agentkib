import path from "node:path";
import { resolveCommand } from "../../command-resolution";
import { userHome } from "../../mcp-config-read";
import { handoffFileBootstrap, type HandoffProvider } from "../../sessions/handoff-provider";
import {
  assertClaudeConfigWritable,
  claudeConfigFiles,
  resolveClaudeConfig,
} from "./claude-config";
import { verifyClaudeTranscript } from "./claude-native-verify";
import { claudeProjectKey } from "./claude-project-path";

export const claudeHandoffProvider = {
  terminal: {
    cliName: "claude",
    executable: (env) => resolveCommand("claude", env),
    fileArguments: (filename) => ["--append-system-prompt", handoffFileBootstrap(filename)],
    native: {
      arguments: (sessionId) => ["--resume", sessionId],
      root(env) {
        const claude = resolveClaudeConfig(env, userHome(env));
        assertClaudeConfigWritable(claude);
        return claudeConfigFiles(claude).projects;
      },
      readback: {
        kind: "text",
        expectation(root, workspace, sessionId, env) {
          const key = claudeProjectKey(workspace, env);
          if (!key.ok)
            throw new Error(
              "Claude session read-back failed: project directory cannot be determined",
            );
          return { sessionId, workspace, directory: path.join(root, key.key) };
        },
        verify(file, content, expected) {
          // Fails closed: without the launch's expectation the round trip cannot be judged.
          if (!expected) throw new Error("Claude session read-back failed: expectation is missing");
          verifyClaudeTranscript(file, content, expected);
        },
      },
    },
  },
} satisfies HandoffProvider;
