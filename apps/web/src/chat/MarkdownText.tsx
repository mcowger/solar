import {
	MarkdownTextPrimitive,
	rewriteLatexBracketDelimiters,
	type SyntaxHighlighterProps,
} from "@assistant-ui/react-markdown";
import { useAuiState } from "@assistant-ui/react";
import { ChevronRight } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
	oneDark,
	oneLight,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "../trpc";
import "katex/dist/katex.min.css";

type Citation = {
	title: string;
	url: string;
	domain: string;
	favicon: string;
};

const SOURCE_BLOCK =
	/(^|\n\n)(?:\*\*|__)?Sources?:(?:\*\*|__)?\s*([\s\S]*?)(?=\n\n|$)/gi;
const MARKDOWN_LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const TRAILING_CITATION = /\s+(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))\s*$/;
const MAX_VISIBLE_FAVICONS = 3;

function citationFromLink(title: string, href: string) {
	try {
		const url = new URL(href);
		return {
			title,
			url: url.href,
			domain: url.hostname.replace(/^www\./, ""),
			favicon: `${url.origin}/favicon.ico`,
		};
	} catch {
		return null;
	}
}

export function citationsFrom(text: string) {
	const citations: Citation[] = [];

	for (const block of text.matchAll(SOURCE_BLOCK)) {
		const sourceText = block[2];
		if (!sourceText) continue;

		for (const link of sourceText.matchAll(MARKDOWN_LINK)) {
			const title = link[1];
			const href = link[2];
			if (!title || !href) continue;

			const citation = citationFromLink(title, href);
			if (citation) citations.push(citation);
		}
	}

	const trailingCitation = text
		.replace(SOURCE_BLOCK, "")
		.match(TRAILING_CITATION);
	const title = trailingCitation?.[2];
	const href = trailingCitation?.[3];
	if (title && href) {
		const citation = citationFromLink(title, href);
		if (citation) citations.push(citation);
	}

	return citations;
}

export function removeCitationBlocks(text: string) {
	const withoutSourceBlocks = text.replace(SOURCE_BLOCK, (block, leading) =>
		citationsFrom(block).length ? leading : block,
	);
	return withoutSourceBlocks.replace(TRAILING_CITATION, "");
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

function CitationSources({
	citations,
	categories,
}: {
	citations: Citation[];
	categories: Map<string, string>;
}) {
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
				<ChevronRight size={16} className="solar-citation-caret" />
			</summary>
			<ol className="solar-citation-list">
				{citations.map((citation, index) => (
					<li key={`${citation.url}-${index}`}>
						<span className="solar-source-number">{index + 1}</span>
						<SourceFavicon citation={citation} />
						<a href={citation.url} target="_blank" rel="noreferrer">
							<span>{citation.title}</span>
							<small>{citation.domain}</small>
							{categories.has(citation.domain) && (
								<span className="badge badge-ghost badge-xs">
									{categories.get(citation.domain)}
								</span>
							)}
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
 * Lightweight Markdown renderer for plain strings (e.g. reasoning/"Thought"
 * content) so bold/lists/etc. render instead of leaking literal `**` markers.
 */
export function PlainMarkdown({ text }: { text: string }) {
	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm, remarkMath]}
			rehypePlugins={[rehypeKatex]}
		>
			{rewriteLatexBracketDelimiters(text)}
		</ReactMarkdown>
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
	const trpc = useTRPC();
	const { data: sourceCategories } = useQuery({
		...trpc.sourceCategories.queryOptions({
			urls: citations.map((citation) => citation.url),
		}),
		enabled: citations.length > 0,
	});
	const categories = new Map(
		sourceCategories?.map(({ domain, category }) => [domain, category]),
	);

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
			<CitationSources citations={citations} categories={categories} />
		</>
	);
}
