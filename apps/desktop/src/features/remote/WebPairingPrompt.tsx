import { useEffect, useRef, useState } from "react";
import { Button } from "@agentkib/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@agentkib/ui/dialog";
import { useI18n } from "@/core/useI18n";
import type { WebAdminStatus, WebPending } from "../../../electron/main/web/service";
import { requestWebAdmin, subscribeWebStatus } from "./web-status";
import { webSettingsCopy } from "./web-settings-copy";

type Grant = {
  send: boolean;
  approve: boolean;
  manage: boolean;
  files: boolean;
  attachments: boolean;
  advancedControl: boolean;
  organize: boolean;
  settings: boolean;
  extendedApproval: boolean;
};
const emptyGrant = (): Grant => ({
  send: false,
  approve: false,
  manage: false,
  files: false,
  attachments: false,
  advancedControl: false,
  organize: false,
  settings: false,
  extendedApproval: false,
});

/** Stays mounted across routes; settings remains the fallback for dismissed requests. */
export function WebPairingPrompt() {
  const { locale, formatDateTime } = useI18n();
  const copy = webSettingsCopy[locale];
  const [status, setStatus] = useState<WebAdminStatus>();
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [grants, setGrants] = useState<Record<string, Grant>>({});
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);

  useEffect(
    () =>
      subscribeWebStatus(undefined, {
        status: setStatus,
        error: () => undefined,
      }),
    [],
  );

  // Code pairing creates no pending request. Keep reviewing legacy requests until resolved.
  const pending = status?.pending.find((item) => !dismissed.has(item.id));
  const grant = pending ? (grants[pending.id] ?? emptyGrant()) : emptyGrant();

  function defer(item: WebPending) {
    setDismissed((old) => new Set(old).add(item.id));
    setError(false);
  }

  async function decide(item: WebPending, operation: "approve" | "reject") {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(false);
    try {
      await requestWebAdmin(
        operation === "approve" ? { operation, id: item.id, ...grant } : { operation, id: item.id },
      );
    } catch {
      setError(true);
    }
    locked.current = false;
    setBusy(false);
  }

  function setGrant(permission: keyof Grant, checked: boolean) {
    if (!pending) return;
    setGrants((old) => ({
      ...old,
      [pending.id]: { ...(old[pending.id] ?? emptyGrant()), [permission]: checked },
    }));
  }

  return (
    <Dialog
      open={Boolean(pending)}
      onOpenChange={(open) => {
        if (!open && pending && !busy) defer(pending);
      }}
    >
      {pending && (
        <DialogContent className="w-[min(520px,calc(100vw-2rem))]">
          <DialogHeader>
            <DialogTitle>{copy.pending}</DialogTitle>
            <DialogDescription>{copy.scope}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <strong className="block break-words">{pending.name}</strong>
            <p>
              {copy.verify}: <span className="font-mono font-semibold">{pending.verification}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {copy.expires} {formatDateTime(new Date(pending.expiresAt))}
            </p>
            <p className="text-xs text-muted-foreground">{copy.reviewLaterHint}</p>
            <div className="grid gap-2">
              {(
                [
                  "send",
                  "approve",
                  "manage",
                  "files",
                  "attachments",
                  "advancedControl",
                  "organize",
                  "settings",
                  "extendedApproval",
                ] as const
              ).map((permission) => (
                <label key={permission} className="flex items-start gap-2">
                  <Checkbox
                    checked={grant[permission]}
                    disabled={busy}
                    onCheckedChange={(checked) => setGrant(permission, checked === true)}
                  />
                  <span>{copy[permission]}</span>
                </label>
              ))}
            </div>
            {error && <p role="alert">{copy.decisionFailed}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => defer(pending)}>
              {copy.reviewLater}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void decide(pending, "reject")}
            >
              {copy.reject}
            </Button>
            <Button disabled={busy} onClick={() => void decide(pending, "approve")}>
              {copy.accept}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
