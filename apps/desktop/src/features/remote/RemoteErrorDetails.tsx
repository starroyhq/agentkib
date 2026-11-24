import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { localizeMessage, type tr as Translate } from "@/core/i18n";
import { useI18n } from "@/core/useI18n";

const errorKeys: Record<string, string> = {
  REMOTE_PAIRING_INVALID: "remote.error.pairing",
  REMOTE_OFFLINE: "remote.error.offline",
  REMOTE_DISCONNECTED: "remote.error.disconnected",
  REMOTE_REVOKED: "remote.error.revoked",
  REMOTE_IDENTITY_CHANGED: "remote.error.identity",
  REMOTE_SHARING_DISABLED: "remote.error.sharing",
  REMOTE_INDEX_DISABLED: "remote.error.index",
  REMOTE_PROTOCOL_MISMATCH: "remote.error.protocol",
  REMOTE_LIMIT: "remote.error.limit",
  REMOTE_REQUEST_FAILED: "remote.error.request",
};

function diagnosticText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function errorMessage(error: unknown, detail: string, tr: typeof Translate): string {
  // Electron wraps Runtime errors in a string; match whole codes, not arbitrary substrings.
  const code = detail.match(/\bREMOTE_[A-Z_]+\b/)?.[0];
  if (code && errorKeys[code]) return tr(errorKeys[code]);
  // Local validation failures precede the network exchange and have no wire error code.
  if (/pairing expired|invalid pairing code|8 digit pairing code required/i.test(detail)) {
    return tr("remote.error.pairing");
  }
  if (/pairing not approved/i.test(detail)) return tr("remote.error.approval");
  if (/cannot pair with this device/i.test(detail)) return tr("remote.error.self");
  if (
    /private IPv4 address|Remote address must be|Invalid remote address|port required/i.test(detail)
  ) {
    return tr("remote.error.address");
  }
  if (/select a local network interface/i.test(detail)) return tr("remote.error.interface");
  if (/enable sharing first/i.test(detail)) return tr("remote.error.enableSharing");
  if (/address already in use|EADDRINUSE/i.test(detail)) return tr("remote.error.portBusy");
  if (
    /connection refused|connection reset|timed out|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(
      detail,
    )
  ) {
    return tr("remote.error.offline");
  }
  if (/device limit reached|host limit reached/i.test(detail)) return tr("remote.error.limit");
  if (
    typeof error === "object" &&
    error !== null &&
    "key" in error &&
    typeof error.key === "string"
  ) {
    // Preserve existing structured translations, but keep their diagnostics out of the summary.
    return localizeMessage({ ...error, detail: undefined }, tr);
  }
  return tr("remote.error.request");
}

/** Shared by connection settings, the quick panel and remote catalog errors. */
export function RemoteErrorDetails({
  error,
  showDiagnostics = true,
}: {
  error: unknown;
  showDiagnostics?: boolean;
}) {
  const { tr } = useI18n();
  const detail = diagnosticText(error);
  return (
    <div className="min-w-0 flex-1 break-words">
      <p>{errorMessage(error, detail, tr)}</p>
      {showDiagnostics && (
        <Collapsible key={detail} className="mt-2 text-xs">
          <CollapsibleTrigger className="cursor-pointer bg-transparent text-left">
            {tr("errors.details")}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all">
              {detail.slice(0, 4096)}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
