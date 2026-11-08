export const DSH_BRIDGE_COMPATIBILITY: Readonly<{
  protocol: 1;
  pluginVersion: string;
  minimumPluginVersion: string;
  minimumDshVersion: string;
  verifiedDshVersions: readonly string[];
}>;
export function dshBridgePluginCompatibility(version: unknown): "supported" | "too-old" | "invalid";
export function dshBridgeCompatibility(
  version: unknown,
): "verified" | "unverified" | "unknown" | "too-old" | "invalid";
