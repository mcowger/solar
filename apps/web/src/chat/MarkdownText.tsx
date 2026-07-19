import {
	MarkdownTextPrimitive,
	rewriteLatexBracketDelimiters,
	type SyntaxHighlighterProps,
} from "@assistant-ui/react-markdown";
import { useAuiState } from "@assistant-ui/react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
	oneDark,
	oneLight,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { useEffect, useState } from "react";
import "katex/dist/katex.min.css";

type Citation = {
	title: string;
	url: string;
	domain: string;
	favicon: string;
};

const SOURCE_BLOCK =
	/(^|\n\n)(?:\*\*|__)?Sources:(?:\*\*|__)?\s*([\s\S]*?)(?=\n\n|$)/gi;
const MARKDOWN_LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const MAX_VISIBLE_FAVICONS = 3;

function citationsFrom(text: string) {
	const citations: Citation[] = [];

	for (const block of text.matchAll(SOURCE_BLOCK)) {
		const sourceText = block[2];
		if (!sourceText) continue;

		for (const link of sourceText.matchAll(MARKDOWN_LINK)) {
			const title = link[1];
			const href = link[2];
			if (!title || !href) continue;

			try {
				const url = new URL(href);
				citations.push({
					title,
					url: url.href,
					domain: url.hostname.replace(/^www\./, ""),
					favicon: `${url.origin}/favicon.ico`,
				});
			} catch {
				continue;
			}
		}
	}

	return citations;
}

function removeCitationBlocks(text: string) {
	return text.replace(SOURCE_BLOCK, (block, leading) =>
		citationsFrom(block).length ? leading : block,
	);
}

function SourceFavicon({ citation }: { citation: Citation }) {
	return (
		<span className="solar-source-favicon" title={citation.domain}>
			<span>{citation.domain[0]?.toUpperCase()}</span>
			<img
				src={citation.favicon}
				alt=""
				onError={(event) => {
					event.currentTarget.hidden = true;
				}}
			/>
		</span>
	);
}

function CitationSources({ citations }: { citations: Citation[] }) {
	if (!citations.length) return null;

	const visibleCitations = citations.slice(0, MAX_VISIBLE_FAVICONS);
	const hiddenCitationCount = citations.length - visibleCitations.length;

	return (
		<details className="solar-citation-sources">
			<summary>
				<span className="solar-source-favicon-stack">
					{visibleCitations.map((citation, index) => (
						<SourceFavicon
							key={`${citation.url}-${index}`}
							citation={citation}
						/>
					))}
					{hiddenCitationCount > 0 && (
						<span className="solar-source-overflow">
							+{hiddenCitationCount}
						</span>
					)}
				</span>
				<span>
					{citations.length} {citations.length === 1 ? "Source" : "Sources"}
				</span>
			</summary>
			<ol className="solar-citation-list">
				{citations.map((citation, index) => (
					<li key={`${citation.url}-${index}`}>
						<span className="solar-source-number">{index + 1}</span>
						<SourceFavicon citation={citation} />
						<a href={citation.url} target="_blank" rel="noreferrer">
							<span>{citation.title}</span>
							<small>{citation.domain}</small>
						</a>
					</li>
				))}
			</ol>
		</details>
	);
}

function isDarkTheme() {
	const colorScheme = getComputedStyle(document.documentElement).colorScheme;
	return (
		colorScheme.includes("dark") ||
		(colorScheme === "normal" &&
			window.matchMedia("(prefers-color-scheme: dark)").matches)
	);
}

function useDarkTheme() {
	const [dark, setDark] = useState(isDarkTheme);

	useEffect(() => {
		const root = document.documentElement;
		const update = () => setDark(isDarkTheme());
		const observer = new MutationObserver(update);
		observer.observe(root, {
			attributes: true,
			attributeFilter: ["data-theme"],
		});
		return () => observer.disconnect();
	}, []);

	return dark;
}

function CodeHighlighter({
	dark,
	language,
	code,
}: SyntaxHighlighterProps & { dark: boolean }) {
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
	const text = useAuiState((s) => (s.part.type === "text" ? s.part.text : ""));
	const citations = citationsFrom(text);

	return (
		<>
			<MarkdownTextPrimitive
				key={dark ? "dark" : "light"}
				className="prose prose-sm max-w-none"
				// Convert `\[…\]` / `\(…\)` to `$$…$$` / `$…$` before markdown parsing,
				// so KaTeX sees the math (markdown would otherwise escape the brackets).
				preprocess={(value) =>
					rewriteLatexBracketDelimiters(removeCitationBlocks(value))
				}
				remarkPlugins={[remarkGfm, remarkMath]}
				rehypePlugins={[rehypeKatex]}
				components={{
					SyntaxHighlighter: (props) => (
						<CodeHighlighter {...props} dark={dark} />
					),
				}}
			/>
			<CitationSources citations={citations} />
		</>
	);
}
