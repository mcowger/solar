import {
	ActionBarPrimitive,
	AttachmentPrimitive,
	ComposerPrimitive,
	MessagePrimitive,
	ThreadPrimitive,
	useComposerRuntime,
	useAuiState,
} from "@assistant-ui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Brain,
	Ban,
	Bot,
	Camera,
	Check,
	ChevronDown,
	Copy,
	Cog,
	FileText,
	FileUp,
	Image,
	LoaderCircle,
	Plus,
	Podcast,
	Repeat2,
	Scissors,
	Send,
	Server,
	Square,
	SquarePen,
	X,
} from "lucide-react";
import {
	createContext,
	useContext,
	useEffect,
	useRef,
	useState,
	type RefObject,
} from "react";
import { useTRPC } from "../trpc";
import { buildAttachmentAccept } from "./attachmentAdapter";
import { MarkdownText, PlainMarkdown } from "./MarkdownText";
import type {
	SolarConnectionStatus,
	SolarSummaryEvent,
	SolarToolCall,
} from "./useSolarRuntime";
import "./Thread.css";

const EMPTY_TOOL_CALLS: SolarToolCall[] = [];
const DEFAULT_PASTE_SETTINGS = {
	enabled: true,
	lineThreshold: 20,
	byteThreshold: 5 * 1024,
};

/** Display name of the conversation's model, for the assistant identity row. */
const ModelNameContext = createContext<string | undefined>(undefined);

/** Format a message timestamp like "Today at 9:34 AM" / "Yesterday at …". */
function formatMessageTimestamp(iso?: string): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	const time = date.toLocaleTimeString(undefined, {
		hour: "numeric",
		minute: "2-digit",
	});
	const now = new Date();
	const startOfDay = (d: Date) =>
		new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
	if (dayDiff === 0) return `Today at ${time}`;
	if (dayDiff === 1) return `Yesterday at ${time}`;
	return `${date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	})} at ${time}`;
}

function addFiles(
	composer: NonNullable<ReturnType<typeof useComposerRuntime>>,
	input: HTMLInputElement,
) {
	const files = Array.from(input.files ?? []);
	input.value = "";
	void Promise.all(files.map((file) => composer.addAttachment(file))).catch(
		() => undefined,
	);
}

function openAttachmentInput(
	input: HTMLInputElement | null,
	kind: "desktop" | "mobile-file" | "capture" | "library",
) {
	if (!input) return;
	console.info("[attachments] opening picker", {
		kind,
		accept: input.accept,
	});
	input.click();
}

function DesktopAttachmentPicker({
	attachmentAccept,
	disabled,
}: {
	attachmentAccept: string;
	disabled: boolean;
}) {
	const composer = useComposerRuntime();
	const inputRef = useRef<HTMLInputElement>(null);

	return (
		<>
			<button
				type="button"
				className="btn btn-ghost btn-sm btn-circle hidden sm:inline-flex"
				aria-label="Add attachment"
				disabled={disabled}
				onClick={() => openAttachmentInput(inputRef.current, "desktop")}
			>
				<Plus size={20} />
			</button>
			<input
				ref={inputRef}
				className="hidden"
				type="file"
				accept={attachmentAccept}
				multiple
				onChange={(event) => addFiles(composer, event.currentTarget)}
			/>
		</>
	);
}

function MobileAttachmentPicker({
	attachmentAccept,
	disabled,
}: {
	attachmentAccept: string;
	disabled: boolean;
}) {
	const composer = useComposerRuntime();
	const captureInputRef = useRef<HTMLInputElement>(null);
	const libraryInputRef = useRef<HTMLInputElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const dialogRef = useRef<HTMLDialogElement>(null);

	const openInput = (
		inputRef: RefObject<HTMLInputElement | null>,
		kind: "mobile-file" | "capture" | "library",
	) => {
		dialogRef.current?.close();
		openAttachmentInput(inputRef.current, kind);
	};

	return (
		<>
			<button
				type="button"
				className="btn btn-ghost btn-sm btn-circle sm:hidden"
				aria-label="Add attachment"
				disabled={disabled}
				onClick={() => dialogRef.current?.showModal()}
			>
				<Plus size={20} />
			</button>
			<input
				ref={captureInputRef}
				className="hidden"
				type="file"
				accept="image/*"
				capture="environment"
				onChange={(event) => addFiles(composer, event.currentTarget)}
			/>
			<input
				ref={libraryInputRef}
				className="hidden"
				type="file"
				accept="image/*"
				multiple
				onChange={(event) => addFiles(composer, event.currentTarget)}
			/>
			<input
				ref={fileInputRef}
				className="hidden"
				type="file"
				accept={attachmentAccept}
				multiple
				onChange={(event) => addFiles(composer, event.currentTarget)}
			/>
			<dialog ref={dialogRef} className="modal modal-bottom sm:hidden">
				<div className="modal-box rounded-t-3xl p-3">
					<h2 className="px-3 pb-2 text-base font-semibold">Add attachment</h2>
					<ul className="menu w-full p-0">
						<li>
							<button
								type="button"
								className="min-h-12 text-base"
								onClick={() => openInput(captureInputRef, "capture")}
							>
								<Camera size={20} />
								Capture
							</button>
						</li>
						<li>
							<button
								type="button"
								className="min-h-12 text-base"
								onClick={() => openInput(libraryInputRef, "library")}
							>
								<Image size={20} />
								Library
							</button>
						</li>
						<li>
							<button
								type="button"
								className="min-h-12 text-base"
								onClick={() => openInput(fileInputRef, "mobile-file")}
							>
								<FileUp size={20} />
								File
							</button>
						</li>
					</ul>
					<form method="dialog" className="mt-2">
						<button type="submit" className="btn btn-block">
							Cancel
						</button>
					</form>
				</div>
				<form method="dialog" className="modal-backdrop">
					<button type="submit">close</button>
				</form>
			</dialog>
		</>
	);
}

export type ContextStatus = {
	state: string;
	estimatedTokens: number | null;
	summarized: boolean;
	jobError: string | null;
};

export function ContextStatusIndicator({ status }: { status?: ContextStatus }) {
	if (!status || (status.state === "idle" && !status.summarized)) return null;
	if (status.state === "running") {
		return (
			<span className="flex items-center gap-1 text-xs text-info">
				<span className="loading loading-spinner loading-xs" />
				Summarizing history...
			</span>
		);
	}
	if (status.state === "failed") {
		return (
			<span className="badge badge-error badge-xs">
				Summary failed{status.jobError ? `: ${status.jobError}` : ""}
			</span>
		);
	}
	return null;
}

/** Small image-or-icon chip for a single attachment (composer or message). */
function AttachmentChip({ removable }: { removable?: boolean }) {
	const attachment = useAuiState((s) => s.attachment);
	if (!attachment) return null;
	const imagePart =
		attachment.type === "image"
			? (attachment.content?.[0] as
					| { type: "image"; image: string }
					| undefined)
			: undefined;
	const downloadHref =
		!removable && attachment.id
			? `/api/attachments/${attachment.id}`
			: undefined;

	const body = (
		<>
			{imagePart ? (
				<img
					src={imagePart.image}
					alt={attachment.name}
					className="solar-attachment-thumb"
				/>
			) : (
				<span className="solar-attachment-icon">
					<FileText size={14} />
				</span>
			)}
			<span className="solar-attachment-name">
				<AttachmentPrimitive.Name />
			</span>
			{removable && (
				<AttachmentPrimitive.Remove
					className="solar-attachment-remove"
					aria-label="Remove attachment"
				>
					<X size={12} />
				</AttachmentPrimitive.Remove>
			)}
		</>
	);

	return (
		<AttachmentPrimitive.Root className="solar-attachment-chip">
			{downloadHref ? (
				<a
					className="solar-attachment-download"
					href={downloadHref}
					download={attachment.name}
					title={`Download ${attachment.name}`}
				>
					{body}
				</a>
			) : (
				body
			)}
		</AttachmentPrimitive.Root>
	);
}

/** Live-tailing, collapsible "Thinking" box for reasoning message parts. */
function Reasoning() {
	const text = useAuiState((s) =>
		s.part.type === "reasoning" ? s.part.text : "",
	);
	const isRunning = useAuiState((s) => s.part.status.type === "running");
	const [open, setOpen] = useState(isRunning);
	const bodyRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (open && bodyRef.current) {
			bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
		}
	}, [text, open]);

	if (!text) return null;

	return (
		<div className="solar-reasoning">
			<button
				type="button"
				className="solar-reasoning-toggle"
				onClick={() => setOpen((o) => !o)}
			>
				{isRunning ? "Thinking…" : "Thought"}
				<ChevronDown
					size={13}
					className={`solar-reasoning-caret${open ? " solar-reasoning-caret-open" : ""}`}
				/>
			</button>
			{open && (
				<div className="solar-reasoning-body" ref={bodyRef}>
					<PlainMarkdown text={text} />
				</div>
			)}
		</div>
	);
}

function ToolCalls() {
	const toolCalls = useAuiState(
		(s) =>
			(
				s.message.metadata?.custom as
					| { toolCalls?: SolarToolCall[] }
					| undefined
			)?.toolCalls ?? EMPTY_TOOL_CALLS,
	);

	if (!toolCalls.length) return null;

	return (
		<div className="solar-tool-calls">
			{toolCalls.map((call) => (
				<details
					key={call.id}
					className="solar-tool-call"
					open={call.status === "streaming" || call.status === "executing"}
				>
					<summary>
						<span
							className={`solar-tool-status solar-tool-status-${call.status}`}
						/>
						<span className="solar-tool-name">
							{call.serverName && call.remoteName
								? `${call.serverName} (${call.remoteName})`
								: call.name}
						</span>
						<span className="solar-tool-state">
							{call.status === "streaming"
								? "Preparing"
								: call.status === "executing"
									? "Running"
									: call.status === "error"
										? "Failed"
										: "Complete"}
						</span>
					</summary>
					<div className="solar-tool-call-details">
						<span>Input</span>
						<pre>{call.args || "{}"}</pre>
						{call.output !== undefined && (
							<>
								<span>{call.status === "error" ? "Error" : "Output"}</span>
								<pre>{call.output}</pre>
							</>
						)}
					</div>
				</details>
			))}
		</div>
	);
}

function formatTokens(tokens: number | null): string {
	if (tokens === null) return "Unknown";
	return new Intl.NumberFormat("en", {
		notation: tokens >= 1_000 ? "compact" : "standard",
		maximumFractionDigits: 1,
	}).format(tokens);
}

export function SummaryEventCard({ event }: { event: SolarSummaryEvent }) {
	const tokenStats = `${formatTokens(event.tokensBefore)} → ${formatTokens(event.tokensAfter)} tokens`;
	const reduction =
		event.tokensBefore && event.tokensAfter !== null
			? Math.max(
					0,
					Math.round(
						((event.tokensBefore - event.tokensAfter) / event.tokensBefore) *
							100,
					),
				)
			: null;

	return (
		<div className="solar-summary-event">
			<div className="card card-border card-xs bg-base-200 text-base-content">
				<div className="card-body flex-row items-center gap-3">
					<span className="grid size-7 shrink-0 place-items-center rounded-full bg-base-300 text-info">
						<Scissors size={14} />
					</span>
					<div className="min-w-0 flex-1">
						<div className="text-xs font-medium">Conversation summarized</div>
						<div className="mt-0.5 text-[11px] tabular-nums opacity-65">
							{tokenStats}
						</div>
					</div>
					{reduction !== null && (
						<span className="badge badge-sm whitespace-nowrap">
							{reduction}% smaller
						</span>
					)}
				</div>
			</div>
		</div>
	);
}

function SummaryEventMarker({ position }: { position: "before" | "after" }) {
	const event = useAuiState(
		(s) =>
			(
				s.message.metadata?.custom as
					| { summaryEvent?: SolarSummaryEvent }
					| undefined
			)?.summaryEvent,
	);
	return event?.position === position ? (
		<SummaryEventCard event={event} />
	) : null;
}

const REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const VERBOSITY_LEVELS = ["low", "medium", "high"] as const;

function SignalMeter({
	level,
	levels,
}: {
	level?: string | null;
	levels: readonly string[];
}) {
	const levelIndex = level ? levels.indexOf(level) : -1;
	const strength =
		levelIndex < 0 ? 0 : ((levelIndex + 1) / levels.length) * 100;

	return (
		<span
			className="solar-signal-meter"
			title={level ? `${level} strength` : "Provider default"}
			style={{
				position: "relative",
				width: 4,
				height: 14,
				overflow: "hidden",
				borderRadius: 2,
			}}
		>
			<span
				style={{
					position: "absolute",
					right: 0,
					bottom: 0,
					left: 0,
					height: `${strength}%`,
					background: "currentColor",
				}}
			/>
		</span>
	);
}

function UserMessage() {
	return (
		<>
			<SummaryEventMarker position="before" />
			<div className="solar-message solar-message-user">
				<MessagePrimitive.Attachments>
					{() => <AttachmentChip />}
				</MessagePrimitive.Attachments>
				<div className="solar-user-output">
					<MessagePrimitive.Content />
				</div>
				<ActionBarPrimitive.Root
					className="solar-actions"
					style={{ display: "flex", gap: 4 }}
				>
					<ActionBarPrimitive.Edit
						className="solar-action-btn"
						aria-label="Edit message"
					>
						<SquarePen size={16} />
					</ActionBarPrimitive.Edit>
					<ActionBarPrimitive.Copy
						className="solar-action-btn"
						aria-label="Copy message"
					>
						<MessagePrimitive.If copied>
							<Check size={16} />
						</MessagePrimitive.If>
						<MessagePrimitive.If copied={false}>
							<Copy size={16} />
						</MessagePrimitive.If>
					</ActionBarPrimitive.Copy>
				</ActionBarPrimitive.Root>
			</div>
			<SummaryEventMarker position="after" />
		</>
	);
}

function UserEditComposer() {
	return (
		<ComposerPrimitive.Root className="flex w-full max-w-[80%] self-end flex-col gap-1.5 rounded-xl bg-base-200 p-2 text-base-content">
			<ComposerPrimitive.Input
				className="textarea w-full resize-none border-base-300 bg-base-100 text-sm"
				unstable_insertNewlineOnTouchEnter
			/>
			<div className="flex justify-end gap-2">
				<ComposerPrimitive.Cancel className="btn btn-ghost btn-sm">
					Cancel
				</ComposerPrimitive.Cancel>
				<ComposerPrimitive.Send className="btn btn-primary btn-sm">
					Save & submit
				</ComposerPrimitive.Send>
			</div>
		</ComposerPrimitive.Root>
	);
}

function AssistantMessage() {
	const isEmpty = useAuiState((s) =>
		s.message.content.every((part) =>
			part.type === "text"
				? !part.text
				: part.type === "reasoning"
					? !part.text
					: true,
		),
	);
	const isRunning = useAuiState((s) => s.thread.isRunning);
	const connectionStatus = useAuiState(
		(s) =>
			(
				s.message.metadata?.custom as
					| { connectionStatus?: SolarConnectionStatus }
					| undefined
			)?.connectionStatus,
	);
	const staleTurn = useAuiState(
		(s) =>
			(
				s.message.metadata?.custom as
					| {
							isStale?: boolean;
							forceStop?: () => Promise<void>;
					  }
					| undefined
			)?.isStale,
	);
	const forceStop = useAuiState(
		(s) =>
			(
				s.message.metadata?.custom as
					| { forceStop?: () => Promise<void> }
					| undefined
			)?.forceStop,
	);
	const createdAt = useAuiState(
		(s) =>
			(s.message.metadata?.custom as { createdAt?: string } | undefined)
				?.createdAt,
	);
	const modelName = useContext(ModelNameContext) ?? "Assistant";
	const timestamp = formatMessageTimestamp(createdAt);

	return (
		<>
			<SummaryEventMarker position="before" />
			<div className="solar-message solar-message-assistant">
				<div className="solar-assistant-identity">
					<span className="solar-assistant-avatar">
						<Bot size={18} />
					</span>
					<span className="solar-assistant-name">{modelName}</span>
					{timestamp && (
						<span className="solar-assistant-timestamp">{timestamp}</span>
					)}
				</div>
				<ToolCalls />
				<div className="solar-assistant-output">
					{isEmpty ? (
						<EmptyAssistantResponse
							isRunning={isRunning}
							connectionStatus={connectionStatus}
							isStale={staleTurn}
							onForceStop={forceStop}
						/>
					) : (
						<MessagePrimitive.Content
							components={{ Text: MarkdownText, Reasoning }}
						/>
					)}
				</div>
				<ActionBarPrimitive.Root
					className="solar-actions"
					style={{ display: "flex", gap: 4 }}
				>
					<ActionBarPrimitive.Copy
						className="solar-action-btn"
						aria-label="Copy response"
					>
						<MessagePrimitive.If copied>
							<Check size={16} />
						</MessagePrimitive.If>
						<MessagePrimitive.If copied={false}>
							<Copy size={16} />
						</MessagePrimitive.If>
					</ActionBarPrimitive.Copy>
					<ActionBarPrimitive.Reload
						className="solar-action-btn"
						aria-label="Regenerate response"
					>
						<Repeat2 size={16} />
					</ActionBarPrimitive.Reload>
				</ActionBarPrimitive.Root>
			</div>
			<SummaryEventMarker position="after" />
		</>
	);
}

export function EmptyAssistantResponse({
	isRunning,
	connectionStatus,
	isStale = false,
	onForceStop,
}: {
	isRunning: boolean;
	connectionStatus?: SolarConnectionStatus;
	isStale?: boolean;
	onForceStop?: () => Promise<void>;
}) {
	const [forceStopHovered, setForceStopHovered] = useState(false);

	if (isStale && onForceStop) {
		return (
			<button
				type="button"
				className="btn btn-ghost btn-sm btn-square"
				title="Force stop response"
				onClick={() => void onForceStop()}
				onMouseEnter={() => setForceStopHovered(true)}
				onMouseLeave={() => setForceStopHovered(false)}
			>
				{forceStopHovered ? (
					<Ban className="text-error" size={18} />
				) : (
					<LoaderCircle className="solar-response-loader" size={18} />
				)}
			</button>
		);
	}

	if (isRunning) {
		return (
			<div className="flex items-center gap-2 text-sm text-base-content/60">
				<LoaderCircle className="solar-response-loader" size={18} />
				<span>
					{connectionStatus === "connecting" ? "Connecting…" : "Request sent…"}
				</span>
			</div>
		);
	}

	return (
		<div className="alert alert-soft alert-info text-sm">
			<span className="status status-info status-sm" />
			<span>The model returned an empty response.</span>
		</div>
	);
}

function GenerationControls({ conversationId }: { conversationId: string }) {
	const trpc = useTRPC();
	const qc = useQueryClient();
	const settings = useQuery(
		trpc.model.forConversation.queryOptions({ conversationId }),
	);
	const [open, setOpen] = useState<"reasoning" | "verbosity" | null>(null);
	const controlsRef = useRef<HTMLDivElement>(null);
	const update = useMutation(
		trpc.conversation.setGenerationSettings.mutationOptions({
			onSuccess: () => {
				qc.invalidateQueries({
					queryKey: trpc.model.forConversation.queryKey({ conversationId }),
				});
				setOpen(null);
			},
		}),
	);
	const data = settings.data;
	const showReasoning = Boolean(data?.reasoningLevels.length);
	const showVerbosity = Boolean(data?.supportsVerbosity);
	const reasoningEffort = data?.effectiveReasoningEffort;
	const verbosity = data?.effectiveVerbosity;

	useEffect(() => {
		if (!open) return;

		const dismiss = (event: PointerEvent) => {
			if (!controlsRef.current?.contains(event.target as Node)) setOpen(null);
		};

		document.addEventListener("pointerdown", dismiss);
		return () => document.removeEventListener("pointerdown", dismiss);
	}, [open]);

	if (!showReasoning && !showVerbosity) return null;

	return (
		<div ref={controlsRef} style={{ display: "flex", gap: 4 }}>
			{showReasoning && (
				<div style={{ position: "relative" }}>
					<button
						type="button"
						onClick={() => setOpen(open === "reasoning" ? null : "reasoning")}
						className={`solar-tool-toggle${
							data?.reasoningEffort ? " solar-tool-toggle-active" : ""
						}`}
						title={`Reasoning effort: ${reasoningEffort ?? "default"}${data?.reasoningEffort ? "" : " (default)"}`}
					>
						<Brain size={18} />
						<SignalMeter
							level={reasoningEffort}
							levels={data?.reasoningLevels ?? REASONING_LEVELS}
						/>
					</button>
					{open === "reasoning" && (
						<div className="solar-generation-menu">
							<button
								type="button"
								onClick={() =>
									update.mutate({ id: conversationId, reasoningEffort: null })
								}
								className="solar-generation-menu-item"
							>
								Default
							</button>
							{data?.reasoningLevels.map((level) => (
								<button
									key={level}
									type="button"
									onClick={() =>
										update.mutate({
											id: conversationId,
											reasoningEffort: level,
										})
									}
									className="solar-generation-menu-item"
								>
									{level}
								</button>
							))}
						</div>
					)}
				</div>
			)}
			{showVerbosity && (
				<div style={{ position: "relative" }}>
					<button
						type="button"
						onClick={() => setOpen(open === "verbosity" ? null : "verbosity")}
						className={`solar-tool-toggle${
							data?.verbosity ? " solar-tool-toggle-active" : ""
						}`}
						title={`Answer verbosity: ${verbosity ?? "default"}${data?.verbosity ? "" : " (default)"}`}
					>
						<Podcast size={18} />
						<SignalMeter level={verbosity} levels={VERBOSITY_LEVELS} />
					</button>
					{open === "verbosity" && (
						<div className="solar-generation-menu">
							<button
								type="button"
								onClick={() =>
									update.mutate({ id: conversationId, verbosity: null })
								}
								className="solar-generation-menu-item"
							>
								Default
							</button>
							{VERBOSITY_LEVELS.map((level) => (
								<button
									key={level}
									type="button"
									onClick={() =>
										update.mutate({ id: conversationId, verbosity: level })
									}
									className="solar-generation-menu-item"
								>
									{level}
								</button>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function McpControls({
	conversationId,
	onConfigure,
}: {
	conversationId: string;
	onConfigure: () => void;
}) {
	const trpc = useTRPC();
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	const controlsRef = useRef<HTMLDivElement>(null);
	const settings = useQuery(
		trpc.mcp.forConversation.queryOptions({ conversationId }),
	);
	const invalidate = () =>
		qc.invalidateQueries({
			queryKey: trpc.mcp.forConversation.queryKey({ conversationId }),
		});
	const setServer = useMutation(
		trpc.mcp.setConversation.mutationOptions({ onSuccess: invalidate }),
	);
	const setAuto = useMutation(
		trpc.mcp.setAutoExecute.mutationOptions({ onSuccess: invalidate }),
	);

	useEffect(() => {
		if (!open) return;

		const dismiss = (event: PointerEvent) => {
			if (!controlsRef.current?.contains(event.target as Node)) setOpen(false);
		};

		document.addEventListener("pointerdown", dismiss);
		return () => document.removeEventListener("pointerdown", dismiss);
	}, [open]);

	if (!settings.data) return null;
	const mcpActive = settings.data.servers.some((server) => server.enabled);
	return (
		<div ref={controlsRef} className="relative">
			<button
				type="button"
				className={`solar-tool-toggle${
					mcpActive ? " solar-tool-toggle-active" : ""
				}`}
				title="MCP tools"
				onClick={() => setOpen((value) => !value)}
			>
				<Server size={18} />
			</button>
			{open && (
				<div className="absolute bottom-11 left-0 z-10 w-64 rounded-box bg-base-100 p-3 shadow-lg ring-1 ring-base-300">
					<div className="mb-3 flex items-center justify-between gap-3">
						<span className="text-sm font-medium">MCP tools</span>
						<button
							type="button"
							className="btn btn-ghost btn-xs btn-square"
							title="Configure MCP servers"
							onClick={() => {
								setOpen(false);
								onConfigure();
							}}
						>
							<Cog size={16} />
						</button>
					</div>
					{settings.data.servers.length ? (
						<>
							<label className="mb-3 flex items-center justify-between gap-3 text-sm font-medium">
								Run MCP tools automatically
								<input
									className="toggle toggle-primary toggle-sm checked:border-primary checked:bg-primary checked:text-primary-content"
									type="checkbox"
									checked={settings.data.autoExecuteTools}
									disabled={setAuto.isPending}
									onChange={(event) =>
										setAuto.mutate({
											conversationId,
											enabled: event.target.checked,
										})
									}
								/>
							</label>
							<div className="divide-y divide-base-300">
								{settings.data.servers.map((server) => (
									<label
										key={server.id}
										className="flex items-center justify-between gap-3 py-2 text-sm"
									>
										<span className="truncate">{server.name}</span>
										<input
											className="toggle toggle-primary toggle-sm checked:border-primary checked:bg-primary checked:text-primary-content"
											type="checkbox"
											checked={server.enabled}
											disabled={setServer.isPending}
											onChange={(event) =>
												setServer.mutate({
													conversationId,
													serverId: server.id,
													enabled: event.target.checked,
												})
											}
										/>
									</label>
								))}
							</div>
						</>
					) : (
						<p className="text-sm opacity-60">No MCP servers configured.</p>
					)}
				</div>
			)}
		</div>
	);
}

/** assistant-ui thread surface (M2): markdown/code/LaTeX, edit & regenerate. */
export function Thread({
	conversationId,
	onConfigureMcp,
	contextStatus,
}: {
	conversationId: string;
	onConfigureMcp: () => void;
	contextStatus?: ContextStatus;
}) {
	const composer = useComposerRuntime();
	const trpc = useTRPC();
	const model = useQuery(
		trpc.model.forConversation.queryOptions({ conversationId }),
	);
	const modelName = model.data?.name ?? model.data?.modelId;
	const attachmentAccept = buildAttachmentAccept(
		model.data?.vision ?? false,
		model.data?.documentMimeTypes ?? [],
		model.data?.documents ?? false,
	);
	const pasteSettings = useQuery(trpc.pasteSettings.queryOptions());
	const pasteThresholds = pasteSettings.data ?? DEFAULT_PASTE_SETTINGS;
	const [pasteError, setPasteError] = useState<string | null>(null);
	const composerRef = useRef<HTMLDivElement>(null);
	const [composerHeight, setComposerHeight] = useState(88);

	// Keep the message list's bottom padding in sync with the floating composer
	// so the last line of a reply is never hidden behind it.
	useEffect(() => {
		const node = composerRef.current;
		if (!node) return;
		const observer = new ResizeObserver(() => {
			setComposerHeight(node.offsetHeight);
		});
		observer.observe(node);
		setComposerHeight(node.offsetHeight);
		return () => observer.disconnect();
	}, []);

	const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
		setPasteError(null);
		if (!pasteThresholds.enabled || event.clipboardData.files.length > 0)
			return;
		const text = event.clipboardData.getData("text/plain");
		if (!text || !shouldConvertPastedText(text, pasteThresholds)) return;

		event.preventDefault();
		const input = event.currentTarget;
		const currentText = input.value;
		const start = input.selectionStart ?? currentText.length;
		const end = input.selectionEnd ?? start;
		const file = new File([text], createPastedTextFileName(), {
			type: "text/plain",
		});
		void composer.addAttachment(file).catch((error: unknown) => {
			const message = error instanceof Error ? error.message : "Upload failed";
			composer.setText(
				currentText.slice(0, start) + text + currentText.slice(end),
			);
			setPasteError(message);
		});
	};

	return (
		<ModelNameContext.Provider value={modelName}>
			<ThreadPrimitive.Root
				style={{ position: "relative", height: "100%", minHeight: 0 }}
			>
				<ThreadPrimitive.Viewport
					style={{
						height: "100%",
						overflowY: "auto",
						overscrollBehaviorY: "contain",
						paddingTop: "1rem",
						paddingLeft: "1rem",
						paddingRight: "1rem",
						paddingBottom: composerHeight + 16,
						display: "flex",
						flexDirection: "column",
						gap: 12,
					}}
				>
					<ThreadPrimitive.Messages
						components={{
							UserMessage,
							UserEditComposer,
							AssistantMessage,
						}}
					/>
				</ThreadPrimitive.Viewport>

				<div ref={composerRef} className="solar-composer-dock">
					<ComposerPrimitive.Root className="solar-composer">
						<ComposerPrimitive.Attachments>
							{() => <AttachmentChip removable />}
						</ComposerPrimitive.Attachments>
						<ComposerPrimitive.Queue>
							{({ queueItem }) => (
								<span className="badge badge-info badge-sm self-start">
									Queued: {queueItem.prompt}
								</span>
							)}
						</ComposerPrimitive.Queue>
						<ContextStatusIndicator status={contextStatus} />
						{pasteError && (
							<div
								role="alert"
								className="alert alert-error alert-soft text-sm"
							>
								{pasteError}
							</div>
						)}
						<ComposerPrimitive.Input
							placeholder="Send a Message"
							className="textarea textarea-ghost max-h-48 min-h-11 w-full resize-none bg-transparent px-2 py-1.5 focus:outline-none"
							unstable_insertNewlineOnTouchEnter
							onPaste={handlePaste}
						/>
						<div className="flex items-center justify-between gap-2">
							<div className="flex items-center gap-1">
								<DesktopAttachmentPicker
									attachmentAccept={attachmentAccept}
									disabled={!model.data}
								/>
								<MobileAttachmentPicker
									attachmentAccept={attachmentAccept}
									disabled={!model.data}
								/>
								<div className="solar-composer-divider" />
								<GenerationControls conversationId={conversationId} />
								<McpControls
									conversationId={conversationId}
									onConfigure={onConfigureMcp}
								/>
							</div>
							<div className="flex items-center gap-1">
								<ThreadPrimitive.If running>
									<ComposerPrimitive.Cancel
										className="btn btn-error btn-sm btn-circle"
										title="Interrupt response"
									>
										<Square size={16} />
									</ComposerPrimitive.Cancel>
								</ThreadPrimitive.If>
								<ThreadPrimitive.If running={false}>
									<ComposerPrimitive.Send
										className="btn btn-primary btn-sm btn-circle"
										title="Send or queue message"
									>
										<Send size={18} />
									</ComposerPrimitive.Send>
								</ThreadPrimitive.If>
							</div>
						</div>
					</ComposerPrimitive.Root>
				</div>
			</ThreadPrimitive.Root>
		</ModelNameContext.Provider>
	);
}

export function shouldConvertPastedText(
	text: string,
	settings: { lineThreshold: number; byteThreshold: number },
): boolean {
	const lineCount = text.split(/\r\n|\r|\n/).length;
	const byteCount = new TextEncoder().encode(text).byteLength;
	return (
		lineCount > settings.lineThreshold || byteCount > settings.byteThreshold
	);
}

function createPastedTextFileName(): string {
	const stamp = new Date()
		.toISOString()
		.replace(/[-:]/g, "")
		.replace("T", "-")
		.replace(/\.\d{3}Z$/, "");
	return `pasted-text-${stamp}.txt`;
}
