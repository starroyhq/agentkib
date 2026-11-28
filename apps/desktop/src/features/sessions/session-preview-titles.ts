import { isGenericAgentTitle, sessionTitleFromMessage } from "@agentkib/session-catalog";

const STORAGE_KEY = "agentkib.session-title-previews.v1";
const MAX_ENTRIES = 500;

const listeners = new Set<() => void>();
let cache: Map<string, string> | undefined;

function loadCache(): Map<string, string> {
  if (cache) return cache;
  cache = new Map();
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return cache;
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (
          Array.isArray(item) &&
          typeof item[0] === "string" &&
          typeof item[1] === "string" &&
          item[0] &&
          item[1]
        ) {
          cache.set(item[0], item[1]);
        }
      }
    }
  } catch {
    // Ignore unavailable or malformed local storage.
  }
  return cache;
}

function persistCache(map: Map<string, string>) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...map.entries()]));
  } catch {
    // Ignore storage quota or private-mode errors.
  }
}

export function sessionTitlePreview(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  return loadCache().get(sessionId);
}

export function rememberSessionTitlePreview(
  sessionId: string | undefined,
  message: string | null | undefined,
): boolean {
  if (!sessionId) return false;
  const preview = sessionTitleFromMessage(message);
  if (!preview) return false;
  const map = loadCache();
  if (map.get(sessionId) === preview) return false;
  map.delete(sessionId);
  map.set(sessionId, preview);
  while (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  persistCache(map);
  for (const listener of listeners) listener();
  return true;
}

export function applySessionTitlePreview<S extends { id: string; title?: string | null }>(
  session: S,
): S {
  const existing = session.title?.trim();
  if (existing && !isGenericAgentTitle(existing)) return session;
  const preview = sessionTitlePreview(session.id);
  if (!preview || preview === existing) return session;
  return { ...session, title: preview };
}

export function subscribeSessionTitlePreviews(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetSessionTitlePreviewsForTest() {
  cache = new Map();
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Ignore unavailable storage.
  }
}
