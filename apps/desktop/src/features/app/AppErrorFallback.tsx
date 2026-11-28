import { useI18n } from "@/core/useI18n";
import { useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { AlertTriangle, Home, RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@agentkib/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export function AppErrorFallback({ error, reset }: ErrorComponentProps) {
  const { tr } = useI18n();
  const router = useRouter();
  const detail = error instanceof Error ? error.message : String(error);

  const goHome = () => {
    reset();
    void router.navigate({ to: "/", search: {}, replace: true });
  };

  return (
    <div className="grid min-h-full place-items-center p-6">
      <Card className="w-full max-w-xl border-destructive/25 bg-card shadow-sm">
        <CardContent className="grid justify-items-center gap-5 px-6 py-10 text-center sm:px-10">
          <span className="grid size-14 place-items-center rounded-2xl bg-destructive/10 text-destructive-icon">
            <AlertTriangle size={27} />
          </span>
          <div className="grid gap-2">
            <h1 className="text-xl font-semibold tracking-[-.02em]">{tr("errors.pageTitle")}</h1>
            <p className="m-0 max-w-md text-sm leading-6 text-muted-foreground">
              {tr("errors.pageDescription")}
            </p>
          </div>
          {import.meta.env.DEV && detail && (
            <div className="w-full rounded-lg bg-muted/60 px-3 py-2 text-left text-xs text-muted-foreground">
              <p className="m-0 font-medium">{tr("errors.details")}</p>
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono">
                {detail}
              </pre>
            </div>
          )}
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="outline" onClick={reset}>
              <RotateCcw />
              {tr("errors.retryPage")}
            </Button>
            <Button onClick={goHome}>
              <Home />
              {tr("errors.returnHome")}
            </Button>
            <Button variant="ghost" onClick={() => window.location.reload()}>
              <RefreshCw />
              {tr("errors.reloadApp")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
