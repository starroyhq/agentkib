import { useRef, useState } from "react";
import { Button } from "@agentkib/ui/button";
import { desktopApi } from "@/core/desktop";
import { useI18n } from "@/core/useI18n";
import type { DesktopAccountStatus } from "../../../electron/main/account/state";
import { remoteAccountCopy } from "./remote-account-copy";

export const OFFICIAL_BROKER_URL = "https://api.agentkib.com";

export function needsRemoteAccountRelogin(status: DesktopAccountStatus | undefined) {
  return status?.phase === "signed-out" && status.error === "account_login_required";
}

export function RemoteAccountRelogin({
  disabled,
  compact = false,
}: {
  disabled?: boolean;
  compact?: boolean;
}) {
  const { locale } = useI18n();
  const copy = remoteAccountCopy[locale];
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function relogin() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await desktopApi().account.request({ operation: "login" });
    } catch {
      setFailed(true);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant={compact ? "link" : "outline"}
        size={compact ? "content" : "sm"}
        disabled={disabled || busy}
        onClick={() => void relogin()}
      >
        {copy.relogin}
      </Button>
      {failed && (
        <span role="alert" className="text-xs text-destructive-text">
          {copy.failed}
        </span>
      )}
    </>
  );
}
