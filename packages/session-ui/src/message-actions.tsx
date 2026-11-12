import { useEffect, useMemo, useRef, useState } from "react";

const copy = {
  "zh-CN": {
    copy: "复制正文",
    copied: "已复制",
    failed: "复制失败，请选中文字后复制",
    time: "发送时间",
  },
  "zh-TW": {
    copy: "複製正文",
    copied: "已複製",
    failed: "複製失敗，請選取文字後複製",
    time: "傳送時間",
  },
  "en-US": {
    copy: "Copy message",
    copied: "Copied",
    failed: "Could not copy. Select the text to copy it.",
    time: "Message time",
  },
  "ja-JP": {
    copy: "本文をコピー",
    copied: "コピーしました",
    failed: "コピーできませんでした。本文を選択してコピーしてください。",
    time: "送信時刻",
  },
};

type MessageActionEvent = {
  kind: string;
  message_phase?: string | null;
  cli_output?: boolean;
};

type MessageSegment = {
  kind: "event" | "process";
  events: readonly MessageActionEvent[];
};

const revealOnInteraction =
  "opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none";
const revealUserActions = `${revealOnInteraction} pointer-events-none group-hover/message:pointer-events-auto group-focus-within/message:pointer-events-auto pointer-coarse:pointer-events-auto`;

/** Group the adjacent parts of a final reply without absorbing preceding activity. */
export function messageActionGroups<S extends MessageSegment>(segments: readonly S[]) {
  const groups: Array<
    { kind: "message"; events: S["events"][number][] } | { kind: "process"; segment: S }
  > = [];
  let reply: S["events"][number][] | undefined;
  for (const segment of segments) {
    if (segment.kind === "process") {
      groups.push({ kind: "process", segment });
      reply = undefined;
      continue;
    }
    for (const event of segment.events) {
      if (
        event.kind === "agent-message" &&
        event.message_phase === "final_answer" &&
        !event.cli_output
      ) {
        if (!reply) {
          reply = [];
          groups.push({ kind: "message", events: reply });
        }
        reply.push(event);
      } else {
        reply = undefined;
        groups.push({ kind: "message", events: [event] });
      }
    }
  }
  return groups;
}

export function MessageActions({
  locale,
  text,
  timestamp,
  timestampLabel,
  align = "start",
  role = "user",
}: {
  locale: string;
  text?: string;
  timestamp?: string | null;
  timestampLabel?: string;
  align?: "start" | "end";
  role?: "user" | "assistant";
}) {
  const words = copy[locale as keyof typeof copy] ?? copy["en-US"];
  const [feedback, setFeedback] = useState<"copied" | "failed">();
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const attempt = useRef(0);
  useEffect(
    () => () => {
      attempt.current++;
      clearTimeout(timeout.current);
    },
    [],
  );

  const time = useMemo(() => {
    if (!timestamp) return;
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return;
    return {
      full: date.toLocaleString(locale),
      short: date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" }),
    };
  }, [timestamp, locale]);
  const hasText = !!text?.trim();
  if (!time && !hasText) return null;

  async function copyMessage() {
    if (!text) return;
    const request = ++attempt.current;
    clearTimeout(timeout.current);
    setFeedback(undefined);
    let result: "copied" | "failed";
    try {
      await navigator.clipboard.writeText(text);
      result = "copied";
    } catch {
      result = "failed";
    }
    if (request !== attempt.current) return;
    setFeedback(result);
    timeout.current = setTimeout(() => setFeedback(undefined), result === "copied" ? 1600 : 4000);
  }

  const label = feedback ? words[feedback] : words.copy;
  const isAssistant = role === "assistant";
  const clock = time && (
    <time
      dateTime={timestamp!}
      title={time.full}
      aria-label={`${timestampLabel ?? words.time}: ${time.full}`}
      tabIndex={hasText ? undefined : 0}
      className={`whitespace-nowrap focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring ${isAssistant ? revealOnInteraction : ""}`}
    >
      {time.short}
    </time>
  );
  return (
    <footer
      data-message-actions
      className={`mt-1 flex h-6 w-fit max-w-full items-center gap-1.5 text-xs text-muted-foreground ${isAssistant ? "" : revealUserActions} ${align === "end" ? "ml-auto" : ""}`}
    >
      {!isAssistant && clock}
      {hasText && (
        <div className="relative flex">
          <button
            type="button"
            aria-label={words.copy}
            title={label}
            className="grid size-6 place-items-center rounded-md hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-w-8"
            onClick={() => void copyMessage()}
          >
            <svg
              aria-hidden="true"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {feedback === "copied" ? (
                <path d="m5 12 4 4L19 6" />
              ) : (
                <>
                  <rect x="8" y="8" width="12" height="12" rx="2" />
                  <path d="M16 4H6a2 2 0 0 0-2 2v10" />
                </>
              )}
            </svg>
          </button>
          <span
            role="status"
            className={
              feedback === "failed"
                ? `absolute bottom-full z-10 mb-1 w-max max-w-52 rounded-md border border-border bg-popover px-2 py-1 text-popover-foreground shadow-sm ${align === "end" ? "right-0" : "left-0"}`
                : "sr-only"
            }
          >
            {feedback ? label : ""}
          </span>
        </div>
      )}
      {isAssistant && clock}
    </footer>
  );
}
