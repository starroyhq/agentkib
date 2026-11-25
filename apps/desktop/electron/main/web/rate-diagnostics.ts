import { randomUUID } from "node:crypto";

const API_PREFIX = "/api/web/v1/";
const MINUTE_MS = 60_000;
const RETAIN_MINUTES = 15;
const MAX_DEVICES = 128;

export type RemoteRateCategory =
  | "stream"
  | "probe"
  | "catalog"
  | "history"
  | "status"
  | "receipt"
  | "files"
  | "control"
  | "pairing"
  | "preflight"
  | "api"
  | "other";

export function remoteRateCategory(
  method: string | undefined,
  pathname: string,
): RemoteRateCategory {
  if (!pathname.startsWith(API_PREFIX)) return "other";
  const route = pathname.slice(API_PREFIX.length);
  if (method === "OPTIONS") return "preflight";
  if (method === "GET") {
    if (route === "stream") return "stream";
    if (route === "info" || route === "access") return "probe";
    if (route.startsWith("requests/")) return "receipt";
  }
  if (route === "catalog") return "catalog";
  if (route === "events" || route === "subagent/events" || route.startsWith("history/"))
    return "history";
  if (
    route === "live" ||
    route === "read-state" ||
    route === "managed/capabilities" ||
    route === "codex/capabilities"
  )
    return "status";
  if (
    route.startsWith("files/") ||
    route.startsWith("attachments") ||
    route.startsWith("artifacts") ||
    route === "artifact-tickets" ||
    route === "session-images" ||
    route === "diff"
  )
    return "files";
  if (route === "pair" || route === "pair/cancel" || route === "account-binding") return "pairing";
  return method === "POST" ? "control" : "api";
}

type Counts = { requests: number; rejected: number };
type DeviceCounts = {
  alias: string;
  lastSeen: number;
  minutes: Map<number, Map<RemoteRateCategory, Counts>>;
};
export type RemoteRateDiagnosticRow = Counts & { deviceId: string; category: RemoteRateCategory };

/** Process-local totals. Only enrolled device IDs may be used as input keys. */
export class RemoteRateDiagnostics {
  private readonly devices = new Map<string, DeviceCounts>();
  private readonly anonymous: DeviceCounts = {
    alias: "anonymous",
    lastSeen: 0,
    minutes: new Map(),
  };
  private currentMinute?: number;

  observe(
    deviceId: string | undefined,
    category: RemoteRateCategory,
    rejected = false,
    at = Date.now(),
  ): void {
    const minute = this.advance(at);
    const device = deviceId ? this.device(deviceId) : this.anonymous;
    device.lastSeen = minute;
    let categories = device.minutes.get(minute);
    if (!categories) device.minutes.set(minute, (categories = new Map()));
    let counts = categories.get(category);
    if (!counts) categories.set(category, (counts = { requests: 0, rejected: 0 }));
    counts.requests += 1;
    if (rejected) counts.rejected += 1;
  }

  /** Attribute a later rejection to the minute in which the request was observed. */
  reject(deviceId: string | undefined, category: RemoteRateCategory, at = Date.now()): void {
    const device = deviceId ? this.devices.get(deviceId) : this.anonymous;
    const counts = device?.minutes.get(Math.floor(at / MINUTE_MS))?.get(category);
    if (counts && counts.rejected < counts.requests) counts.rejected += 1;
  }

  snapshot(deviceId?: string, at = Date.now()): RemoteRateDiagnosticRow[] {
    this.advance(at);
    const scopedDevice = deviceId === undefined ? undefined : this.devices.get(deviceId);
    const devices =
      deviceId === undefined
        ? [this.anonymous, ...this.devices.values()]
        : scopedDevice
          ? [scopedDevice]
          : [];
    return devices.flatMap((device) => {
      const totals = new Map<RemoteRateCategory, RemoteRateDiagnosticRow>();
      for (const categories of device.minutes.values()) {
        for (const [category, counts] of categories) {
          const row = totals.get(category);
          if (row) {
            row.requests += counts.requests;
            row.rejected += counts.rejected;
          } else {
            totals.set(category, { deviceId: device.alias, category, ...counts });
          }
        }
      }
      return [...totals.values()];
    });
  }

  private device(deviceId: string): DeviceCounts {
    const known = this.devices.get(deviceId);
    if (known) return known;
    if (this.devices.size >= MAX_DEVICES) {
      let oldest: [string, DeviceCounts] | undefined;
      for (const entry of this.devices)
        if (!oldest || entry[1].lastSeen < oldest[1].lastSeen) oldest = entry;
      if (oldest) this.devices.delete(oldest[0]);
    }
    const added: DeviceCounts = {
      alias: `device-${randomUUID()}`,
      lastSeen: 0,
      minutes: new Map(),
    };
    this.devices.set(deviceId, added);
    return added;
  }

  private advance(at: number): number {
    const minute = Math.floor(at / MINUTE_MS);
    if (this.currentMinute === minute) return minute;
    this.currentMinute = minute;
    const cutoff = minute - RETAIN_MINUTES;
    const prune = ({ minutes }: DeviceCounts) => {
      for (const key of minutes.keys()) if (key <= cutoff || key > minute) minutes.delete(key);
    };
    prune(this.anonymous);
    for (const [id, device] of this.devices) {
      prune(device);
      if (device.minutes.size === 0) this.devices.delete(id);
    }
    return minute;
  }
}
