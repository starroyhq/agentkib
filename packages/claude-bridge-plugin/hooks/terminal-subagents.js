// Only the native description can become a title. Paths, command syntax and
// opaque IDs or credentials in that free-form description get the empty label.
const TITLE_TEXT = /^[\p{L}\p{M}\p{N} ,!?，。！？、'’-]+$/u;
const COMMAND =
  /^(?:cd|sudo|env|sh|zsh|bash|fish|git|npm|pnpm|npx|yarn|bun|node|python[23]?|pip[23]?|curl|wget|ssh|scp|docker|kubectl|ls|cat|rm|mv|cp|echo|printf|find|make|chmod|sleep|awk|sed|grep|rg|security|ps|touch|open|whoami|id|pwd|export|unset|head|tail|less|sort|cut)(?: |$)/i;
const OPTION = /(?:^| )-+[\p{L}\p{N}]/u;
const OPAQUE =
  /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\b(?=[a-z0-9]*\d)[a-z0-9]{12,}\b|(?:^| )(?:(?:sk|ghp|gho|xox[baprs])-[a-z0-9-]+|bearer +[a-z0-9-]+)/i;

export function safeTerminalSubagentTitle(value) {
  if (typeof value !== "string" || value.length > 120) return "";
  const title = value.trim();
  const normalized = title
    .normalize("NFKC")
    .replace(/['’]/g, "")
    .trim();
  return TITLE_TEXT.test(title) &&
    TITLE_TEXT.test(normalized) &&
    !COMMAND.test(normalized) &&
    !OPTION.test(normalized) &&
    !OPAQUE.test(normalized)
    ? title
    : "";
}
