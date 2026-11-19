import { Tooltip } from "@base-ui/react/tooltip";
import { Check, CodeXml, Copy, TextWrap } from "lucide-react";
import { useMemo, useState, type ComponentProps } from "react";
import { highlightCode } from "./code-block-highlight";
import { useClipboardFeedback } from "./message-actions";
import "./code-block.css";

const codeBlockCopy = {
  "zh-CN": {
    plain: "纯文本",
    wrap: "自动换行",
    enableWrap: "启用自动换行",
    disableWrap: "关闭自动换行",
    copy: "复制代码",
    copied: "已复制",
    failed: "复制失败，请选中代码后复制",
  },
  "zh-Hant": {
    plain: "純文字",
    wrap: "自動換行",
    enableWrap: "啟用自動換行",
    disableWrap: "關閉自動換行",
    copy: "複製程式碼",
    copied: "已複製",
    failed: "複製失敗，請選取程式碼後複製",
  },
  "en-US": {
    plain: "Plain text",
    wrap: "Word wrap",
    enableWrap: "Enable word wrap",
    disableWrap: "Disable word wrap",
    copy: "Copy code",
    copied: "Copied",
    failed: "Could not copy. Select the code to copy it.",
  },
  "ja-JP": {
    plain: "プレーンテキスト",
    wrap: "行の折り返し",
    enableWrap: "行の折り返しを有効にする",
    disableWrap: "行の折り返しを無効にする",
    copy: "コードをコピー",
    copied: "コピーしました",
    failed: "コピーできませんでした。コードを選択してコピーしてください。",
  },
};

const languageLabels = new Map([
  ["bash", "Bash"],
  ["sh", "Shell"],
  ["shell", "Shell"],
  ["shell-session", "Shell"],
  ["zsh", "Zsh"],
  ["fish", "Fish"],
  ["js", "JavaScript"],
  ["javascript", "JavaScript"],
  ["mjs", "JavaScript"],
  ["cjs", "JavaScript"],
  ["ts", "TypeScript"],
  ["typescript", "TypeScript"],
  ["jsx", "JSX"],
  ["tsx", "TSX"],
  ["py", "Python"],
  ["python", "Python"],
  ["json", "JSON"],
  ["yaml", "YAML"],
  ["yml", "YAML"],
  ["html", "HTML"],
  ["css", "CSS"],
  ["sql", "SQL"],
  ["xml", "XML"],
  ["svg", "SVG"],
  ["c", "C"],
  ["cpp", "C++"],
  ["c++", "C++"],
  ["cs", "C#"],
  ["csharp", "C#"],
  ["go", "Go"],
  ["golang", "Go"],
  ["java", "Java"],
  ["kt", "Kotlin"],
  ["kotlin", "Kotlin"],
  ["rs", "Rust"],
  ["rust", "Rust"],
  ["swift", "Swift"],
  ["diff", "Diff"],
  ["patch", "Diff"],
]);
const plainLanguages = new Set(["plain", "plaintext", "text", "txt"]);

function CodeBlockButton({
  label,
  hint,
  ...props
}: ComponentProps<"button"> & {
  label: string;
  hint: string;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        type="button"
        aria-label={label}
        className="session-code-block-button"
        {...props}
      />
      <Tooltip.Portal>
        <Tooltip.Positioner side="top" sideOffset={5} className="isolate z-[100]">
          <Tooltip.Popup
            role="tooltip"
            className="max-w-xs rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
          >
            {hint}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function CodeBlock({
  source,
  language,
  locale,
}: {
  source: string;
  language?: string;
  locale: string;
}) {
  const words = codeBlockCopy[locale as keyof typeof codeBlockCopy] ?? codeBlockCopy["en-US"];
  const [wrap, setWrap] = useState(true);
  const { feedback, copyText } = useClipboardFeedback();
  const tokens = useMemo(() => highlightCode(source, language), [source, language]);
  const languageKey = language?.toLowerCase();
  const label =
    languageKey && !plainLanguages.has(languageKey)
      ? (languageLabels.get(languageKey) ?? language)
      : words.plain;

  return (
    <div className="session-code-block">
      <div className="session-code-block-toolbar">
        <div className="session-code-block-language">
          <CodeXml size={16} aria-hidden="true" />
          <span>{label}</span>
        </div>
        <div className="session-code-block-actions">
          <CodeBlockButton
            label={words.wrap}
            hint={wrap ? words.disableWrap : words.enableWrap}
            aria-pressed={wrap}
            onClick={() => setWrap(!wrap)}
          >
            <TextWrap size={16} aria-hidden="true" />
          </CodeBlockButton>
          <CodeBlockButton
            label={words.copy}
            hint={feedback === "copied" ? words.copied : words.copy}
            onClick={() => void copyText(source)}
          >
            {feedback === "copied" ? (
              <Check size={16} aria-hidden="true" />
            ) : (
              <Copy size={16} aria-hidden="true" />
            )}
          </CodeBlockButton>
        </div>
      </div>
      <span
        role="status"
        className={feedback === "failed" ? "session-code-block-error" : "sr-only"}
      >
        {feedback ? words[feedback] : ""}
      </span>
      <pre className="session-code-block-content" data-wrap={wrap}>
        <code className={language && `language-${language}`}>
          {tokens.map(({ kind, text }, index) =>
            kind ? (
              <span key={index} data-syntax={kind}>
                {text}
              </span>
            ) : (
              text
            ),
          )}
        </code>
      </pre>
    </div>
  );
}
