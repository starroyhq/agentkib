import { fileURLToPath } from "node:url";

/**
 * 从 agent 输出的 markdown 中提取链接和图片的目标地址，用于在会话里找出可预览的产物。
 *
 * runtime 的会话事件只有纯文本 content，没有结构化的链接字段，所以只能解析 markdown。
 * 这里不追求完整的 CommonMark：只处理 `[text](target)`、`![alt](target)`、`<target>`
 * 形式的尖括号目标、可选标题，以及目标里一层成对的括号。代码块和行内代码中的内容会被
 * 跳过，避免把示例代码里的路径当成产物。返回值只是候选，调用方仍需按授权范围逐个校验。
 */
export function markdownLinkTargets(content: string): string[] {
  return [...prose(content).matchAll(LINK)].flatMap((match) => {
    const target = match[1] ?? match[2];
    return target ? [target] : [];
  });
}

/**
 * 回复里提到的文件：Markdown 链接的本地目标，加上行内代码里像文件路径的文字。
 *
 * Codex 习惯写 `[app.py](/abs/app.py:12)`，Claude Code 多用行内代码写 `src/app.py:12`，
 * 所以两种都收。候选按在正文里出现的顺序排列，经 fileReferencePath 整理后去重。
 * 围栏代码块里的内容不收：那多是示例或命令输出。
 */
export function fileReferenceTargets(content: string): string[] {
  const found: { index: number; target: string }[] = [];
  const links = [...prose(content).matchAll(LINK)];
  for (const match of links) {
    const target = match[1] ?? match[2];
    if (target) found.push({ index: match.index, target });
  }
  // prose() 把行内代码换成等长空格，两份文本的位置一一对应。
  // 链接文字里的行内代码（`[`a.md`](out/a.md)`）以链接目标为准，不单独算。
  for (const match of withoutFences(content).matchAll(CODE_SPAN)) {
    const code = match[2]!.trim();
    const inLink = links.some(
      (link) => match.index >= link.index && match.index < link.index + link[0].length,
    );
    if (!inLink && looksLikeFilePath(code)) found.push({ index: match.index, target: code });
  }
  return [
    ...new Set(
      found
        .sort((left, right) => left.index - right.index)
        .flatMap(({ target }) => fileReferencePath(target) ?? []),
    ),
  ];
}

/**
 * 把 agent 写出的一个文件引用整理成路径：`file://` 地址转成本机路径，去掉行列号后缀
 * （`:12`、`:12:3`、`#L12C3-L20`）和开头的 `./`。网址、其他协议和页内锚点返回 undefined。
 */
export function fileReferencePath(reference: string): string | undefined {
  let path = reference.trim();
  if (path.startsWith("<") && path.endsWith(">")) path = path.slice(1, -1).trim();
  path = withoutLocation(path);
  if (/^file:/i.test(path)) {
    try {
      path = fileURLToPath(path);
    } catch {
      return undefined;
    }
  } else if (SCHEME.test(path)) return undefined;
  path = path.replace(/^(?:\.\/)+/, "");
  return path && !path.startsWith("#") && !path.startsWith("?") ? path : undefined;
}

/**
 * 行内代码像不像文件路径。只决定要不要把它当作候选：判断错了顶多多查一次或少一个链接，
 * 能否读取仍由主机按授权根目录逐个校验。带 `/` 的要有扩展名或常见的无扩展名文件名；
 * 不带 `/` 的只认常见扩展名，免得把版本号、域名和模型名当成文件。
 * 隐藏目录和 node_modules 里的文件主机不提供预览，这里也不收。
 */
export function looksLikeFilePath(text: string): boolean {
  if (/^file:\/\//i.test(text)) return true;
  const path = withoutLocation(text).replace(/^(?:\.\/)+/, "");
  if (
    !path ||
    path.length > 1024 ||
    /[\s*?<>|"'(){}$=;,`\\]/.test(path) ||
    /^[-~@]/.test(path) ||
    SCHEME.test(path)
  )
    return false;
  const parts = path.split("/");
  const name = parts.at(-1)!;
  if (
    !name ||
    parts.some(
      (part, index) =>
        (!part && index > 0) ||
        (part.startsWith(".") && part !== "." && part !== "..") ||
        part === "node_modules",
    )
  )
    return false;
  if (FILE_NAMES.has(name)) return true;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  const extension = name.slice(dot + 1).toLowerCase();
  if (parts.length > 1) return /^[a-z0-9]{1,10}$/.test(extension) && /[a-z]/.test(extension);
  // `console.log`、`res.json` 这类是代码，不是文件。
  return FILE_EXTENSIONS.has(extension) && !CODE_RECEIVERS.has(name.slice(0, dot).toLowerCase());
}

// 目标允许一层成对括号，例如 `report(1).png`；标题支持双引号、单引号和括号三种写法。
const LINK =
  /!?\[(?:[^\]\\]|\\.)*\]\(\s*(?:<([^<>\n]+)>|((?:[^\s()\\]|\\.|\([^\s()]*\))+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
// 成对的等长反引号；内容里不能有反引号或换行，路径本来也不会有。
const CODE_SPAN = /(?<!`)(`+)(?!`)([^`\n]+?)\1(?!`)/g;
// 至少两个字符，Windows 盘符（`C:`）不算协议。
const SCHEME = /^[a-z][a-z0-9+.-]+:/i;
const FILE_NAMES = new Set(
  "Makefile Dockerfile Containerfile Justfile Procfile Gemfile Rakefile Podfile Brewfile Vagrantfile LICENSE LICENCE README CHANGELOG NOTICE AUTHORS".split(
    " ",
  ),
);
const FILE_EXTENSIONS = new Set(
  [
    // 文档与数据
    "md markdown mdx txt log rst adoc json jsonl ndjson csv tsv xml yaml yml toml ini cfg conf",
    "sql graphql proto lock patch diff plist arb",
    // 网页与代码
    "html htm css scss sass less svg vue svelte astro js mjs cjs jsx ts mts cts tsx",
    "py ipynb rb go rs java kt kts swift m mm c h cc cpp hpp cs php lua dart scala",
    "ex exs erl hs clj r jl pl sh bash zsh fish ps1 bat gradle",
    // 图片与音视频
    "png jpg jpeg gif webp avif bmp ico heic tif tiff",
    "mp4 m4v mov webm mkv avi mp3 m4a aac wav ogg flac opus",
    // 办公文档
    "pdf doc docx xls xlsx ppt pptx numbers pages rtf odt ods odp epub",
  ]
    .join(" ")
    .split(" "),
);
const CODE_RECEIVERS = new Set(
  "console res req response request this self window document process logger json math object array promise".split(
    " ",
  ),
);

/** 去掉编辑器风格的位置后缀：`:12`、`:12:3`、`:12-20`、`#L12`、`#L12C3-L20C1`。 */
function withoutLocation(path: string) {
  return path
    .replace(/#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/, "")
    .replace(/:\d+(?::\d+)?(?:-\d+(?::\d+)?)?$/, "");
}

/** 去掉围栏代码块，只保留其余各行。 */
function withoutFences(content: string): string {
  const lines: string[] = [];
  let fence: string | undefined;
  for (const line of content.split("\n")) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (fence) {
      // 只有同种字符、长度不短于开头的围栏才能闭合代码块。
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    } else if (marker) fence = marker;
    else lines.push(line);
  }
  return lines.join("\n");
}

/** 去掉围栏代码块和行内代码，只保留正文。行内代码换成等长空格，位置不变。 */
function prose(content: string): string {
  return withoutFences(content).replace(/(`+)[^`]*?\1/g, (code) => " ".repeat(code.length));
}
