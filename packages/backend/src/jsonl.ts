import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
/** Snapshot-length streaming keeps native metadata discovery independent of transcript size. */
export function* jsonLines(
  file: string,
  options: { bytes: number; lines?: number; rejectOversized?: boolean },
): Generator<{ line: number; value: unknown }> {
  if (!lstatSync(file).isFile()) throw new Error("Transcript must be a regular file");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = fstatSync(fd);
    if (!metadata.isFile()) throw new Error("Transcript must be a regular file");
    if (options.rejectOversized && metadata.size > options.bytes)
      throw new Error("Transcript exceeds the 256 MiB read limit");
    const length = Math.min(metadata.size, options.bytes),
      block = Buffer.allocUnsafe(65536);
    let position = 0,
      number = 0,
      size = 0,
      oversized = false;
    let fragments: Buffer[] = [];
    while (position < length && number < (options.lines ?? Infinity)) {
      const count = readSync(fd, block, 0, Math.min(block.length, length - position), position);
      if (!count) break;
      position += count;
      let start = 0;
      for (let i = 0; i < count; i++)
        if (block[i] === 10) {
          number++;
          const part = block.subarray(start, i + 1);
          size += part.length;
          if (!oversized && size <= 4 * 1024 * 1024) {
            fragments.push(Buffer.from(part));
            try {
              const value: unknown = JSON.parse(
                new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
                  Buffer.concat(fragments, size),
                ),
              );
              yield { line: number, value };
            } catch {}
          }
          fragments = [];
          size = 0;
          oversized = false;
          start = i + 1;
          if (number >= (options.lines ?? Infinity)) break;
        }
      if (number >= (options.lines ?? Infinity)) break;
      if (start < count) {
        const part = block.subarray(start, count);
        size += part.length;
        if (size > 4 * 1024 * 1024) {
          oversized = true;
          fragments = [];
        } else if (!oversized) fragments.push(Buffer.from(part));
      }
    }
  } finally {
    closeSync(fd);
  }
}
