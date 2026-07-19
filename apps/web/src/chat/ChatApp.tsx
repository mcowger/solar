import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
	Hash,
	LogOut,
	Menu,
	Settings2,
	SlidersHorizontal,
	SquarePen,
} from "lucide-react";
import { signOut, useSession } from "../auth";
import { useTRPC } from "../trpc";
import { ThemeToggle } from "../ThemeToggle";
import { Settings } from "../admin/Settings";
import { ModelPicker } from "./ModelPicker";
import { Presets } from "./Presets";
import { Sidebar } from "./Sidebar";
import { Thread } from "./Thread";
import { McpServers } from "./McpServers";
import { useSolarRuntime } from "./useSolarRuntime";

const SIDEBAR_DEFAULT_WIDTH = 280;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 480;
const PINNED_SIDEBAR_MEDIA_QUERY = "(min-width: 650px)";

function formatTokens(tokens: number) {
	return `${Math.round(tokens / 1_000)}k`;
}

function formatCost(costMicros: number) {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 2,
	}).format(costMicros / 1_000_000);
}

function ContextIndicator({ conversationId }: { conversationId: string }) {
	const trpc = useTRPC();
	const metrics = useQuery({
		...trpc.conversation.metrics.queryOptions({ conversationId }),
		refetchInterval: 5_000,
	});
	const data = metrics.data;
	if (!data || data.contextTokens === null) return null;

	const contextPercent = Math.min(
		100,
		Math.round((data.contextTokens / data.contextWindowTokens) * 100),
	);
	const compactionPercent = Math.min(
		100,
		Math.round((data.contextTokens / data.compactionAtTokens) * 100),
	);

	return (
		<div className="order-3 flex w-full basis-full shrink-0 items-center gap-2 min-[1101px]:order-2 min-[1101px]:w-auto min-[1101px]:basis-auto min-[1101px]:shrink min-[1101px]:flex-1 min-[1101px]:justify-end">
			<div className="min-w-0 flex-1 space-y-0.5 min-[1101px]:flex-none">
				<div className="flex items-center gap-1">
					<progress
						className="progress progress-primary h-1.5 w-full min-[1101px]:w-16"
						value={contextPercent}
						max="100"
						title={`${formatTokens(data.contextTokens)} of ${formatTokens(data.contextWindowTokens)} context`}
					/>
					<span className="font-mono text-[10px] text-base-content/70">
						{contextPercent}%
					</span>
					<span className="text-[10px] font-semibold uppercase text-base-content/50">
						CTX
					</span>
				</div>
				<div className="flex items-center gap-1">
					<progress
						className="progress progress-warning h-1.5 w-full min-[1101px]:w-16"
						value={compactionPercent}
						max="100"
						title={`${formatTokens(data.contextTokens)} of ${formatTokens(data.compactionAtTokens)} compaction threshold`}
					/>
					<span className="font-mono text-[10px] text-base-content/70">
						{compactionPercent}%
					</span>
					<span className="text-[10px] font-semibold uppercase text-base-content/50">
						Compact
					</span>
				</div>
			</div>
			<span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-base-content/70 min-[1101px]:text-[11px]">
				Cost: {formatCost(data.costMicros)}
			</span>
		</div>
	);
}

function ConversationView({
	conversationId,
	onConfigureMcp,
}: {
	conversationId: string;
	onConfigureMcp: () => void;
}) {
	const trpc = useTRPC();
	const current = useQuery(
		trpc.model.forConversation.queryOptions({ conversationId }),
	);
	const runtime = useSolarRuntime(
		conversationId,
		current.data?.vision ?? false,
		current.data?.documentMimeTypes ?? [],
	);
	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				<ModelPicker conversationId={conversationId} />
				<div className="min-h-0 flex-1">
					<Thread
						conversationId={conversationId}
						onConfigureMcp={onConfigureMcp}
					/>
				</div>
			</div>
		</AssistantRuntimeProvider>
	);
}

export function ChatApp() {
	const trpc = useTRPC();
	const qc = useQueryClient();
	const { data: session } = useSession();
	const isAdmin = (session?.user as { role?: string })?.role === "admin";
	const [activeId, setActiveId] = useState<string | undefined>();
	const [showSettings, setShowSettings] = useState(false);
	const [showPresets, setShowPresets] = useState(false);
	const [showMcpServers, setShowMcpServers] = useState(false);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
	const [copiedChatId, setCopiedChatId] = useState<string>();
	const sidebarRef = useRef<HTMLDivElement>(null);
	// Guards against React StrictMode double-invoking the auto-create effect.
	const autoCreated = useRef(false);

	const conversations = useQuery(trpc.conversation.list.queryOptions());
	const presets = useQuery(trpc.preset.list.queryOptions());
	const create = useMutation(
		trpc.conversation.create.mutationOptions({
			onSuccess: async ({ id }) => {
				// Wait for the list to contain the new conversation before selecting it.
				await qc.invalidateQueries({
					queryKey: trpc.conversation.list.queryKey(),
				});
				setActiveId(id);
			},
		}),
	);

	const list = conversations.data ?? [];
	const presetList = presets.data ?? [];

	// Start a new conversation, optionally snapshotting a chosen preset.
	const newChat = (presetId?: string) =>
		create.mutate(presetId ? { presetId } : {});

	// Ensure a conversation exists and one is always selected.
	useEffect(() => {
		if (!conversations.isSuccess) return;
		if (list.length === 0) {
			if (!autoCreated.current && !create.isPending) {
				autoCreated.current = true;
				create.mutate({});
			}
			return;
		}
		if (!activeId || !list.some((c) => c.id === activeId)) {
			setActiveId(list[0]?.id);
		}
	}, [conversations.isSuccess, list, activeId, create.isPending]);

	useEffect(() => {
		if (!drawerOpen || window.matchMedia(PINNED_SIDEBAR_MEDIA_QUERY).matches)
			return;

		const dismiss = (event: PointerEvent) => {
			if (!sidebarRef.current?.contains(event.target as Node))
				setDrawerOpen(false);
		};

		document.addEventListener("pointerdown", dismiss);
		return () => document.removeEventListener("pointerdown", dismiss);
	}, [drawerOpen]);

	function startSidebarResize(event: React.PointerEvent<HTMLDivElement>) {
		if (!window.matchMedia(PINNED_SIDEBAR_MEDIA_QUERY).matches) return;

		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);

		const resize = (moveEvent: PointerEvent) => {
			setSidebarWidth(
				Math.min(
					SIDEBAR_MAX_WIDTH,
					Math.max(SIDEBAR_MIN_WIDTH, moveEvent.clientX),
				),
			);
		};
		const stopResize = () => {
			window.removeEventListener("pointermove", resize);
			window.removeEventListener("pointerup", stopResize);
			window.removeEventListener("pointercancel", stopResize);
		};

		window.addEventListener("pointermove", resize);
		window.addEventListener("pointerup", stopResize);
		window.addEventListener("pointercancel", stopResize);
	}

	async function copyChatId() {
		if (!activeId) return;
		await navigator.clipboard.writeText(activeId);
		setCopiedChatId(activeId);
	}

	return (
		<div
			className="drawer min-[650px]:drawer-open solar-app h-dvh"
			style={
				{ "--solar-sidebar-width": `${sidebarWidth}px` } as React.CSSProperties
			}
		>
			<input
				id="solar-drawer"
				type="checkbox"
				className="drawer-toggle"
				checked={drawerOpen}
				onChange={(event) => setDrawerOpen(event.target.checked)}
			/>
			<div className="drawer-content solar-main flex min-h-0 flex-col overflow-x-clip bg-base-100">
				<header className="navbar min-h-16 flex-wrap gap-y-1 border-b border-base-300 bg-base-100 px-3 py-2 min-[1101px]:flex-nowrap min-[1101px]:px-5">
					<div className="navbar-start order-1 w-auto flex-1 gap-2">
						<label
							htmlFor="solar-drawer"
							className="solar-menu-toggle btn btn-ghost btn-sm btn-circle"
						>
							<Menu size={19} />
						</label>
						<strong className="solar-wordmark text-3xl">Solar</strong>
						<button
							type="button"
							className="btn btn-ghost btn-md gap-2"
							onClick={() => newChat()}
						>
							<SquarePen size={19} />
							<span className="hidden min-[500px]:inline">New chat</span>
						</button>
					</div>
					{activeId && <ContextIndicator conversationId={activeId} />}
					<div className="navbar-end order-2 w-auto gap-1 sm:order-3 sm:gap-2">
						{activeId && (
							<div
								className="tooltip tooltip-bottom hidden sm:block"
								data-tip="Copy chat ID"
							>
								<button
									className="btn btn-ghost btn-xs h-7 min-h-0 gap-1 px-2 font-mono text-[11px] font-normal opacity-45 hover:opacity-100"
									onClick={() => void copyChatId()}
								>
									<Hash size={13} />
									{copiedChatId === activeId ? "Copied" : activeId.slice(0, 8)}
								</button>
							</div>
						)}
						<div className="tooltip tooltip-bottom" data-tip="Presets">
							<button
								className="btn btn-ghost btn-sm btn-circle"
								onClick={() => {
									setShowPresets(true);
									setShowSettings(false);
									setShowMcpServers(false);
								}}
							>
								<SlidersHorizontal size={18} />
							</button>
						</div>
						{isAdmin && (
							<div className="tooltip tooltip-bottom" data-tip="Settings">
								<button
									className="btn btn-ghost btn-sm btn-circle"
									onClick={() => {
										setShowSettings(true);
										setShowPresets(false);
										setShowMcpServers(false);
									}}
								>
									<Settings2 size={18} />
								</button>
							</div>
						)}
						<ThemeToggle />
						<div className="tooltip tooltip-bottom" data-tip="Sign out">
							<button
								className="btn btn-ghost btn-sm btn-circle"
								onClick={() => signOut()}
							>
								<LogOut size={18} />
							</button>
						</div>
					</div>
				</header>
				<div className="flex min-h-0 flex-1">
					{activeId ? (
						<ConversationView
							key={activeId}
							conversationId={activeId}
							onConfigureMcp={() => {
								setShowMcpServers(true);
								setShowSettings(false);
								setShowPresets(false);
							}}
						/>
					) : (
						<p className="p-4">Loading…</p>
					)}
				</div>
				{showSettings && isAdmin && (
					<Settings onClose={() => setShowSettings(false)} />
				)}
				{showMcpServers && (
					<McpServers onClose={() => setShowMcpServers(false)} />
				)}
				{showPresets && <Presets onClose={() => setShowPresets(false)} />}
			</div>
			<div ref={sidebarRef} className="drawer-side solar-sidebar">
				<label
					htmlFor="solar-drawer"
					className="drawer-overlay"
					onClick={() => setDrawerOpen(false)}
				/>
				<Sidebar
					activeId={activeId}
					onClose={() => setDrawerOpen(false)}
					onSelect={(id) => {
						setActiveId(id);
						setDrawerOpen(false);
					}}
					presets={presetList.map((p) => ({ id: p.id, name: p.name }))}
					onNewWithPreset={(presetId) => {
						newChat(presetId);
						setDrawerOpen(false);
					}}
				/>
				<div
					className="solar-sidebar-resizer"
					onPointerDown={startSidebarResize}
				/>
			</div>
		</div>
	);
}
