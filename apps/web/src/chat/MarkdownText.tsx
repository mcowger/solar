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
import { type ComponentProps, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "../trpc";
import "katex/dist/katex.min.css";

type Citation = {
	title: string;
	url?: string;
	domain?: string;
	favicon?: string;
};

const SOURCE_BLOCK =
	/(^|\n\n)\[?(?:\*\*|__)?Sources?:(?:\*\*|__)?\s*([\s\S]*?)\]?(?=\n\n|$)/gi;
const MARKDOWN_LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL = /https?:\/\/[^\s)]+/g;
const DOMAIN = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/\S*)?$/i;
const MAX_VISIBLE_FAVICONS = 3;

function citationFromLink(title: string, href: string): Citation | null {
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

/** Parse a single comma/`and`-separated source token that is not a Markdown
 * link: either a bare domain (→ derived URL + favicon) or a plain-text name. */
function citationFromToken(token: string): Citation | null {
	const trimmed = token
		.replace(/^[-*•\s]+/, "")
		.replace(/[.,;]+$/, "")
		.trim();
	if (!trimmed || !/[a-z0-9]/i.test(trimmed)) return null;

	const domain = trimmed.match(DOMAIN)?.[1];
	if (domain) {
		const citation = citationFromLink(domain, `https://${domain}`);
		if (citation)
			return { ...citation, title: citation.domain ?? citation.title };
	}
	return { title: trimmed };
}

export function citationsFrom(text: string) {
	const citations: Citation[] = [];

	// Every external Markdown link anywhere in the message is a source, in
	// document order — one per occurrence. This also covers links that happen
	// to live inside a Sources: block.
	for (const link of text.matchAll(MARKDOWN_LINK)) {
		const citation = citationFromLink(link[1] ?? "", link[2] ?? "");
		if (citation) citations.push(citation);
	}

	// Within a Sources:/[Sources: …] block, also accept bare URLs and
	// plain-text/bare-domain source names that are not Markdown links.
	for (const block of text.matchAll(SOURCE_BLOCK)) {
		const sourceText = block[2];
		if (!sourceText) continue;

		const remaining = sourceText.replace(MARKDOWN_LINK, " ");

		for (const url of remaining.matchAll(BARE_URL)) {
			const citation = citationFromLink(url[0], url[0]);
			if (citation)
				citations.push({
					...citation,
					title: citation.domain ?? citation.title,
				});
		}

		for (const token of remaining
			.replace(BARE_URL, " ")
			.split(/[,;\n]|\sand\s/i)) {
			const citation = citationFromToken(token);
			if (citation) citations.push(citation);
		}
	}

	return citations;
}

/**
 * Strip dedicated `Sources:`/`[Sources: …]` footer blocks from the body (their
 * links surface as chips instead). Inline links elsewhere are intentionally
 * left in place — they render as compact source pills.
 */
export function removeCitationBlocks(text: string) {
	return text.replace(SOURCE_BLOCK, (block, leading) =>
		citationsFrom(block).length ? leading : block,
	);
}

function SourceFavicon({ citation }: { citation: Citation }) {
	const initial = (citation.domain ?? citation.title)[0]?.toUpperCase();
	return (
		<span
			className="solar-source-favicon"
			title={citation.domain ?? citation.title}
		>
			<span>{initial}</span>
			{citation.favicon && (
				<img
					src={citation.favicon}
					alt=""
					onError={(event) => {
						event.currentTarget.hidden = true;
					}}
				/>
			)}
		</span>
	);
}

/**
 * Markdown `a` override: external http(s) links render as a compact source
 * pill (favicon + link text); everything else renders as a plain link.
 */
function InlineSource({ href, children, ...props }: ComponentProps<"a">) {
	const citation = typeof href === "string" ? citationFromLink("", href) : null;
	if (!citation) {
		return (
			<a href={href} target="_blank" rel="noreferrer" {...props}>
				{children}
			</a>
		);
	}
	return (
		<a
			href={citation.url}
			target="_blank"
			rel="noreferrer"
			className="solar-inline-source"
			title={citation.domain}
		>
			<SourceFavicon citation={citation} />
			<span>{children}</span>
		</a>
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
							key={`${citation.url ?? citation.title}-${index}`}
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
				{citations.map((citation, index) => {
					const category = citation.domain
						? categories.get(citation.domain)
						: undefined;
					const body = (
						<>
							<span>{citation.title}</span>
							{(citation.domain || category) && (
								<span className="solar-citation-meta">
									{citation.domain && <small>{citation.domain}</small>}
									{category && (
										<span className="badge badge-ghost badge-xs">
											{category}
										</span>
									)}
								</span>
							)}
						</>
					);
					return (
						<li key={`${citation.url ?? citation.title}-${index}`}>
							<span className="solar-source-number">{index + 1}</span>
							<SourceFavicon citation={citation} />
							{citation.url ? (
								<a href={citation.url} target="_blank" rel="noreferrer">
									{body}
								</a>
							) : (
								<span>{body}</span>
							)}
						</li>
					);
				})}
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
			codeTagProps={{
				style: { background: "transparent", color: "inherit" },
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
	const citationUrls = citations
		.map((citation) => citation.url)
		.filter((url): url is string => Boolean(url));
	const { data: sourceCategories } = useQuery({
		...trpc.sourceCategories.queryOptions({ urls: citationUrls }),
		enabled: citationUrls.length > 0,
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
					a: InlineSource,
				}}
			/>
			<CitationSources citations={citations} categories={categories} />
		</>
	);
}
