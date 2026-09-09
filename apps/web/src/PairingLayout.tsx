import type { ReactNode } from "react";
import { MonitorSmartphone, ShieldCheck, MessagesSquare } from "lucide-react";
import type { Words } from "./i18n";
import "./pairing-layout.css";

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
    <main className="pairing-layout">
      <aside className="pairing-guide">
        <span className="pairing-guide-label">AgentKib · {t.remote}</span>
        <h2>{t.connect}</h2>
        <p>{t.safety}</p>
        <ol className="pairing-steps">
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
      <section className="pair-page pairing-panel">{children}</section>
    </main>
  );
}
