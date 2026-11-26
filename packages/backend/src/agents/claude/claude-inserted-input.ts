/** Reads the user's input from an attachment delivered to the running turn. */
export function claudeInsertedInput(attachment?: {
  type?: unknown;
  plugin?: unknown;
  content?: unknown;
  prompt?: unknown;
  origin?: { kind?: unknown };
  commandMode?: unknown;
  hostsOwnTurn?: unknown;
  isMeta?: unknown;
  promptRewritten?: unknown;
  verifiedSlackHumanTurn?: unknown;
}): unknown {
  // Newer CLIs persist $.session.append as a plugin note, with held text outside content.
  if (attachment?.type === "plugin_note") {
    if (
      attachment.plugin === "agentkib-bridge" &&
      Array.isArray(attachment.content) &&
      attachment.content.every((part) => typeof part === "string")
    )
      return attachment.content.join("\n");
    return;
  }
  if (attachment?.type !== "queued_command") return;
  if (attachment.origin?.kind === "human") return attachment.prompt;
  // The CLI's managed SDK input can omit origin. Claude itself recognizes the
  // originless hostsOwnTurn flag; require a prompt and exclude internal rewrites.
  if (
    attachment.origin === undefined &&
    attachment.commandMode === "prompt" &&
    attachment.hostsOwnTurn === true &&
    attachment.isMeta !== true &&
    attachment.promptRewritten !== true &&
    attachment.verifiedSlackHumanTurn !== true
  )
    return attachment.prompt;
}
