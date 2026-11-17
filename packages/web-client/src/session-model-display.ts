import type { Access, CodexSessionSettings, WebClient } from "./index";

export interface SessionModelDisplay {
  modelId: string;
  name?: string;
  effort?: string;
  serviceTierId?: string;
}

export function canDisplayCodexModelFallback(settings?: CodexSessionSettings) {
  if (settings?.applicationStatus !== "pending") return true;
  // Staged Codex model mutations always store a model ID. A staged policy can inherit it.
  return (
    !!(settings.selected?.policyId ?? settings.current.policyId) &&
    !settings.selected?.modelId &&
    !settings.current.modelId &&
    !!(settings.historicalSettings?.modelId ?? settings.defaults.modelId)
  );
}

// Only keep what the button displays. The settings catalog and write revision come from the host.
const displays = new Map<string, SessionModelDisplay>();
const MAX_SESSION_DISPLAYS = 128;

function displayKey(
  client: WebClient,
  access: Access | undefined,
  sessionId: string,
  agent: string | undefined,
) {
  if (
    access?.status !== "approved" ||
    access.device?.accessMode !== "full" ||
    access.device.advancedControl !== true ||
    !access.bootId ||
    !access.device.id ||
    !sessionId ||
    !agent
  )
    return undefined;
  // A different renderer entry point can recreate its client on the same authorized host.
  return JSON.stringify([client.origin, access.bootId, access.device.id, sessionId, agent]);
}

export function readSessionModelDisplay(
  client: WebClient,
  access: Access | undefined,
  sessionId: string,
  agent: string | undefined,
) {
  const key = displayKey(client, access, sessionId, agent);
  return key === undefined ? undefined : displays.get(key);
}

export function rememberSessionModelDisplay(
  client: WebClient,
  access: Access | undefined,
  sessionId: string,
  agent: string | undefined,
  { modelId, name, effort, serviceTierId }: SessionModelDisplay,
) {
  const key = displayKey(client, access, sessionId, agent);
  if (key === undefined || !modelId) return;
  const previous = displays.get(key);
  displays.delete(key);
  displays.set(key, {
    modelId,
    name: name ?? (previous?.modelId === modelId ? previous.name : undefined),
    effort,
    serviceTierId,
  });
  if (displays.size > MAX_SESSION_DISPLAYS) {
    const oldest = displays.keys().next().value;
    if (oldest !== undefined) displays.delete(oldest);
  }
}

export function forgetSessionModelDisplay(
  client: WebClient,
  access: Access | undefined,
  sessionId: string,
  agent: string | undefined,
) {
  const key = displayKey(client, access, sessionId, agent);
  if (key !== undefined) displays.delete(key);
}
