import type { ReactNode } from "react";
import { MonitorSmartphone, ShieldCheck, MessagesSquare } from "lucide-react";
import type { Words } from "@/i18n";

export function PairingLayout({
  words: t,
  pending = false,
  children,
}: {
  words: Words;
  pending?: boolean;
  children: ReactNode;
}) {
  return (
    <main className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[1fr_1fr]">
      <aside className="flex flex-col justify-center gap-8 border-b bg-muted/30 px-7 py-10 md:px-16 lg:border-r lg:border-b-0 lg:px-[12%] [&>h2]:text-4xl [&>h2]:font-medium [&>h2]:tracking-tight [&>p]:max-w-md [&>p]:text-sm [&>p]:leading-7 [&>p]:text-muted-foreground">
        <span className="text-xs font-medium tracking-widest text-muted-foreground">
          AgentKib · {t.remote}
        </span>
        <h2>{t.connect}</h2>
        <p>{t.safety}</p>
        <ol className="flex flex-wrap gap-4 text-xs text-muted-foreground lg:flex-col lg:gap-6 [&>li]:flex [&>li]:items-center [&>li]:gap-3 [&>li[aria-current]]:font-semibold [&>li[aria-current]]:text-foreground">
          <li aria-current={!pending ? "step" : undefined}>
            <MonitorSmartphone size={20} aria-hidden="true" />
            <span>{t.code}</span>
          </li>
          <li aria-current={pending ? "step" : undefined}>
            <ShieldCheck size={20} aria-hidden="true" />
            <span>{t.pending}</span>
          </li>
          <li>
            <MessagesSquare size={20} aria-hidden="true" />
            <span>{t.sessions}</span>
          </li>
        </ol>
      </aside>
      <section className="mx-auto flex w-full max-w-lg flex-col justify-center gap-5 p-7 md:p-12 [&>h1]:text-2xl [&>h1]:font-medium [&>h1]:tracking-tight [&>p]:text-sm [&>p]:leading-7 [&>p]:text-muted-foreground [&>small]:text-xs [&>small]:text-muted-foreground [&>form]:grid [&>form]:gap-5 [&_label]:grid [&_label]:gap-2 [&_label]:text-xs [&_label]:font-medium">
        {children}
      </section>
    </main>
  );
}
