import type { ReactNode } from "react";

/** The square icon tile that starts each remote card's heading. */
export function CardIcon({ children }: { children: ReactNode }) {
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary-text [&_svg]:size-5">
      {children}
    </span>
  );
}

/** Hours and minutes only: pairing codes and retries are minutes away, never another day. */
export function clockTime(milliseconds: number, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(milliseconds));
}
