import { useRef, type ReactNode } from "react";
import type { Access, Live } from "@agentkib/web-client";
import { composerAddCopy } from "./composer-add-menu";
import type { ComposerModelLocale } from "./composer-model-copy";
import { ComposerPrimaryAction, SessionComposerInput } from "./session-composer-input";
import { SessionComposerToolbar } from "./session-composer-toolbar";
import { DEVIN_TURN_REASONS } from "./devin-terminal";

export function BasicSessionComposer({
  sessionId,
  locale,
  labels,
  value,
  busy,
  canSend,
  canStop,
  maxLength,
  onChange,
  onSend,
  onStop,
  references,
  contextUsage,
  afterToolbar,
}: {
  sessionId: string;
  locale: ComposerModelLocale;
  labels: {
    message: string;
    addContext: string;
    send: string;
    stop: string;
    experimental: string;
    controlInfo: string;
  };
  value: string;
  busy: boolean;
  canSend: boolean;
  canStop: boolean;
  maxLength: number;
  onChange: (value: string) => void;
  onSend: () => Promise<unknown>;
  onStop: () => void;
  references: ReactNode;
  contextUsage: ReactNode;
  afterToolbar?: ReactNode;
}) {
  const submitting = useRef(false);
  const addCopy = composerAddCopy(locale);
  return (
    <div className="w-full max-w-3xl shrink-0 self-center">
      <SessionComposerInput
        editorContextKey={sessionId}
        editor={{
          id: "message",
          "aria-label": labels.message,
          value,
          maxLength,
          onChange: (event) => onChange(event.currentTarget.value),
          placeholder: labels.message,
          disabled: busy,
        }}
        onSubmit={() => {
          if (!canSend || submitting.current) return;
          submitting.current = true;
          void onSend().finally(() => {
            submitting.current = false;
          });
        }}
        canSubmitFromKeyboard={() => canSend && !submitting.current}
        beforeEditor={references}
        toolbar={
          <>
            <SessionComposerToolbar
              locale={locale}
              add={{
                label: labels.addContext,
                disabled: true,
                disabledReason: addCopy.unavailable,
              }}
              leadingStatus={
                <small className="max-w-lg text-xs leading-5 text-muted-foreground">
                  {labels.experimental} · {labels.controlInfo}
                </small>
              }
              usage={contextUsage}
              action={
                <ComposerPrimaryAction
                  label={canStop ? labels.stop : labels.send}
                  kind={canStop ? "stop" : "send"}
                  disabled={!canStop && !canSend}
                  onStop={onStop}
                />
              }
            />
            {afterToolbar}
          </>
        }
      />
    </div>
  );
}

export function SessionDetailComposerNotices({
  agent,
  accessMode,
  banner,
  background,
  interactions,
  live,
  notice,
  noticeSource,
  noticeReason,
  noticeText,
  hasSeparateBanner,
}: {
  agent?: string;
  accessMode?: NonNullable<Access["device"]>["accessMode"];
  banner?: ReactNode;
  background?: ReactNode;
  interactions: ReactNode;
  live?: Pick<Live, "approvals" | "questions">;
  notice?: string;
  noticeSource?: string;
  noticeReason?: string;
  noticeText?: string;
  hasSeparateBanner: boolean;
}) {
  const handledByInteraction =
    (noticeSource === "approve" || noticeSource === "answer") &&
    !!(live?.approvals.length || live?.questions?.length);
  const handledBySettings =
    notice === "notDispatched" &&
    ((agent === "codex" &&
      (noticeReason === "unsupported-model" || noticeReason === "unsupported-effort")) ||
      (agent === "claude-code" &&
        accessMode === "full" &&
        (noticeReason === "claude-model-unsupported" ||
          noticeReason === "claude-effort-unsupported")) ||
      (agent === "devin" && DEVIN_TURN_REASONS.includes(noticeReason ?? "")));
  const handledByBanner = hasSeparateBanner && notice === "uncertain";
  const showNotice =
    notice &&
    notice !== "accepted" &&
    !handledByInteraction &&
    !handledBySettings &&
    !handledByBanner;
  const bannerClass = "mx-auto w-full max-w-3xl px-3 text-xs leading-5 text-muted-foreground";
  return (
    <>
      {banner && (
        <p role="status" className={bannerClass}>
          {banner}
        </p>
      )}
      {background && (
        <p role="status" className={bannerClass}>
          {background}
        </p>
      )}
      {interactions}
      {showNotice && (
        <p
          role="status"
          className="mx-auto w-full max-w-3xl px-5 py-2 text-xs leading-6 text-muted-foreground"
        >
          {noticeText}
        </p>
      )}
    </>
  );
}

export function SessionDetailReadOnlyFooter({
  contextUsage,
  message,
}: {
  contextUsage?: ReactNode;
  message: string;
}) {
  return (
    <footer className="shrink-0 border-t px-5 py-4 text-center text-xs text-muted-foreground">
      {contextUsage && <div className="flex justify-center">{contextUsage}</div>}
      {message}
    </footer>
  );
}
