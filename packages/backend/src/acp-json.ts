import { jsonTimestamp } from "./session-history";
const i64min = -9223372036854775808n,
  u64max = 18446744073709551615n;
const invalidUnicode = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
/** Preserve wire integer types and precision so RPC string/number IDs cannot collide. */
export function parseAcpJson(bytes: Uint8Array): unknown {
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const parsed = JSON.parse(source, ((
    key: string,
    value: unknown,
    context?: { source?: string },
  ) => {
    if (invalidUnicode.test(key)) throw new Error("Invalid ACP JSON Unicode");
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Invalid ACP JSON number");
      if (context?.source && context.source !== "-0" && /^-?\d+$/.test(context.source)) {
        const integer = BigInt(context.source);
        if (integer >= i64min && integer <= u64max) return integer;
      }
    }
    if (typeof value === "string" && invalidUnicode.test(value))
      throw new Error("Invalid ACP JSON Unicode");
    return value;
  }) as Parameters<typeof JSON.parse>[1]);
  const pending: { value: unknown; depth: number }[] = [{ value: parsed, depth: 0 }];
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (value === null || typeof value !== "object") continue;
    if (depth >= 127) throw new Error("ACP JSON recursion limit exceeded");
    for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
  }
  return parsed;
}
export function stringifyAcpJson(value: unknown, pretty = false): string {
  const encode = (value: unknown, depth: number): string => {
    if (value === null) return "null";
    if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "bigint") return String(value);
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Invalid ACP JSON number");
      if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
      // serde_json's f64 formatter uses fixed notation for decimal exponents -5..15.
      const scientific = value.toExponential(),
        exponent = Number(scientific.split("e")[1]);
      if (exponent < -5 || exponent > 15) return scientific;
      return String(value) + (Number.isInteger(value) ? ".0" : "");
    }
    if (typeof value !== "object") throw new Error("Invalid ACP JSON value");
    if (depth >= 127) throw new Error("ACP JSON recursion limit exceeded");
    const open = pretty ? "\n" + "  ".repeat(depth + 1) : "",
      close = pretty ? "\n" + "  ".repeat(depth) : "",
      separator = pretty ? ",\n" + "  ".repeat(depth + 1) : ",";
    if (Array.isArray(value))
      return value.length
        ? "[" + open + value.map((item) => encode(item, depth + 1)).join(separator) + close + "]"
        : "[]";
    const object = value as Record<string, unknown>,
      keys = Object.keys(object).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return keys.length
      ? "{" +
          open +
          keys
            .map(
              (key) => JSON.stringify(key) + (pretty ? ": " : ":") + encode(object[key], depth + 1),
            )
            .join(separator) +
          close +
          "}"
      : "{}";
  };
  return encode(value, 0);
}
export function acpTimestamp(value: unknown): string | null {
  if (typeof value === "bigint") {
    if (
      value < -9223372036854775808n ||
      value > 9223372036854775807n ||
      value < -9007199254740991n ||
      value > 9007199254740991n
    )
      return null;
    value = Number(value);
  } else if (typeof value === "number") return null;
  return jsonTimestamp(value);
}
export function acpObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("ACP protocol error: expected object");
  return value as Record<string, unknown>;
}
