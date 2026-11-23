import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEVIN_PERMISSION_MODES,
  type DevinPermissionMode,
  type DevinTurnSettings,
} from "./devin-managed-runner";

/**
 * What a Devin turn runs with when nothing was chosen: edits inside the workspace are approved
 * and Devin asks the person about anything else, as Codex starts in AgentKib.
 */
export const DEVIN_DEFAULT_PERMISSION_MODE: DevinPermissionMode = "accept-edits";

const FILE = "devin-session-settings.json";
const MAX_SESSIONS = 2_000;
const MODEL = /^[A-Za-z0-9._:@/+-]{1,128}$/;

interface Saved {
  model?: string;
  permissionMode?: DevinPermissionMode;
  updatedAt: number;
}

function parse(value: unknown): Saved | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const model =
    typeof entry.model === "string" && MODEL.test(entry.model) ? entry.model : undefined;
  const permissionMode = (DEVIN_PERMISSION_MODES as readonly unknown[]).includes(
    entry.permissionMode,
  )
    ? (entry.permissionMode as DevinPermissionMode)
    : undefined;
  const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : 0;
  return { ...(model ? { model } : {}), ...(permissionMode ? { permissionMode } : {}), updatedAt };
}

/**
 * The model and permission mode chosen in AgentKib for each Devin session, by Devin's session
 * ID, kept in AgentKib's data directory so that they outlive a restart. Devin's own store is
 * never written.
 */
export class DevinSessionSettings {
  constructor(readonly dataDir: string) {}

  #file() {
    return path.join(this.dataDir, FILE);
  }

  #readAll(): Record<string, Saved> {
    try {
      const value: unknown = JSON.parse(readFileSync(this.#file(), "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) return {};
      const entries: Record<string, Saved> = {};
      for (const [id, entry] of Object.entries(value)) {
        const parsed = parse(entry);
        if (parsed) entries[id] = parsed;
      }
      return entries;
    } catch {
      return {};
    }
  }

  /** What a session's turns run with: its saved choices, else Devin's model and the default mode. */
  get(nativeId: string): DevinTurnSettings & { permissionMode: DevinPermissionMode } {
    const saved = this.#readAll()[nativeId];
    return {
      ...(saved?.model ? { model: saved.model } : {}),
      permissionMode: saved?.permissionMode ?? DEVIN_DEFAULT_PERMISSION_MODE,
    };
  }

  /** Saves a session's choices; an empty choice clears it back to the default. */
  set(nativeId: string, settings: DevinTurnSettings): void {
    const entries = this.#readAll();
    const next = {
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.permissionMode ? { permissionMode: settings.permissionMode } : {}),
      updatedAt: Date.now(),
    };
    if (next.model || next.permissionMode) entries[nativeId] = next;
    else delete entries[nativeId];
    // The least recently changed sessions go first once there are too many.
    const kept = Object.entries(entries)
      .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_SESSIONS);
    mkdirSync(this.dataDir, { recursive: true });
    const temporary = `${this.#file()}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(kept)), { mode: 0o600 });
    renameSync(temporary, this.#file());
  }
}
