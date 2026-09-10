import { MessagesSquare } from "lucide-react";
import { useSession } from "./session-context";

export function SessionEmpty() {
  const { t } = useSession();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
      <div className="mb-2 grid size-16 place-items-center rounded-2xl border bg-muted/40">
        <MessagesSquare className="size-7 text-muted-foreground" strokeWidth={1.4} />
      </div>
      <h2 className="text-xl font-medium tracking-tight">{t.select}</h2>
      <p className="max-w-sm text-sm leading-7 text-muted-foreground">{t.selectInfo}</p>
    </div>
  );
}
