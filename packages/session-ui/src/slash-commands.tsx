import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { legacyCommandMenuCopy, type SlashCommandOption } from "./agents/session-commands";

export type { SlashCommandOption } from "./agents/session-commands";

/** The name typed so far while the draft is only `/` and a name, else null. */
export function slashCommandQuery(draft: string): string | null {
  const match = /^\/([A-Za-z0-9_:.-]*)$/.exec(draft);
  return match ? match[1]!.toLowerCase() : null;
}

function slashSuffixQuery(draft: string, name: string): string | null {
  const match = /\s\/([A-Za-z]+)$/.exec(draft);
  const typed = match?.[1]?.toLowerCase();
  return typed && name.startsWith(typed) ? typed : null;
}

/** The start of `/plan` typed after a space. At the start of a draft the whole menu answers. */
export function slashPlanQuery(draft: string): string | null {
  return slashSuffixQuery(draft, "plan");
}

export function stripSlashPlan(draft: string): string {
  return draft.replace(/\s*\/[A-Za-z]*$/, "");
}

/** Names that start with the query, then aliases that do, then names that contain it. */
export function matchSlashCommands(
  options: readonly SlashCommandOption[],
  query: string,
): SlashCommandOption[] {
  if (!query) return [...options];
  const starts = (value: string) => value.toLowerCase().startsWith(query);
  const byName = options.filter((option) => starts(option.name));
  const byAlias = options.filter((option) => !starts(option.name) && option.aliases.some(starts));
  const inside = options.filter(
    (option) =>
      !starts(option.name) &&
      !option.aliases.some(starts) &&
      option.name.toLowerCase().includes(query),
  );
  return [...byName, ...byAlias, ...inside];
}

/**
 * A slash menu backed by the composer's registered options. The textarea retains focus
 * and identifies the active menu item through aria-activedescendant.
 */
export function useSlashCommandMenu({
  value,
  options,
  enabled,
  label,
  copy: commandCopy,
  locale = "en-US",
  catalogKnown = true,
  side = "top",
  plan,
  onChoose,
}: {
  value: string;
  options: readonly SlashCommandOption[];
  /** Whether the composer can open its command menu. */
  enabled: boolean;
  label?: string;
  /** The accessible name and a caller-provided explanation when no options match. */
  copy?: { label: string; empty?: string };
  /** Legacy callers use the default command copy for this locale. */
  locale?: string;
  /** Legacy callers pass false while their command catalog is unverified. */
  catalogKnown?: boolean;
  /** Which edge of the composer anchors the menu. */
  side?: "top" | "bottom";
  /**
   * A Plan shortcut can also match a draft suffix. If enter succeeds, remove the shortcut
   * from the draft. Otherwise the menu completes the command as text.
   */
  plan?: {
    option: SlashCommandOption;
    query?: (text: string) => string | null;
    strip?: (text: string) => string;
    enter: () => boolean;
  };
  /** Receives the draft with the chosen command, followed by a space. */
  onChoose: (text: string) => void;
}) {
  const id = useId();
  const listboxId = `${id}commands`;
  const copy = commandCopy ?? legacyCommandMenuCopy(locale);
  const empty = commandCopy || !catalogKnown ? copy.empty : undefined;
  const list = useRef<HTMLUListElement>(null);
  // Escape closes the menu for this exact draft; typing reopens it.
  const [dismissed, setDismissed] = useState<string>();
  const [cursor, setCursor] = useState({ query: "", index: 0 });
  const fullQuery = enabled ? slashCommandQuery(value) : null;
  const planOption = plan?.option;
  const planName = planOption?.name.toLowerCase();
  const planQuery =
    enabled && plan && planName && fullQuery === null
      ? plan.query
        ? plan.query(value)
        : slashSuffixQuery(value, planName)
      : null;
  const query = fullQuery ?? planQuery;
  const matches = useMemo(
    () =>
      fullQuery !== null
        ? matchSlashCommands(
            planOption && !options.some((option) => option.name.toLowerCase() === planName)
              ? [planOption, ...options]
              : options,
            fullQuery,
          )
        : planQuery !== null && planOption
          ? [planOption]
          : [],
    [options, fullQuery, planQuery, planOption, planName],
  );
  const emptyShown = fullQuery !== null && !!empty;
  const open = query !== null && dismissed !== value && (matches.length > 0 || emptyShown);
  const listOpen = open && matches.length > 0;
  const selectable = matches.flatMap((option, position) =>
    option.disabledReason === undefined ? [position] : [],
  );
  const cursorIndex = cursor.query === query ? Math.min(cursor.index, matches.length - 1) : 0;
  const index = selectable.includes(cursorIndex) ? cursorIndex : (selectable[0] ?? -1);
  useEffect(() => {
    if (!listOpen || index < 0) return;
    const element = list.current?.children[index] as HTMLElement | undefined;
    element?.scrollIntoView?.({ block: "nearest" });
  }, [listOpen, index]);

  const choose = (option: SlashCommandOption) => {
    if (option.disabledReason !== undefined) return;
    if (plan && option.name.toLowerCase() === planName && plan.enter())
      onChoose((plan.strip ?? stripSlashPlan)(value));
    else onChoose(`/${option.name} `);
  };

  /** Handles the key when the menu uses it; returns whether it did. */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>, composing: boolean): boolean => {
    if (composing || event.nativeEvent.isComposing) return false;
    if (open && event.key === "Escape") {
      event.preventDefault();
      setDismissed(value);
      return true;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;

    if (event.key === "Enter" && fullQuery !== null) {
      // A complete unavailable command must not fall through to form submission,
      // including when the user moved the cursor or dismissed the menu.
      const exact =
        matches.find((option) => option.name.toLowerCase() === fullQuery) ??
        matches.find((option) => option.aliases.some((alias) => alias.toLowerCase() === fullQuery));
      if (exact?.disabledReason !== undefined) {
        event.preventDefault();
        return true;
      }
    }

    if (!listOpen) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (selectable.length) {
        const step = event.key === "ArrowDown" ? 1 : -1;
        const position = (selectable.indexOf(index) + step + selectable.length) % selectable.length;
        setCursor({ query: query ?? "", index: selectable[position]! });
      }
      return true;
    }
    if (event.key !== "Enter" && event.key !== "Tab") return false;
    const option = matches[index];
    if (!option) {
      // Keep Enter in the menu when every candidate is unavailable, and let Tab move focus.
      if (event.key === "Tab") return false;
      event.preventDefault();
      return true;
    }
    // Enter on a complete name sends it; Tab and Enter otherwise complete the name.
    // The Plan shortcut activates the local control even when typed in full.
    if (
      event.key === "Enter" &&
      value.toLowerCase() === `/${option.name.toLowerCase()}` &&
      option.name.toLowerCase() !== planName
    )
      return false;
    event.preventDefault();
    choose(option);
    return true;
  };
  const menu = open ? (
    <div
      className={`absolute inset-x-0 z-30 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 ${side === "bottom" ? "top-full mt-2" : "bottom-full mb-2"}`}
    >
      {listOpen ? (
        <ul
          ref={list}
          id={listboxId}
          role="listbox"
          aria-label={label ?? copy.label}
          className="max-h-64 overflow-y-auto"
        >
          {matches.map((option, position) => (
            <li
              key={option.name}
              id={`${listboxId}-${position}`}
              role="option"
              aria-selected={position === index}
              aria-disabled={option.disabledReason !== undefined || undefined}
              title={option.disabledReason}
              className={`rounded-md px-2 py-1.5 ${
                option.disabledReason !== undefined
                  ? "cursor-not-allowed opacity-50"
                  : position === index
                    ? "cursor-default bg-accent text-accent-foreground"
                    : "cursor-default"
              }`}
              // Keep focus in the textarea, which owns the keyboard.
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => {
                if (option.disabledReason === undefined && position !== index)
                  setCursor({ query: query ?? "", index: position });
              }}
              onClick={() => choose(option)}
            >
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 font-mono text-sm">/{option.name}</span>
                {option.argumentHint && (
                  <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                    {option.argumentHint}
                  </span>
                )}
              </span>
              {option.description && (
                <span className="block truncate text-xs leading-5 text-muted-foreground">
                  {option.description}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p role="status" className="px-2 py-1.5 text-xs leading-5 text-muted-foreground">
          {empty}
        </p>
      )}
    </div>
  ) : null;
  return {
    open,
    onKeyDown,
    /** Spread on the textarea. */
    inputProps: {
      "aria-autocomplete": "list" as const,
      "aria-controls": listOpen ? listboxId : undefined,
      "aria-activedescendant": listOpen && index >= 0 ? `${listboxId}-${index}` : undefined,
    },
    menu,
  };
}
