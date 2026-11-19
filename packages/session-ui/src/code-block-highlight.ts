export type CodeHighlightKind =
  | "added"
  | "comment"
  | "keyword"
  | "number"
  | "operator"
  | "property"
  | "removed"
  | "string"
  | "tag"
  | "variable"
  | "word";

type CodeToken = { text: string; kind?: CodeHighlightKind };
type Rules = Partial<Record<CodeHighlightKind, string>>;

const MAX_HIGHLIGHT_LENGTH = 64_000;
const MAX_HIGHLIGHT_TOKENS = 4_000;
const DOUBLE_QUOTED = /"(?:\\[^\r\n]|[^"\\\r\n])*(?:"|(?=\r?$))/.source;
const SINGLE_QUOTED = /'(?:\\[^\r\n]|[^'\\\r\n])*(?:'|(?=\r?$))/.source;
const QUOTED = [DOUBLE_QUOTED, SINGLE_QUOTED].join("|");
const NUMBER =
  /\b(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)\b/
    .source;
const OPERATOR = /[+*%=<>!&|^~?:/-]/.source;
const HASH_COMMENT = /#[^\r\n]*/.source;
const C_COMMENT = /\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)/.source;

function words(keywordList: string): string {
  return "\\b(?:" + keywordList.split(" ").join("|") + ")\\b";
}

function syntax(rules: Rules, ignoreCase = false): RegExp {
  const alternatives = Object.entries(rules).map(
    ([kind, expression]) => "(?<" + kind + ">" + expression + ")",
  );
  return new RegExp(alternatives.join("|"), ignoreCase ? "gimu" : "gmu");
}

const shell = syntax({
  comment: /(?<![^\s;|&()])#[^\r\n]*/.source,
  string: /'(?:[^'\r\n])*(?:'|(?=\r?$))|"(?:\\[^\r\n]|[^"\\\r\n])*(?:"|(?=\r?$))/.source,
  variable: /\$(?:\{[^{}\r\n]*\}|[a-zA-Z_]\w*|[\d#?@*!$])/.source,
  number: /\b\d+(?:\.\d+)?[smhdw]?\b/.source,
  operator: /[|&;()<>]/.source,
  word: /[-~./\p{L}_][-\p{L}\p{N}_./~]*/u.source,
});

const javascript = syntax({
  comment: C_COMMENT,
  string: [QUOTED, /`(?:\\[\s\S]|[^`\\])*(?:`|$)/.source].join("|"),
  keyword: words(
    "as async await break case catch class const continue declare default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of private protected public readonly return satisfies static super switch this throw true try type typeof undefined var void while yield",
  ),
  number: NUMBER,
  operator: OPERATOR,
});

const cFamily = syntax({
  comment: C_COMMENT,
  string: QUOTED,
  keyword: words(
    "abstract as async await break case catch class const continue default defer do else enum extends false fn for foreach func if import in int interface let match namespace new nil null package private protected pub public return static struct super switch this throw trait true try type use var void volatile while yield",
  ),
  number: NUMBER,
  operator: OPERATOR,
});

const python = syntax({
  comment: HASH_COMMENT,
  string: [/"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)/.source, QUOTED].join("|"),
  keyword: words(
    "False None True and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield",
  ),
  number: NUMBER,
  operator: OPERATOR,
});

const json = syntax({
  property: /"(?:\\[^\r\n]|[^"\\\r\n])*"(?=\s*:)/.source,
  string: DOUBLE_QUOTED,
  keyword: words("false null true"),
  number: NUMBER,
});

const yaml = syntax({
  comment: /(?<!\S)#[^\r\n]*/.source,
  property: /(?<![\w.-])[\w.-]+(?=:(?:\s|$))/.source,
  string: QUOTED,
  keyword: words("false null true"),
  number: NUMBER,
  operator: /[|&*>]/.source,
});

const sql = syntax(
  {
    comment: /--[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)/.source,
    string: /'(?:''|[^'])*'/.source,
    keyword: words(
      "alter and as asc begin between by case create delete desc distinct drop else end exists false from group having in insert into is join left like limit not null offset on or order returning right select set table then true union update values when where with",
    ),
    number: NUMBER,
    operator: OPERATOR,
  },
  true,
);

const markup = syntax({
  comment: /<!--[\s\S]*?(?:-->|$)/.source,
  tag: /<\/?[a-zA-Z][\w:-]*|\/?>/.source,
  property: /(?<![\w:-])[\w:-]+(?=\s*=)/.source,
  string: QUOTED,
});

const diff = syntax({
  comment: /^(?:@@|diff |index )[^\r\n]*/.source,
  added: /^\+[^\r\n]*/.source,
  removed: /^-[^\r\n]*/.source,
});

const syntaxByLanguage = new Map<string, RegExp>([
  ...["bash", "sh", "shell", "shell-session", "zsh", "fish"].map(
    (language) => [language, shell] as const,
  ),
  ...["js", "javascript", "jsx", "ts", "typescript", "tsx", "mjs", "cjs"].map(
    (language) => [language, javascript] as const,
  ),
  ...[
    "c",
    "cpp",
    "c++",
    "cs",
    "csharp",
    "go",
    "golang",
    "java",
    "kt",
    "kotlin",
    "rust",
    "rs",
    "swift",
  ].map((language) => [language, cFamily] as const),
  ["py", python],
  ["python", python],
  ["json", json],
  ["yaml", yaml],
  ["yml", yaml],
  ["sql", sql],
  ["html", markup],
  ["xml", markup],
  ["svg", markup],
  ["diff", diff],
  ["patch", diff],
]);

/** Colors a bounded code sample without altering its characters or producing HTML. */
export function highlightCode(source: string, language?: string): readonly CodeToken[] {
  const grammar = language ? syntaxByLanguage.get(language.trim().toLowerCase()) : undefined;
  if (!grammar || source.length > MAX_HIGHLIGHT_LENGTH) return [{ text: source }];

  const tokens: CodeToken[] = [];
  let end = 0;
  for (const match of source.matchAll(grammar)) {
    if (tokens.length >= MAX_HIGHLIGHT_TOKENS) return [{ text: source }];
    if (match.index > end) tokens.push({ text: source.slice(end, match.index) });
    const kind = Object.entries(match.groups ?? {}).find(([, value]) => value !== undefined)?.[0];
    tokens.push({ text: match[0], kind: kind as CodeHighlightKind | undefined });
    end = match.index + match[0].length;
  }
  if (end < source.length) tokens.push({ text: source.slice(end) });
  return tokens;
}
