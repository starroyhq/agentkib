import { renderCodexCommandPrompt } from "./agents/codex/command-prompts";

export { renderCodexCommandPrompt as commandPrompt };
export type CommandPromptRequest = Parameters<typeof renderCodexCommandPrompt>[1];
