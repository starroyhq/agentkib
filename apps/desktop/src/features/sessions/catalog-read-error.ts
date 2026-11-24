import type { tr as Translate } from "@/core/i18n";
import { ApiError } from "@agentkib/web-client";

export function isCatalogReadTimeout(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 504 &&
    (error.code === "catalog_read_timeout" || error.code === "outcome_unknown")
  );
}

/** Localize a read failure without putting wire codes or diagnostic details in the directory. */
export function catalogReadError(error: unknown, tr: typeof Translate): string {
  if (isCatalogReadTimeout(error)) return tr("sessions.catalogReadTimeout");
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  // IPC can prepend an Error or RuntimeRequestError wrapper to a standalone error code.
  const code = message.trim().match(/(?:^|:\s*)([a-z][a-z0-9_.-]*)$/i)?.[1];
  switch (code) {
    case "catalog_read_timeout":
      return tr("sessions.catalogReadTimeout");
    case "outcome_unknown":
      if (!(error instanceof ApiError)) return tr("sessions.catalogReadTimeout");
      break;
    case "operation_busy":
      return tr("sessions.catalogReadBusy");
    case "session-index-stale":
    case "session-catalog-stale":
    case "catalog-resync-required":
    case "catalog_stale":
    case "stale_boot":
    case "access_changed":
      return tr("sessions.catalogReadChanged");
    case "account_login_required":
    case "access_ended":
      return tr("sessions.catalogReadSignIn");
    case "permission_denied":
      return tr("sessions.catalogReadDenied");
  }
  if (error instanceof ApiError) {
    if (error.status === 401) return tr("sessions.catalogReadSignIn");
    if (error.status === 403) return tr("sessions.catalogReadDenied");
  }
  return tr("sessions.catalogReadUnavailable");
}
