// One policy shared by the shipped plugin and Runtime. Only add a verified
// version after recording native read-only acceptance evidence in QA.
export const CLAUDE_BRIDGE_COMPATIBILITY = Object.freeze({
  minimumCliVersion: "2.1.301",
  verifiedCliVersions: Object.freeze(["2.1.301", "2.1.310"]),
  pluginVersion: "0.4.0",
  capabilityVersion: 1,
});

export const CLAUDE_BRIDGE_REQUIRED_CAPABILITIES = Object.freeze([
  "session-identity",
  "session-messages",
  "session-usage",
  "credential-store",
  "credential-read",
]);

export function claudeBridgeCompatibility(version) {
  // Reject ambiguous/prerelease versions instead of coercing them into a
  // supported stable release. Bound each component before numeric comparison.
  if (
    typeof version !== "string" ||
    !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(version)
  )
    return "invalid";
  const actual = version.split(".").map(Number);
  const minimum = CLAUDE_BRIDGE_COMPATIBILITY.minimumCliVersion.split(".").map(Number);
  for (let index = 0; index < minimum.length; index++) {
    if (actual[index] < minimum[index]) return "too-old";
    if (actual[index] > minimum[index]) break;
  }
  return CLAUDE_BRIDGE_COMPATIBILITY.verifiedCliVersions.includes(version)
    ? "verified"
    : "unverified";
}

export function missingClaudeBridgeCapabilities(report) {
  if (
    report?.version !== CLAUDE_BRIDGE_COMPATIBILITY.capabilityVersion ||
    !Array.isArray(report.available) ||
    report.available.length > 32 ||
    report.available.some((name) => typeof name !== "string" || name.length > 64)
  )
    return [...CLAUDE_BRIDGE_REQUIRED_CAPABILITIES];
  return CLAUDE_BRIDGE_REQUIRED_CAPABILITIES.filter((name) => !report.available.includes(name));
}
