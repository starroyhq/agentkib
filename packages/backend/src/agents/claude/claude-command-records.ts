/**
 * How Claude Code records a slash command (CLI 2.1.311, checked against the local API stub):
 *
 * - The invocation is a user row made only of `<command-name>/name</command-name>`,
 *   `<command-message>name</command-message>` and `<command-args>…</command-args>`, in either
 *   order. A command the CLI does not offer in print mode (`/help`) is a `system/local_command`
 *   row holding the typed text instead.
 * - A local command's output is a `system/local_command` row, or for `/compact` a user row, made
 *   only of `<local-command-stdout>` or `<local-command-stderr>`. The live assistant frame for it
 *   has the same uuid.
 * - Rows marked `isMeta` (the caveat before a local command, a skill's expanded prompt) are the
 *   CLI's own context, not something the user wrote.
 * - When a background command, a Monitor or a background agent ends, or a Monitor reports an
 *   event, and the CLI starts a turn of its own for it, the notice it gives the model is a user row
 *   with `origin.kind: "task-notification"` (CLI 2.1.263 to 2.1.323, with the stdio protocol and in
 *   the terminal): `<task-notification>` holding a `<summary>`, and for a Monitor event an
 *   `<event>`. The person did not write it either.
 *
 * Text that only quotes these tags, or mixes them with other text, is an ordinary message.
 */
const TAG = /<(command-name|command-message|command-args)>([\s\S]*?)<\/\1>/g;
const OUTPUT = /<(local-command-stdout|local-command-stderr)>([\s\S]*?)<\/\1>/g;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function sections(text: string, pattern: RegExp): Array<[string, string]> | null {
  const found: Array<[string, string]> = [];
  const rest = text.replace(pattern, (_match, name: string, body: string) => {
    found.push([name, body]);
    return "";
  });
  return found.length && !rest.trim() ? found : null;
}

/** `/name args` for a recorded invocation, or null when the text is not one. */
export function claudeCommandInvocation(text: string): string | null {
  const tags = sections(text, TAG);
  const name = tags?.find(([tag]) => tag === "command-name")?.[1].trim();
  if (!name || /\s/.test(name)) return null;
  const args = tags!.find(([tag]) => tag === "command-args")?.[1].trim() ?? "";
  const command = name.startsWith("/") ? name : `/${name}`;
  return args ? `${command} ${args}` : command;
}

/** A local command's output, or null when the text is not one. Empty output is "". */
export function claudeCommandOutput(text: string): string | null {
  const outputs = sections(text, OUTPUT);
  return outputs
    ? outputs
        .map(([, body]) => body.replace(ANSI, "").trim())
        .filter(Boolean)
        .join("\n")
    : null;
}

/** The text a `system/local_command` row holds: its `content`, or a message like other rows. */
export function claudeLocalCommandText(row: { content?: unknown; message?: unknown }): string {
  if (typeof row.content === "string") return row.content;
  const content = (row.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("\n")
    : "";
}

const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const SUMMARY = /<summary>([\s\S]*?)<\/summary>/;
const EVENT = /<event>([\s\S]*?)<\/event>/;
const MAX_EVENT = 400;

/**
 * The line to show for a background task's notification row, or null when the row is not one.
 * A row without `origin` counts only when its whole text is notifications, so a message that
 * quotes the tag stays the person's.
 */
export function claudeTaskNotification(row: {
  type?: unknown;
  origin?: unknown;
  message?: unknown;
}): string | null {
  if (row.type !== "user" || !row.message) return null;
  const origin = row.origin;
  const marked =
    !!origin &&
    typeof origin === "object" &&
    (origin as { kind?: unknown }).kind === "task-notification";
  if (origin !== undefined && !marked) return null;
  const text = claudeLocalCommandText(row);
  const lines: string[] = [];
  const rest = text.replace(NOTIFICATION, (_match, body: string) => {
    const summary = SUMMARY.exec(body)?.[1]?.replace(ANSI, "").trim();
    const event = EVENT.exec(body)?.[1]?.replace(ANSI, "").trim();
    const line = [summary, event && [...event].slice(0, MAX_EVENT).join("")]
      .filter(Boolean)
      .join("\n");
    if (line) lines.push(line);
    return "";
  });
  if (!marked && (!lines.length || rest.trim())) return null;
  // A notice the CLI wrote in a form not known here is still not the person's message.
  return lines.length
    ? lines.join("\n")
    : rest
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
