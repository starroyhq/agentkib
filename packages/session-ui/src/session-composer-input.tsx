import {
  useEffect,
  useLayoutEffect,
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
  scope?: string;
  onFiles: (files: File[]) => void;
};

const attachmentFeedbackMs = 600;

function fileTransfer(data: DataTransfer) {
  return (
    !!data.files?.length ||
    Array.from(data.items ?? []).some((item) => item.kind === "file") ||
    Array.from(data.types ?? []).some((type) =>
      ["files", "application/x-moz-file", "public.file-url", "nsfilenamespboardtype"].includes(
        type.toLowerCase(),
      ),
    )
  );
}

function hasFileReference(data: DataTransfer) {
  if (!data.types?.includes("text/uri-list")) return false;
  const uris = data.getData?.("text/uri-list")?.trim();
  // Some Chromium paste events expose the native file type but hide its URI and File.
  if (!uris) return !data.getData?.("text/plain");
  return uris.split(/\r?\n/).some((line) => /^file:/i.test(line.trim()));
}

function transferredFiles(data: DataTransfer, dropped = false): File[] {
  const files = Array.from(data.files ?? []);
  const items = Array.from(data.items ?? []).filter((item) => item.kind === "file");
  const directories = dropped
    ? new Set(items.filter((item) => item.webkitGetAsEntry?.()?.isDirectory))
    : undefined;
  // Prefer the FileList when it is populated. Use File items when the browser only supplies
  // those, or to remove directory entries without treating empty files as directories.
  if (files.length && !directories?.size) return files;
  return items.flatMap((item) => {
    const file = !directories?.has(item) && item.getAsFile?.();
    return file ? [file] : [];
  });
}

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
  readClipboardFiles,
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
  /** Desktop only: read file objects from the OS clipboard, never an arbitrary renderer path. */
  readClipboardFiles?: () => Promise<File[] | undefined>;
}) {
  const composing = useRef(false);
  useEffect(() => {
    composing.current = false;
  }, [editorContextKey]);
  const enterSends = useEnterSends();
  const [attachmentRejected, setAttachmentRejected] = useState<{ scope?: string }>();
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clipboardRequest = useRef(0);
  const currentAttachments = useRef(attachments);
  const attachmentScope = attachments?.scope ?? editorContextKey;
  useLayoutEffect(() => {
    currentAttachments.current = attachments;
  }, [attachments]);
  useLayoutEffect(() => {
    return () => {
      clipboardRequest.current++;
    };
  }, [attachmentScope]);
  useEffect(() => () => clearTimeout(feedbackTimer.current), []);

  function rejectAttachment() {
    clearTimeout(feedbackTimer.current);
    setAttachmentRejected({ scope: attachmentScope });
    feedbackTimer.current = setTimeout(
      () => setAttachmentRejected(undefined),
      attachmentFeedbackMs,
    );
  }

  function offerFiles(files: File[]) {
    const target = currentAttachments.current;
    if (!target || target.disabled || !files.length) rejectAttachment();
    else target.onFiles(files);
  }

  return (
    <form
      data-slot="session-composer"
      data-attachment-rejected={
        attachmentRejected && attachmentRejected.scope === attachmentScope ? "" : undefined
      }
      className="relative min-h-30 w-full space-y-2 rounded-3xl border border-border bg-sidebar px-2 pt-2 pb-1 shadow-sm transition-colors focus-within:border-ring/40 md:px-3 md:pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.();
      }}
      onDragOver={(event) => {
        if (!fileTransfer(event.dataTransfer)) return;
        event.preventDefault();
        // Receive the drop so an unavailable attachment can be acknowledged without navigating.
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        if (!fileTransfer(event.dataTransfer) && !hasFileReference(event.dataTransfer)) return;
        event.preventDefault();
        offerFiles(transferredFiles(event.dataTransfer, true));
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
          if (event.defaultPrevented) return;
          const data = event.clipboardData;
          const files = transferredFiles(data);
          const hasFiles = files.length > 0 || fileTransfer(data) || hasFileReference(data);
          const emptyBrowserClipboard = !data.types?.length && !data.getData?.("text/plain");
          if (!hasFiles && !(readClipboardFiles && emptyBrowserClipboard)) return;

          event.preventDefault();
          if (!attachments || attachments.disabled || files.length || !readClipboardFiles) {
            offerFiles(files);
            return;
          }
          const request = ++clipboardRequest.current;
          void readClipboardFiles()
            .then((nativeFiles) => {
              if (request !== clipboardRequest.current) return;
              if (nativeFiles !== undefined || hasFiles) offerFiles(nativeFiles ?? []);
            })
            .catch(() => {
              if (request === clipboardRequest.current) rejectAttachment();
            });
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
  showDisabledTitle = false,
  loading,
  disabled,
  onStop,
}: {
  kind?: "send" | "stop";
  label: string;
  title?: string;
  showDisabledTitle?: boolean;
  loading?: boolean;
  disabled?: boolean;
  onStop?: () => void;
}) {
  // A disabled button needs pointer hit testing for its native title to appear on hover.
  const disabledPointerClass = showDisabledTitle ? "" : " disabled:pointer-events-none";
  return (
    <button
      type={kind === "stop" ? "button" : "submit"}
      data-slot="composer-primary-action"
      className={`inline-flex size-8 shrink-0 items-center justify-center rounded-full text-white focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 pointer-coarse:size-11${disabledPointerClass}`}
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
