export const DSH_BRIDGE_COMPATIBILITY: Readonly<{
  protocol: 1;
  pluginVersion: string;
  minimumDshVersion: string;
  verifiedDshVersions: readonly string[];
}>;
export function dshBridgeCompatibility(
  version: unknown,
): "verified" | "unverified" | "unknown" | "too-old" | "invalid";
