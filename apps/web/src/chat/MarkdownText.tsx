import {
  MarkdownTextPrimitive,
  rewriteLatexBracketDelimiters,
  type SyntaxHighlighterProps,
} from "@assistant-ui/react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

function CodeHighlighter({ language, code }: SyntaxHighlighterProps) {
  return (
    <SyntaxHighlighter
      language={language}
      style={oneLight}
      customStyle={{ margin: 0, borderRadius: 8, fontSize: 13 }}
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
  return (
    <MarkdownTextPrimitive
      // Convert `\[…\]` / `\(…\)` to `$$…$$` / `$…$` before markdown parsing,
      // so KaTeX sees the math (markdown would otherwise escape the brackets).
      preprocess={rewriteLatexBracketDelimiters}
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{ SyntaxHighlighter: CodeHighlighter }}
    />
  );
}
