import {
  MarkdownTextPrimitive,
  rewriteLatexBracketDelimiters,
  type SyntaxHighlighterProps,
} from "@assistant-ui/react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { useEffect, useState } from "react";
import "katex/dist/katex.min.css";

function isDarkTheme() {
  const colorScheme = getComputedStyle(document.documentElement).colorScheme;
  return colorScheme.includes("dark") || (
    colorScheme === "normal" && window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function useDarkTheme() {
  const [dark, setDark] = useState(isDarkTheme);

  useEffect(() => {
    const root = document.documentElement;
    const update = () => setDark(isDarkTheme());
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return dark;
}

function CodeHighlighter({ dark, language, code }: SyntaxHighlighterProps & { dark: boolean }) {
  return (
    <SyntaxHighlighter
      language={language}
      style={dark ? oneDark : oneLight}
      customStyle={{
        margin: 0,
        borderRadius: 8,
        fontSize: 13,
        background: "var(--color-base-300)",
        color: "var(--color-base-content)",
      }}
    >
      {code}
    </SyntaxHighlighter>
  );
}

/**
 * Assistant message body rendered as Markdown: GFM tables/lists, fenced code
 * with Prism highlighting, and LaTeX math via KaTeX (`$…$` / `$$…$$`).
 */
export function MarkdownText() {
  const dark = useDarkTheme();

  return (
    <MarkdownTextPrimitive
      key={dark ? "dark" : "light"}
      className="prose prose-sm max-w-none"
      // Convert `\[…\]` / `\(…\)` to `$$…$$` / `$…$` before markdown parsing,
      // so KaTeX sees the math (markdown would otherwise escape the brackets).
      preprocess={rewriteLatexBracketDelimiters}
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        SyntaxHighlighter: (props) => <CodeHighlighter {...props} dark={dark} />,
      }}
    />
  );
}
