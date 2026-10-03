// Limit brace expansion to the same 128 variants as the original context reader.
export function braceVariants(pattern: string): string[] {
  const output: string[] = [];
  const expand = (value: string) => {
    if (output.length >= 128) return;
    let start = -1,
      depth = 0,
      escaped = false;
    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (char === "}" && depth > 0) {
        depth--;
        if (depth !== 0) continue;
        const body = value.slice(start + 1, i),
          choices: string[] = [];
        let nested = 0,
          skip = false,
          mark = 0;
        for (let n = 0; n < body.length; n++) {
          const c = body[n];
          if (skip) {
            skip = false;
            continue;
          }
          if (c === "\\") skip = true;
          else if (c === "{") nested++;
          else if (c === "}") nested--;
          else if (c === "," && nested === 0) {
            choices.push(body.slice(mark, n));
            mark = n + 1;
          }
        }
        if (!choices.length) {
          start = -1;
          continue;
        }
        choices.push(body.slice(mark));
        for (const choice of choices) {
          if (output.length >= 128) break;
          expand(value.slice(0, start) + choice + value.slice(i + 1));
        }
        return;
      }
    }
    output.push(value);
  };
  expand(pattern);
  return output;
}

type Atom =
  | { kind: "literal"; value: string }
  | { kind: "any" | "star" }
  | { kind: "class"; negated: boolean; ranges: [number, number][] }
  | { kind: "extglob"; operator: string; alternatives: Atom[][] };

// Match Unicode scalar values, including malformed-pattern rejection and
// the original extglob depth limit. JS glob libraries differ on these rules.
function parse(pattern: string): Atom[] | null {
  const chars = [...pattern];
  let index = 0;
  const sequence = (depth: number): Atom[] | null => {
    if (depth > 128) return null;
    const atoms: Atom[] = [];
    while (index < chars.length && ![")", "|"].includes(chars[index]!)) {
      const char = chars[index]!;
      if (["@", "?", "+", "*", "!"].includes(char) && chars[index + 1] === "(") {
        index += 2;
        const alternatives: Atom[][] = [];
        for (;;) {
          const branch = sequence(depth + 1);
          if (!branch) return null;
          alternatives.push(branch);
          if (chars[index] === "|") index++;
          else if (chars[index] === ")") {
            index++;
            break;
          } else return null;
        }
        atoms.push({ kind: "extglob", operator: char, alternatives });
        continue;
      }
      index++;
      if (char === "\\") {
        const value = chars[index++];
        if (value === undefined) return null;
        atoms.push({ kind: "literal", value });
      } else if (char === "?") atoms.push({ kind: "any" });
      else if (char === "*") {
        if (atoms.at(-1)?.kind !== "star") atoms.push({ kind: "star" });
      } else if (char === "[") {
        const negated = ["!", "^"].includes(chars[index]!);
        if (negated) index++;
        const ranges: [number, number][] = [];
        while (index < chars.length && chars[index] !== "]") {
          let first = chars[index++];
          if (first === "\\") first = chars[index++];
          if (first === undefined) return null;
          let last = first;
          if (chars[index] === "-" && chars[index + 1] !== undefined && chars[index + 1] !== "]") {
            index++;
            last = chars[index++]!;
            if (last === "\\") last = chars[index++]!;
            if (last === undefined) return null;
          }
          ranges.push([first.codePointAt(0)!, last.codePointAt(0)!]);
        }
        if (!ranges.length || chars[index++] !== "]") return null;
        atoms.push({ kind: "class", negated, ranges });
      } else atoms.push({ kind: "literal", value: char });
    }
    return atoms;
  };
  const atoms = sequence(0);
  return index === chars.length ? atoms : null;
}
function segmentMatches(pattern: string, target: string): boolean {
  const atoms = parse(pattern);
  if (!atoms) return false;
  const chars = [...target];
  const alternatives = (
    branches: Atom[][],
    start: number,
    end: number,
    depth: number,
  ): Set<number> => new Set(branches.flatMap((branch) => [...sequence(branch, start, end, depth)]));
  const repeat = (
    branches: Atom[][],
    starts: Set<number>,
    end: number,
    depth: number,
  ): Set<number> => {
    const reached = new Set(starts);
    let frontier = starts;
    while (frontier.size) {
      const next = new Set<number>();
      for (const position of frontier)
        for (const value of alternatives(branches, position, end, depth + 1))
          if (value > position && !reached.has(value)) {
            reached.add(value);
            next.add(value);
          }
      frontier = next;
    }
    return reached;
  };
  const apply = (atom: Atom, start: number, end: number, depth: number): Set<number> => {
    switch (atom.kind) {
      case "literal":
        return start < end && chars[start] === atom.value ? new Set([start + 1]) : new Set();
      case "any":
        return start < end ? new Set([start + 1]) : new Set();
      case "star":
        return new Set(Array.from({ length: end - start + 1 }, (_, index) => start + index));
      case "class": {
        const value = chars[start]?.codePointAt(0);
        return start < end &&
          value !== undefined &&
          atom.ranges.some(([first, last]) => first <= value && value <= last) !== atom.negated
          ? new Set([start + 1])
          : new Set();
      }
      case "extglob":
        switch (atom.operator) {
          case "@":
            return alternatives(atom.alternatives, start, end, depth + 1);
          case "?":
            return new Set([start, ...alternatives(atom.alternatives, start, end, depth + 1)]);
          case "+":
            return repeat(
              atom.alternatives,
              alternatives(atom.alternatives, start, end, depth + 1),
              end,
              depth + 1,
            );
          case "*":
            return repeat(atom.alternatives, new Set([start]), end, depth + 1);
          case "!":
            return new Set(
              Array.from({ length: end - start + 1 }, (_, index) => start + index).filter(
                (position) =>
                  !alternatives(atom.alternatives, start, position, depth + 1).has(position),
              ),
            );
        }
    }
    return new Set();
  };
  const sequence = (atoms: Atom[], start: number, end: number, depth: number): Set<number> => {
    if (depth > 32) return new Set();
    let positions = new Set([start]);
    for (const atom of atoms) {
      const next = new Set<number>();
      for (const position of positions)
        for (const value of apply(atom, position, end, depth + 1)) next.add(value);
      if (!next.size) return next;
      positions = next;
    }
    return positions;
  };
  return sequence(atoms, 0, chars.length, 0).has(chars.length);
}
export function globMatches(pattern: string, target: string): boolean {
  const parts = target.split("/");
  return braceVariants(pattern).some((variant) => {
    const patterns = variant.split("/");
    let pi = 0,
      ti = 0,
      star = -1,
      starTarget = 0;
    while (ti < parts.length) {
      if (
        pi < patterns.length &&
        patterns[pi] !== "**" &&
        segmentMatches(patterns[pi]!, parts[ti]!)
      ) {
        pi++;
        ti++;
      } else if (patterns[pi] === "**") {
        star = pi++;
        starTarget = ti;
      } else if (star >= 0) {
        ti = ++starTarget;
        pi = star + 1;
      } else return false;
    }
    while (patterns[pi] === "**") pi++;
    return pi === patterns.length;
  });
}
