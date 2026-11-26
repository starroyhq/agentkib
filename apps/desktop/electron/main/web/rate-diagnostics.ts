import { REMOTE_ROUTE, REMOTE_ROUTE_BASE, REMOTE_ROUTE_PREFIXES } from "@agentkib/runtime-protocol";
import { randomUUID } from "node:crypto";

const API_PREFIX = `${REMOTE_ROUTE_BASE}/`;
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
  const route = pathname.slice(REMOTE_ROUTE_BASE.length);
  if (method === "OPTIONS") return "preflight";
  if (method === "GET") {
    if (route === REMOTE_ROUTE.stream) return "stream";
    if (route === REMOTE_ROUTE.info || route === REMOTE_ROUTE.access) return "probe";
    if (route.startsWith(REMOTE_ROUTE_PREFIXES.requests)) return "receipt";
  }
  if (route === REMOTE_ROUTE.catalog) return "catalog";
  if (
    route === REMOTE_ROUTE.events ||
    route === REMOTE_ROUTE.subagentEvents ||
    route.startsWith(REMOTE_ROUTE_PREFIXES.history)
  )
    return "history";
  if (
    route === REMOTE_ROUTE.live ||
    route === REMOTE_ROUTE.readState ||
    route === REMOTE_ROUTE.managedCapabilities ||
    route === REMOTE_ROUTE.codexCapabilities
  )
    return "status";
  if (
    route.startsWith(REMOTE_ROUTE_PREFIXES.files) ||
    route.startsWith(REMOTE_ROUTE.attachments) ||
    route.startsWith(REMOTE_ROUTE.artifacts) ||
    route === REMOTE_ROUTE.artifactTickets ||
    route === REMOTE_ROUTE.sessionImages ||
    route === REMOTE_ROUTE.diff
  )
    return "files";
  if (
    route === REMOTE_ROUTE.pair ||
    route === REMOTE_ROUTE.pairCancel ||
    route === REMOTE_ROUTE.accountBinding
  )
    return "pairing";
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
