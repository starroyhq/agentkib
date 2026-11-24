// Codex policy files are Starlark. Recognize only the literal declarations used by documented
// prefix rules and Codex's own default.rules writer. Never run a policy or infer dynamic rules.
type Literal = string | Literal[];
type Token = { text: string; value?: string };

export function literalCodexAllowRules(source: string): string[] {
  const scan = /\s+|#[^\r\n]*|"(?:[^"\\\r\n]|\\[^\r\n])*"|[A-Za-z_]\w*|[()[\],=]/y;
  const tokens: Token[] = [];
  for (let offset = 0; offset < source.length; offset = scan.lastIndex) {
    scan.lastIndex = offset;
    const match = scan.exec(source);
    if (!match) return [];
    const text = match[0];
    if (/^\s|^#/.test(text)) continue;
    if (!text.startsWith('"')) {
      tokens.push({ text });
      continue;
    }
    try {
      tokens.push({ text, value: JSON.parse(text) as string });
    } catch {
      return [];
    }
  }

  let at = 0;
  function take(text: string): boolean {
    if (tokens[at]?.text !== text) return false;
    at++;
    return true;
  }
  function literal(depth: number): Literal | undefined {
    const value = tokens[at]?.value;
    if (value !== undefined) {
      at++;
      return value;
    }
    if (depth === 2 || !take("[")) return;
    const items: Literal[] = [];
    while (!take("]")) {
      const item = literal(depth + 1);
      if (item === undefined) return;
      items.push(item);
      if (!take(",")) return take("]") ? items : undefined;
    }
    return items;
  }

  const result: string[] = [];
  while (at < tokens.length) {
    if (!take("prefix_rule") || !take("(")) return [];
    const args = new Map<string, Literal>();
    while (!take(")")) {
      const key = tokens[at++]?.text;
      if (
        key === undefined ||
        !["pattern", "decision", "justification", "match", "not_match"].includes(key) ||
        args.has(key) ||
        !take("=")
      )
        return [];
      const value = literal(0);
      if (value === undefined) return [];
      args.set(key, value);
      if (!take(",")) {
        if (!take(")")) return [];
        break;
      }
    }

    const pattern = args.get("pattern");
    const decision = args.get("decision") ?? "allow";
    if (
      !Array.isArray(pattern) ||
      pattern.length === 0 ||
      !pattern.every(
        (part) =>
          typeof part === "string" ||
          (part.length > 0 && part.every((choice) => typeof choice === "string")),
      ) ||
      (decision !== "allow" && decision !== "prompt" && decision !== "forbidden")
    )
      return [];
    if (decision === "allow") {
      const arg = (value: string) => (/^[\w./*:@+-]+$/.test(value) ? value : JSON.stringify(value));
      result.push(
        pattern
          .map((part) =>
            typeof part === "string"
              ? arg(part)
              : "(" + (part as string[]).map(arg).join(" | ") + ")",
          )
          .join(" "),
      );
    }
  }
  return result;
}
