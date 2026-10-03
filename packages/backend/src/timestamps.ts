/** Match chrono's UTC serialization without dropping sub-millisecond precision. */
export function timestamp(value: unknown, permissive = false): string | null {
  if (value === null || value === undefined) return null;
  if (
    (typeof value === "bigint" || (typeof value === "string" && /^[+-]?\d+$/.test(value))) &&
    permissive
  ) {
    const time = Number(value);
    const date = new Date(Math.abs(time) >= 100_000_000_000 ? time : time * 1000);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString().replace(".000Z", "Z");
  }
  if (typeof value === "string") {
    const match =
      /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})$/.exec(
        value,
      );
    if (match) {
      const leapSecond = match[3] === "60";
      const local = `${match[1]}T${match[2]}:${leapSecond ? "59" : match[3]}`;
      const wallClock = new Date(`${local}Z`);
      const date = new Date(`${local}${match[5].toUpperCase()}`);
      // Date normalizes dates such as February 30; chrono rejects them.
      if (
        !Number.isNaN(date.valueOf()) &&
        !Number.isNaN(wallClock.valueOf()) &&
        wallClock.toISOString().slice(0, 19) === local
      ) {
        const nanos = (match[4] ?? "").padEnd(9, "0");
        const fraction =
          Number(nanos) === 0
            ? ""
            : `.${nanos.slice(0, nanos.endsWith("000000") ? 3 : nanos.endsWith("000") ? 6 : 9)}`;
        const utc = date.toISOString().slice(0, 19);
        return `${leapSecond ? `${utc.slice(0, 17)}60` : utc}${fraction}Z`;
      }
    }
  }
  if (permissive) return null;
  throw new Error("Invalid stored timestamp");
}
