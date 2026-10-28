import type {
  HeadersReceivedResponse,
  OnHeadersReceivedListenerDetails,
  Session,
  WebContents,
} from "electron";

/** Where the conversation's web preview frames pages directly (renderer live-preview.tsx). */
export const LOCAL_PREVIEW_FRAME_SOURCES = "http://localhost:* https://localhost:*";

type FrameResponseDetails = Pick<
  OnHeadersReceivedListenerDetails,
  "url" | "resourceType" | "frame" | "webContents" | "responseHeaders"
>;

/**
 * Many local servers forbid framing by default (Django and Rails send X-Frame-Options). The web
 * preview still shows them, but only a localhost document framed directly by the main window:
 * frames inside that page keep their protection.
 */
export function allowLocalPreviewFraming(
  session: Pick<Session, "webRequest">,
  isPreviewWindow: (contents: WebContents) => boolean,
): void {
  // Electron allows one listener per event: this is the session's only onHeadersReceived.
  // An unspecified port in these patterns matches every port.
  session.webRequest.onHeadersReceived(
    { urls: ["http://localhost/*", "https://localhost/*"] },
    (details, callback) => callback(localPreviewFrameResponse(details, isPreviewWindow)),
  );
}

export function localPreviewFrameResponse(
  details: FrameResponseDetails,
  isPreviewWindow: (contents: WebContents) => boolean,
): HeadersReceivedResponse {
  // details.frame is the frame receiving the document.
  const parent = details.frame?.parent;
  if (
    details.resourceType !== "subFrame" ||
    !details.responseHeaders ||
    !parent ||
    parent.parent ||
    !details.webContents ||
    !isPreviewWindow(details.webContents) ||
    hostname(details.url) !== "localhost"
  )
    return {};
  const responseHeaders = framableHeaders(details.responseHeaders);
  return responseHeaders ? { responseHeaders } : {};
}

/** These headers without X-Frame-Options and CSP frame-ancestors; undefined if neither is present. */
export function framableHeaders(
  headers: Record<string, string[]>,
): Record<string, string[]> | undefined {
  let changed = false;
  const result: Record<string, string[]> = {};
  for (const [name, values] of Object.entries(headers)) {
    const header = name.toLowerCase();
    if (header === "x-frame-options") {
      changed = true;
      continue;
    }
    if (header !== "content-security-policy") {
      result[name] = values;
      continue;
    }
    const policies = values.map(withoutFrameAncestors);
    if (policies.some((policy, index) => policy !== values[index])) changed = true;
    const kept = policies.filter(Boolean);
    if (kept.length) result[name] = kept;
  }
  return changed ? result : undefined;
}

const FRAME_ANCESTORS = /(?:^|[;,])\s*frame-ancestors(?:[\s;,]|$)/i;

/**
 * One CSP header value without its frame-ancestors directives; "" when nothing else remains.
 * A value is a comma-separated list of policies, each a semicolon-separated list.
 */
export function withoutFrameAncestors(value: string): string {
  if (!FRAME_ANCESTORS.test(value)) return value;
  return value
    .split(",")
    .map((policy) =>
      policy
        .split(";")
        .filter(
          (directive) => directive.trim().split(/\s/, 1)[0]!.toLowerCase() !== "frame-ancestors",
        )
        .join(";")
        .trim(),
    )
    .filter((policy) => policy.replaceAll(";", "").trim())
    .join(", ");
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
