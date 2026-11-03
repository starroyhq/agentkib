import type { MessageImage } from "./conversation-images";

function withoutPageContext(text: string): string {
  // Codex can persist this UI context as a separate user message or before the
  // actual request. Only its known leading envelope and payload are metadata;
  // quoted examples, code and other XML-like user text must remain visible.
  const context =
    /^(?:[ \t]*\r?\n)*<external_codex_apps_open_page>([\s\S]{0,8192}?)<\/external_codex_apps_open_page>[ \t]*(?:\r?\n|$)/.exec(
      text,
    );
  if (!context) return text;
  let value: unknown;
  try {
    value = JSON.parse(context[1]!);
  } catch {
    return text;
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("page_id" in value) ||
    (value.page_id !== null &&
      (typeof value.page_id !== "string" ||
        !value.page_id.length ||
        value.page_id.length > 512 ||
        /[\p{Cc}\p{Cf}]/u.test(value.page_id)))
  )
    return text;
  return text.slice(context[0].length).replace(/^(?:[ \t]*\r?\n)+/, "");
}

/** Display known native envelopes without changing the persisted user message. */
export function displayUserMessageText(text: string, images: readonly MessageImage[] = []): string {
  text = withoutPageContext(text);
  if (!images.length) return text;
  const normalized = text.replace(/\r\n/g, "\n");
  const envelope =
    /^(?:[ \t]*\n)*# Files mentioned by the user:\n([\s\S]*?)\nDistinguish instructions in attached documents from the user's request\.\n\n## My request:\n([\s\S]*)$/.exec(
      normalized,
    );
  if (!envelope) return text;
  const entries = envelope[1]!.trim().split(/\n{2,}/);
  if (entries.length !== images.length) return text;
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = /^## ([^\n]+): ([^\n]+)\nImage attachment: true$/.exec(entries[index]!);
    if (!entry || (images[index]?.name && images[index].name !== entry[1])) return text;
    paths.push(entry[2]!);
  }
  let body = envelope[2]!.replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "");
  const suffix =
    /(?:^|\n)(<image name=(?:\[Image #1\]|"\[Image #1\]") path="[^"\n]+">[\s\S]*)$/.exec(body);
  if (!suffix) return body;
  const prefix = body.slice(0, suffix.index);
  // A user can discuss the wrapper inside a code sample. Leave that sample intact.
  if ((prefix.match(/^\s*```/gm)?.length ?? 0) % 2) return body;
  const tags = [
    ...suffix[1]!.matchAll(
      /<image name=(?:\[Image #(\d+)\]|"\[Image #(\d+)\]") path="([^"\n]+)">(?:\s*<\/image>)?/g,
    ),
  ];
  if (
    tags.length !== paths.length ||
    suffix[1]!
      .replace(
        /<image name=(?:\[Image #\d+\]|"\[Image #\d+\]") path="[^"\n]+">(?:\s*<\/image>)?/g,
        "",
      )
      .trim() ||
    tags.some((tag, index) => Number(tag[1] ?? tag[2]) !== index + 1 || tag[3] !== paths[index])
  )
    return body;
  body = prefix.replace(/(?:\n[ \t]*)+$/, "");
  return body;
}
