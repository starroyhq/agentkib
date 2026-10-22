export const CLAUDE_BRIDGE_COMPATIBILITY: Readonly<{
  minimumCliVersion: string;
  verifiedCliVersions: readonly string[];
  pluginVersion: string;
  capabilityVersion: 1;
}>;
export const CLAUDE_BRIDGE_REQUIRED_CAPABILITIES: readonly string[];
export function claudeBridgeCompatibility(
  version: unknown,
): "verified" | "unverified" | "too-old" | "invalid";
export function missingClaudeBridgeCapabilities(report: unknown): string[];
