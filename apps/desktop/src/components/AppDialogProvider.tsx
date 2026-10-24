import { useTranslation } from "react-i18next";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type DialogTone = "default" | "destructive" | "warning";

interface DialogOptions {
  description: string;
  title?: string;
  tone?: DialogTone;
  confirmLabel?: string;
  cancelLabel?: string;
}

interface DialogRequest extends DialogOptions {
  id: number;
  kind: "confirm" | "notify";
  resolve: (accepted: boolean) => void;
}

interface AppDialogs {
  confirm: (options: string | DialogOptions) => Promise<boolean>;
  notify: (options: string | DialogOptions) => Promise<void>;
  requestSecrets: (keys: string[]) => Promise<Record<string, string> | null>;
}

interface SecretRequest {
  id: number;
  keys: string[];
  resolve: (values: Record<string, string> | null) => void;
}

const AppDialogContext = createContext<AppDialogs | undefined>(undefined);

export function AppDialogProvider({ children }: { children: ReactNode }) {
  const { t: tr } = useTranslation();
  const [queue, setQueue] = useState<DialogRequest[]>([]);
  const [secretRequest, setSecretRequest] = useState<SecretRequest>();
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const queueRef = useRef(queue);
  const secretRequestRef = useRef(secretRequest);
  const idRef = useRef(0);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    secretRequestRef.current = secretRequest;
  }, [secretRequest]);

  useEffect(
    () => () => {
      queueRef.current.forEach((request) => request.resolve(false));
      queueRef.current = [];
      secretRequestRef.current?.resolve(null);
    },
    [],
  );

  const enqueue = useCallback(
    (kind: DialogRequest["kind"], options: string | DialogOptions) =>
      new Promise<boolean>((resolve) => {
        const normalized = typeof options === "string" ? { description: options } : options;
        setQueue((current) => {
          const next = [...current, { ...normalized, id: ++idRef.current, kind, resolve }];
          queueRef.current = next;
          return next;
        });
      }),
    [],
  );

  const requestSecrets = useCallback(
    (keys: string[]) =>
      new Promise<Record<string, string> | null>((resolve) => {
        if (!keys.length) {
          resolve({});
          return;
        }
        setSecretValues(Object.fromEntries(keys.map((key) => [key, ""])));
        const request = { id: ++idRef.current, keys, resolve };
        secretRequestRef.current = request;
        setSecretRequest(request);
      }),
    [],
  );

  const finishSecrets = useCallback((values: Record<string, string> | null, requestId: number) => {
    const current = secretRequestRef.current;
    if (!current || current.id !== requestId) return;
    secretRequestRef.current = undefined;
    current.resolve(values);
    setSecretRequest(undefined);
    setSecretValues({});
  }, []);

  const value = useMemo<AppDialogs>(
    () => ({
      confirm: (options) => enqueue("confirm", options),
      notify: async (options) => {
        await enqueue("notify", options);
      },
      requestSecrets,
    }),
    [enqueue, requestSecrets],
  );

  const active = queue[0];
  const finish = useCallback((accepted: boolean, requestId: number) => {
    const [request, ...rest] = queueRef.current;
    if (!request || request.id !== requestId) return;
    queueRef.current = rest;
    request.resolve(accepted);
    setQueue(rest);
  }, []);

  return (
    <AppDialogContext.Provider value={value}>
      {children}
      <AlertDialog
        open={Boolean(active)}
        onOpenChange={(open) => {
          if (!open && active) finish(false, active.id);
        }}
      >
        {active && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {active.title ??
                  tr(active.kind === "notify" ? "dialog.noticeTitle" : "dialog.confirmTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>{active.description}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              {active.kind === "confirm" && (
                <AlertDialogCancel onClick={() => finish(false, active.id)}>
                  {active.cancelLabel ?? tr("common.cancel")}
                </AlertDialogCancel>
              )}
              <AlertDialogAction
                className={
                  active.tone === "warning"
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
                    : undefined
                }
                variant={active.tone === "destructive" ? "destructive" : "default"}
                onClick={() => finish(true, active.id)}
              >
                {active.confirmLabel ??
                  tr(active.kind === "notify" ? "common.ok" : "common.confirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
      <Dialog
        open={Boolean(secretRequest)}
        onOpenChange={(open) => {
          if (!open && secretRequest) finishSecrets(null, secretRequest.id);
        }}
      >
        {secretRequest && (
          <DialogContent className="w-[min(520px,calc(100vw-2rem))]">
            <DialogHeader>
              <DialogTitle>{tr("mcp.secretDialogTitle")}</DialogTitle>
              <DialogDescription>{tr("mcp.secretDialogDescription")}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4">
              {secretRequest.keys.map((key) => (
                <Label key={key}>
                  <span>{key}</span>
                  <Input
                    type="password"
                    autoComplete="off"
                    value={secretValues[key] ?? ""}
                    onChange={(event) =>
                      setSecretValues((current) => ({ ...current, [key]: event.target.value }))
                    }
                  />
                </Label>
              ))}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => finishSecrets(null, secretRequest.id)}>
                {tr("common.cancel")}
              </Button>
              <Button onClick={() => finishSecrets(secretValues, secretRequest.id)}>
                {tr("common.confirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </AppDialogContext.Provider>
  );
}

export function useAppDialogs() {
  const value = useContext(AppDialogContext);
  if (!value) throw new Error("useAppDialogs must be used within AppDialogProvider");
  return value;
}
