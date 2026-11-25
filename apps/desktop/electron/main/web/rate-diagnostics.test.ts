import { describe, expect, it } from "vitest";
import { RemoteRateDiagnostics, remoteRateCategory } from "./rate-diagnostics";

describe("remote rate diagnostics", () => {
  it("counts requests and rejections without exposing the enrolled device or a route parameter", () => {
    const diagnostics = new RemoteRateDiagnostics();
    diagnostics.observe("internal-device-id", "catalog", false, 59_999);
    diagnostics.observe("internal-device-id", "catalog", false, 60_000);
    diagnostics.reject("internal-device-id", "catalog", 59_999);
    diagnostics.observe("internal-device-id", "receipt", true, 60_000);
    diagnostics.observe("another-device-id", "probe", true, 60_000);
    diagnostics.observe(undefined, "pairing", true, 60_000);

    const own = diagnostics.snapshot("internal-device-id", 60_001);
    expect(own).toEqual([
      {
        deviceId: expect.stringMatching(/^device-[0-9a-f-]{36}$/),
        category: "catalog",
        requests: 2,
        rejected: 1,
      },
      { deviceId: own[0]?.deviceId, category: "receipt", requests: 1, rejected: 1 },
    ]);
    expect(diagnostics.snapshot("missing", 60_001)).toEqual([]);
    const all = diagnostics.snapshot(undefined, 60_001);
    expect(all).toContainEqual({
      deviceId: "anonymous",
      category: "pairing",
      requests: 1,
      rejected: 1,
    });
    expect(JSON.stringify(all)).not.toContain("internal-device-id");
    expect(JSON.stringify(all)).not.toContain("another-device-id");
  });

  it("expires older minutes even when a device is still active and drops expired aliases", () => {
    const diagnostics = new RemoteRateDiagnostics();
    diagnostics.observe("device", "catalog", true, 0);
    diagnostics.observe("device", "catalog", false, 14 * 60_000);
    const [beforeExpiry] = diagnostics.snapshot("device", 899_999);
    expect(beforeExpiry).toMatchObject({ requests: 2, rejected: 1 });
    expect(diagnostics.snapshot("device", 900_000)).toEqual([
      { deviceId: beforeExpiry?.deviceId, category: "catalog", requests: 1, rejected: 0 },
    ]);
    expect(diagnostics.snapshot("device", 29 * 60_000)).toEqual([]);
    diagnostics.observe("device", "catalog", false, 29 * 60_000);
    expect(diagnostics.snapshot("device", 29 * 60_000)[0]?.deviceId).not.toBe(
      beforeExpiry?.deviceId,
    );
  });

  it("retains at most 128 enrolled devices plus a single anonymous group", () => {
    const diagnostics = new RemoteRateDiagnostics();
    diagnostics.observe(undefined, "other", false, 0);
    for (let i = 0; i < 129; i++) diagnostics.observe(`device-${i}`, "probe", false, 0);
    expect(diagnostics.snapshot(undefined, 0)).toHaveLength(129);
    expect(diagnostics.snapshot("device-0", 0)).toEqual([]);
    expect(diagnostics.snapshot("device-128", 0)).toHaveLength(1);
  });

  it.each([
    ["GET", "/api/web/v1/access", "probe"],
    ["GET", "/api/web/v1/stream", "stream"],
    ["POST", "/api/web/v1/stream", "control"],
    ["OPTIONS", "/api/web/v1/stream", "preflight"],
    ["GET", "/api/web/v1/requests/private-id", "receipt"],
    ["GET", "/api/web/v1/events", "history"],
    ["GET", "/api/web/v1/live", "status"],
    ["GET", "/api/web/v1/catalog", "catalog"],
    ["POST", "/api/web/v1/pair", "pairing"],
    ["GET", "/private-path", "other"],
  ])("classifies %s %s by fixed category", (method, pathname, category) => {
    expect(remoteRateCategory(method, pathname)).toBe(category);
  });
});
