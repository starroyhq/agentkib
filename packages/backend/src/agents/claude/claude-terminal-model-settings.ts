import { claudeModelDisplayName } from "@agentkib/runtime-protocol";

/** Project the native ID alongside the model name clients display. */
export function claudeTerminalModelSettings(model: string | null) {
  return {
    ...(model ? { selected: { model }, applicationStatus: "confirmed" as const } : {}),
    models: model ? [{ id: model, name: claudeModelDisplayName(model) ?? model, efforts: [] }] : [],
  };
}
