import type { ApprovalDockItem } from "./interaction-card";
import {
  interactionCardCopy,
  type ApprovalChoice,
  type InteractionLocale,
} from "./interaction-model";

/** How many lines of a command or a file list the compact card shows. */
const BLOCK_LINES = 3;

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-0";

export interface CompactApprovalProps {
  locale: InteractionLocale;
  /** The request as the session view's card shows it (`sessionInteractionItems`). */
  item: ApprovalDockItem;
  busy: boolean;
  /** Why the host refused the last decision sent from this card. */
  failure?: string;
  /** Resolves to `true` once the host accepted the decision. */
  onChoose: (choice: ApprovalChoice) => unknown;
  /** Opens the session, where the full card offers every option. */
  onMore: () => void;
}

/**
 * The approval card made small for the menu bar: what the Agent asks, the command or files, and
 * the one-click answers "allow once" and "deny". Every other option, a form or a question is
 * answered on the full card, which "More options" opens in the session.
 */
export function CompactApprovalCard({
  locale,
  item,
  busy,
  failure,
  onChoose,
  onMore,
}: CompactApprovalProps) {
  const t = interactionCardCopy(locale);
  const { model, notice } = item;
  const allow = model.choices.find((choice) => choice.quick === "allow");
  // Some requests can only be denied by stopping the turn; the card then offers that.
  const deny =
    model.choices.find((choice) => choice.quick === "deny") ??
    model.choices.find((choice) => choice.quick === "stop");
  const lines = model.block?.lines ?? [];
  const shown = lines.slice(0, BLOCK_LINES);
  const usable = (choice: ApprovalChoice | undefined): choice is ApprovalChoice =>
    !!choice && !choice.disabled;
  const disabled = !item.enabled || busy;
  return (
    <div className="grid gap-2.5" aria-busy={busy || undefined}>
      <p className="text-sm font-semibold leading-5">{model.title}</p>
      {shown.length > 0 && (
        <div
          aria-label={model.block?.label}
          className="grid gap-0.5 rounded-lg bg-muted/70 px-3 py-2 font-mono text-[12.5px] leading-5"
        >
          {shown.map((line, index) => (
            <p key={index} className="line-clamp-2 whitespace-pre-wrap break-all">
              {line}
            </p>
          ))}
          {lines.length > shown.length && (
            <p className="font-sans text-xs text-muted-foreground">
              {model.icon === "files"
                ? t.moreFiles.replace("{count}", String(lines.length - shown.length))
                : "…"}
            </p>
          )}
        </div>
      )}
      {model.message && (
        <p className="line-clamp-3 whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {model.message}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs leading-5 text-muted-foreground">
          {notice.text}
        </p>
      )}
      {failure && (
        <p role="alert" className="text-xs leading-5 text-destructive-text">
          {failure}
        </p>
      )}
      <div className="flex items-center gap-2">
        {usable(allow) && (
          <button
            type="button"
            disabled={disabled}
            className={`inline-flex h-8 items-center rounded-full bg-primary px-3.5 font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:bg-muted disabled:text-muted-foreground ${focusRing}`}
            onClick={() => void onChoose(allow)}
          >
            <span className="text-[13px]">{allow.label}</span>
          </button>
        )}
        {usable(deny) && (
          <button
            type="button"
            disabled={disabled}
            className={`inline-flex h-8 items-center rounded-full border border-border bg-background px-3.5 font-medium transition-colors hover:bg-muted disabled:text-muted-foreground disabled:hover:bg-background ${focusRing}`}
            onClick={() => void onChoose(deny)}
          >
            <span className="text-[13px]">{deny.label}</span>
          </button>
        )}
        <button
          type="button"
          className={`ml-auto rounded-md px-1 font-medium text-primary-text underline-offset-4 hover:underline ${focusRing}`}
          onClick={onMore}
        >
          <span className="text-[13px]">{t.moreOptions}</span>
        </button>
      </div>
    </div>
  );
}
