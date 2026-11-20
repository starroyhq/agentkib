import {
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { ArrowUp, LoaderCircle, Square } from "lucide-react";
import "./session-composer-input.css";

type Attachments = {
  inputRef: Ref<HTMLInputElement>;
  label: string;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
};

function useEnterSends() {
  const coarsePointer = () =>
    typeof window !== "undefined" ? window.matchMedia?.("(pointer: coarse)") : undefined;
  const [coarse, setCoarse] = useState(() => coarsePointer()?.matches ?? false);
  useEffect(() => {
    const query = coarsePointer();
    if (!query) return;
    const update = () => setCoarse(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return !coarse;
}

function isSendEnter(event: KeyboardEvent<HTMLTextAreaElement>, composing: boolean) {
  return (
    !event.defaultPrevented &&
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !composing &&
    !event.nativeEvent.isComposing &&
    event.nativeEvent.keyCode !== 229
  );
}

export function SessionComposerInput({
  editor,
  editorContextKey,
  onSubmit,
  beforeEditor,
  afterEditor,
  toolbar,
  onEditorKeyDown,
  canSubmitFromKeyboard,
  attachments,
}: {
  editor: Omit<ComponentPropsWithRef<"textarea">, "className" | "rows">;
  editorContextKey?: string;
  onSubmit?: () => void;
  beforeEditor?: ReactNode;
  afterEditor?: ReactNode;
  toolbar: ReactNode;
  onEditorKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>, composing: boolean) => boolean;
  canSubmitFromKeyboard?: () => boolean;
  attachments?: Attachments;
}) {
  const composing = useRef(false);
  useEffect(() => {
    composing.current = false;
  }, [editorContextKey]);
  const enterSends = useEnterSends();
  return (
    <form
      data-slot="session-composer"
      className="relative min-h-30 w-full space-y-2 rounded-3xl border border-border bg-sidebar px-2 pt-2 pb-1 shadow-sm transition-colors focus-within:border-ring/40 md:px-3 md:pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.();
      }}
    >
      {beforeEditor}
      <textarea
        data-slot="textarea"
        className="block field-sizing-content min-h-10 max-h-40 w-full resize-none overflow-y-auto rounded-none border-0 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
        rows={1}
        {...editor}
        onCompositionStart={(event) => {
          composing.current = true;
          editor.onCompositionStart?.(event);
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          editor.onCompositionEnd?.(event);
        }}
        onBlur={(event) => {
          composing.current = false;
          editor.onBlur?.(event);
        }}
        onKeyDown={(event) => {
          editor.onKeyDown?.(event);
          if (event.defaultPrevented || onEditorKeyDown?.(event, composing.current)) return;
          if (!onSubmit || !enterSends || !isSendEnter(event, composing.current)) return;
          event.preventDefault();
          if (!event.repeat && !event.currentTarget.disabled && (canSubmitFromKeyboard?.() ?? true))
            event.currentTarget.form?.requestSubmit();
        }}
        onPaste={(event) => {
          editor.onPaste?.(event);
          if (event.defaultPrevented || !attachments || attachments.disabled) return;
          const files = Array.from(event.clipboardData.files);
          if (!files.length) return;
          event.preventDefault();
          attachments.onFiles(files);
        }}
      />
      {afterEditor}
      {attachments && (
        <input
          ref={attachments.inputRef}
          className="hidden"
          type="file"
          multiple
          aria-label={attachments.label}
          disabled={attachments.disabled}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (files.length && !attachments.disabled) attachments.onFiles(files);
          }}
        />
      )}
      {toolbar}
    </form>
  );
}

export function ComposerToolbar({
  leading,
  trailing,
}: {
  leading: ReactNode;
  trailing: ReactNode;
}) {
  return (
    <div className="@container -mx-1 flex min-w-0 items-center justify-between gap-2 pt-4">
      <div className="flex min-w-0 flex-1 items-center gap-0.5">{leading}</div>
      <div className="ml-auto flex min-w-0 items-center gap-1">{trailing}</div>
    </div>
  );
}

export function ComposerPrimaryAction({
  kind = "send",
  label,
  title = label,
  loading,
  disabled,
  onStop,
}: {
  kind?: "send" | "stop";
  label: string;
  title?: string;
  loading?: boolean;
  disabled?: boolean;
  onStop?: () => void;
}) {
  return (
    <button
      type={kind === "stop" ? "button" : "submit"}
      data-slot="composer-primary-action"
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-white focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 pointer-coarse:size-11"
      aria-label={label}
      aria-busy={loading || undefined}
      title={title}
      disabled={disabled || loading}
      onClick={kind === "stop" ? onStop : undefined}
    >
      {loading ? (
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
      ) : kind === "stop" ? (
        <Square size={16} fill="currentColor" stroke="none" aria-hidden />
      ) : (
        <ArrowUp size={20} aria-hidden />
      )}
    </button>
  );
}
