import type { ReactNode } from "react";
import { CircleAlert, Info } from "lucide-react";
import { cn } from "cn";

export function SessionNotice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={cn(
        "session-notice mb-4 flex items-start gap-[9px] rounded-[10px] border bg-muted px-3.5 py-3 leading-[1.6] text-muted-foreground [overflow-wrap:anywhere] [&>svg]:mt-[3px] [&>svg]:shrink-0",
        error &&
          "session-notice-error bg-[color-mix(in_srgb,var(--destructive)_5%,var(--background))] text-destructive",
      )}
      role={error ? "alert" : "status"}
    >
      {error ? <CircleAlert size={17} /> : <Info size={17} />}
      <div>{children}</div>
    </div>
  );
}
