export const DSH_BRIDGE_COMPATIBILITY: Readonly<{
  protocol: 1;
  pluginVersion: string;
  minimumPluginVersion: string;
  minimumDshVersion: string;
  dshVersionBelow: string;
  verifiedDshVersions: readonly string[];
}>;
export function dshBridgePluginCompatibility(version: unknown): "supported" | "too-old" | "invalid";
export function dshBridgeLaunchable(version: unknown): boolean;
export function dshBridgeCompatibility(
  version: unknown,
): "verified" | "unverified" | "unknown" | "too-old" | "invalid";
