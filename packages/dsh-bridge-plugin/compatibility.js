// One policy shared by the shipped DeepSeek Harness plugin and the AgentKib Runtime.
// Only add a verified version after recording real-DSH acceptance evidence in QA.
export const DSH_BRIDGE_COMPATIBILITY = Object.freeze({
  protocol: 1,
  pluginVersion: "0.5.0",
  minimumDshVersion: "0.2.1-rc.5",
  verifiedDshVersions: Object.freeze(["0.2.1-rc.5"]),
});

const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-([0-9A-Za-z.-]{1,32}))?$/;

/** Semantic version precedence for the bounded shapes DSH releases use. */
function compare(left, right) {
  const a = VERSION.exec(left);
  const b = VERSION.exec(right);
  for (let index = 1; index <= 3; index++) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference) return Math.sign(difference);
  }
  if (a[4] === undefined || b[4] === undefined)
    return a[4] === b[4] ? 0 : a[4] === undefined ? 1 : -1;
  const x = a[4].split(".");
  const y = b[4].split(".");
  for (let index = 0; index < Math.max(x.length, y.length); index++) {
    if (x[index] === undefined) return -1;
    if (y[index] === undefined) return 1;
    const numeric = /^\d+$/.test(x[index]) && /^\d+$/.test(y[index]);
    if (numeric && Number(x[index]) !== Number(y[index]))
      return Math.sign(Number(x[index]) - Number(y[index]));
    if (!numeric && x[index] !== y[index]) return x[index] < y[index] ? -1 : 1;
  }
  return 0;
}

/**
 * "unknown" is a runtime whose version the plugin could not read; it may still
 * connect, because every operation is also gated by the services it reports.
 */
export function dshBridgeCompatibility(version) {
  if (version === "unknown") return "unknown";
  if (typeof version !== "string" || !VERSION.test(version)) return "invalid";
  if (compare(version, DSH_BRIDGE_COMPATIBILITY.minimumDshVersion) < 0) return "too-old";
  return DSH_BRIDGE_COMPATIBILITY.verifiedDshVersions.includes(version) ? "verified" : "unverified";
}
