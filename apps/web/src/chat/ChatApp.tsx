import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	Check,
	Copy,
	LogOut,
	Menu,
	MoreHorizontal,
	PanelLeft,
	Plus,
	Settings2,
} from "lucide-react";
import { signOut, useSession } from "../auth";
import { useTRPC } from "../trpc";
import { ThemeToggle } from "../ThemeToggle";
import { Settings } from "../admin/Settings";
import { ModelMenu } from "./ModelPicker";
import { Presets } from "./Presets";
import { Sidebar } from "./Sidebar";
import { Thread } from "./Thread";
import { McpServers } from "./McpServers";
import { useSolarRuntime } from "./useSolarRuntime";
import { useMobileReturnToNewChat } from "./useMobileReturnToNewChat";
import { useNewChatHotkey } from "./useNewChatHotkey";

const SIDEBAR_DEFAULT_WIDTH = 280;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 480;
const PINNED_SIDEBAR_MEDIA_QUERY = "(min-width: 650px)";
const SWIPE_EDGE_THRESHOLD = 32;
const SWIPE_OPEN_THRESHOLD = 64;
const SWIPE_VERTICAL_TOLERANCE = 80;

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

function ContextMetrics({ conversationId }: { conversationId: string }) {
	const trpc = useTRPC();
	const metrics = useQuery({
		...trpc.conversation.metrics.queryOptions({ conversationId }),
		refetchInterval: 5_000,
	});
	const data = metrics.data;
	if (!data || data.contextTokens === null) {
		return (
			<p className="px-2 py-1 text-xs text-base-content/60">
				No usage yet for this chat.
			</p>
		);
	}

	const contextPercent = Math.min(
		100,
		Math.round((data.contextTokens / data.contextWindowTokens) * 100),
	);
	const compactionPercent = Math.min(
		100,
		Math.round((data.contextTokens / data.compactionAtTokens) * 100),
	);

	return (
		<div className="space-y-2 px-2 py-1.5">
			<div className="space-y-1">
				<div className="flex items-center justify-between text-xs">
					<span className="font-semibold uppercase text-base-content/60">
						Context
					</span>
					<span className="tabular-nums text-base-content/70">
						{contextPercent}% ·{" "}
						{`${formatTokens(data.contextTokens)}/${formatTokens(data.contextWindowTokens)}`}
					</span>
				</div>
				<progress
					className="progress progress-primary h-1.5 w-full"
					value={contextPercent}
					max="100"
				/>
			</div>
			<div className="space-y-1">
				<div className="flex items-center justify-between text-xs">
					<span className="font-semibold uppercase text-base-content/60">
						Compact
					</span>
					<span className="tabular-nums text-base-content/70">
						{compactionPercent}% ·{" "}
						{`${formatTokens(data.contextTokens)}/${formatTokens(data.compactionAtTokens)}`}
					</span>
				</div>
				<progress
					className="progress progress-warning h-1.5 w-full"
					value={compactionPercent}
					max="100"
				/>
			</div>
			<div className="flex items-center justify-between text-xs">
				<span className="font-semibold uppercase text-base-content/60">
					Cost
				</span>
				<span className="tabular-nums text-base-content/70">
					{formatCost(data.costMicros)}
				</span>
			</div>
		</div>
	);
}

function ConversationInfoMenu({ conversationId }: { conversationId: string }) {
	const [copied, setCopied] = useState(false);

	async function copyChatId() {
		await navigator.clipboard.writeText(conversationId);
		setCopied(true);
	}

	return (
		<div className="dropdown dropdown-end">
			<div
				tabIndex={0}
				role="button"
				className="btn btn-ghost btn-sm btn-circle"
				title="Chat info"
			>
				<MoreHorizontal size={18} />
			</div>
			<div className="dropdown-content z-20 mt-1 w-72 rounded-box border border-base-300 bg-base-100 p-1.5 shadow-lg">
				<ContextMetrics conversationId={conversationId} />
				<button
					type="button"
					className="flex w-full items-center gap-2 rounded-field px-2 py-1.5 text-left text-sm hover:bg-base-200"
					onClick={() => void copyChatId()}
				>
					{copied ? <Check size={15} /> : <Copy size={15} />}
					<span>Copy chat ID</span>
					<span className="ml-auto tabular-nums text-xs opacity-60">
						{conversationId.slice(0, 8)}
					</span>
				</button>
			</div>
		</div>
	);
}

function initialsFrom(name?: string | null, email?: string | null) {
	const source = name?.trim() || email?.trim() || "?";
	const parts = source.split(/\s+/).filter(Boolean);
	const letters =
		parts.length > 1
			? `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`
			: source.slice(0, 2);
	return letters.toUpperCase();
}

function UserMenu({
	name,
	email,
	isAdmin,
	onSettings,
}: {
	name?: string | null;
	email?: string | null;
	isAdmin: boolean;
	onSettings: () => void;
}) {
	return (
		<div className="dropdown dropdown-end">
			<div
				tabIndex={0}
				role="button"
				className="btn btn-ghost btn-sm btn-circle avatar avatar-placeholder"
				title={email ?? "Account"}
			>
				<div className="w-8 rounded-full bg-neutral text-neutral-content">
					<span className="text-xs font-semibold">
						{initialsFrom(name, email)}
					</span>
				</div>
			</div>
			<div className="dropdown-content z-20 mt-1 w-56 rounded-box border border-base-300 bg-base-100 p-1.5 shadow-lg">
				<div className="truncate px-2 py-1 text-sm font-medium">
					{name || email}
				</div>
				{name && email && (
					<div className="truncate px-2 pb-1 text-xs opacity-60">{email}</div>
				)}
				<div className="my-1 border-t border-base-300" />
				<div className="flex items-center justify-between px-2 py-1 text-sm">
					<span>Theme</span>
					<ThemeToggle />
				</div>
				{isAdmin && (
					<button
						type="button"
						className="flex w-full items-center gap-2 rounded-field px-2 py-1.5 text-left text-sm hover:bg-base-200"
						onClick={() => {
							onSettings();
							(document.activeElement as HTMLElement | null)?.blur();
						}}
					>
						<Settings2 size={16} />
						Admin settings
					</button>
				)}
				<button
					type="button"
					className="flex w-full items-center gap-2 rounded-field px-2 py-1.5 text-left text-sm hover:bg-base-200"
					onClick={() => signOut()}
				>
					<LogOut size={16} />
					Sign out
				</button>
			</div>
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
	const context = useQuery({
		...trpc.conversation.contextState.queryOptions({ conversationId }),
		refetchInterval: 2_000,
	});
	const runtime = useSolarRuntime(
		conversationId,
		current.data?.vision ?? false,
		current.data?.documentMimeTypes ?? [],
		current.data?.documents ?? false,
		context.data?.summaryEvent?.revision,
	);
	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				<div className="min-h-0 flex-1">
					<Thread
						conversationId={conversationId}
						onConfigureMcp={onConfigureMcp}
						contextStatus={context.data}
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
	// A freshly created conversation is a "draft" until its first turn: it isn't
	// in the (message-filtered) list yet, but must stay selected.
	const [draftId, setDraftId] = useState<string | undefined>();
	const [showSettings, setShowSettings] = useState(false);
	const [showPresets, setShowPresets] = useState(false);
	const [showMcpServers, setShowMcpServers] = useState(false);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
	const sidebarRef = useRef<HTMLDivElement>(null);
	const swipeStart = useRef<{ x: number; y: number } | undefined>(undefined);
	// Guards against React StrictMode double-invoking the auto-create effect.
	const autoCreated = useRef(false);

	useEffect(() => {
		const visualViewport = window.visualViewport;
		const updateViewportHeight = () => {
			const height = visualViewport?.height ?? window.innerHeight;
			document.documentElement.style.setProperty(
				"--solar-viewport-height",
				`${Math.round(height)}px`,
			);
			document.documentElement.style.setProperty(
				"--solar-viewport-offset-top",
				`${Math.round(visualViewport?.offsetTop ?? 0)}px`,
			);
		};

		updateViewportHeight();
		window.addEventListener("resize", updateViewportHeight);
		visualViewport?.addEventListener("resize", updateViewportHeight);
		visualViewport?.addEventListener("scroll", updateViewportHeight);
		return () => {
			window.removeEventListener("resize", updateViewportHeight);
			visualViewport?.removeEventListener("resize", updateViewportHeight);
			visualViewport?.removeEventListener("scroll", updateViewportHeight);
			document.documentElement.style.removeProperty("--solar-viewport-height");
			document.documentElement.style.removeProperty(
				"--solar-viewport-offset-top",
			);
		};
	}, []);

	const conversations = useQuery(trpc.conversation.list.queryOptions());
	const presets = useQuery(trpc.preset.list.queryOptions());
	const create = useMutation(
		trpc.conversation.create.mutationOptions({
			onSuccess: async ({ id }) => {
				setDraftId(id);
				setActiveId(id);
				autoCreated.current = false;
				await qc.invalidateQueries({
					queryKey: trpc.conversation.list.queryKey(),
				});
			},
		}),
	);

	const list = conversations.data ?? [];
	const presetList = presets.data ?? [];

	// Start a new conversation, optionally snapshotting a chosen preset.
	const newChat = useCallback(
		(presetId?: string) => create.mutate(presetId ? { presetId } : {}),
		[create],
	);

	// Collapse the pinned sidebar on desktop; on mobile just close the drawer.
	const toggleSidebar = useCallback(() => {
		if (window.matchMedia(PINNED_SIDEBAR_MEDIA_QUERY).matches) {
			setSidebarCollapsed((value) => !value);
		} else {
			setDrawerOpen(false);
		}
	}, []);

	useMobileReturnToNewChat(newChat);
	useNewChatHotkey(newChat);

	// Ensure a conversation exists and one is always selected. The active draft
	// is valid even though it isn't in the message-filtered list yet.
	useEffect(() => {
		if (!conversations.isSuccess) return;
		const activeIsValid =
			!!activeId &&
			(activeId === draftId || list.some((c) => c.id === activeId));
		if (activeIsValid) return;
		if (list.length > 0) {
			setActiveId(list[0]?.id);
			return;
		}
		if (!autoCreated.current && !create.isPending) {
			autoCreated.current = true;
			create.mutate({});
		}
	}, [conversations.isSuccess, list, activeId, draftId, create.isPending]);

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

	function startDrawerSwipe(event: React.TouchEvent<HTMLDivElement>) {
		if (drawerOpen || window.matchMedia(PINNED_SIDEBAR_MEDIA_QUERY).matches) {
			swipeStart.current = undefined;
			return;
		}

		const touch = event.touches[0];
		if (touch && touch.clientX <= SWIPE_EDGE_THRESHOLD) {
			swipeStart.current = { x: touch.clientX, y: touch.clientY };
		}
	}

	function finishDrawerSwipe(event: React.TouchEvent<HTMLDivElement>) {
		const start = swipeStart.current;
		swipeStart.current = undefined;
		if (!start || drawerOpen) return;

		const touch = event.changedTouches[0];
		if (!touch) return;

		const deltaX = touch.clientX - start.x;
		const deltaY = Math.abs(touch.clientY - start.y);
		if (deltaX >= SWIPE_OPEN_THRESHOLD && deltaY <= SWIPE_VERTICAL_TOLERANCE) {
			setDrawerOpen(true);
		}
	}

	return (
		<div
			className={`drawer min-[650px]:drawer-open solar-app${
				sidebarCollapsed ? " solar-collapsed" : ""
			}`}
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
			<div
				className="drawer-content solar-main flex min-h-0 flex-col overflow-x-clip bg-base-100"
				onTouchStart={startDrawerSwipe}
				onTouchEnd={finishDrawerSwipe}
				onTouchCancel={() => {
					swipeStart.current = undefined;
				}}
			>
				<header className="flex h-14 min-h-14 shrink-0 items-center gap-1 border-b border-base-300 bg-base-100 px-2 sm:px-4">
					<label
						htmlFor="solar-drawer"
						className="solar-menu-toggle btn btn-ghost btn-sm btn-circle"
					>
						<Menu size={19} />
					</label>
					{sidebarCollapsed && (
						<button
							type="button"
							className="hidden btn btn-ghost btn-sm btn-circle min-[650px]:inline-flex"
							onClick={() => setSidebarCollapsed(false)}
							title="Show sidebar"
							aria-label="Show sidebar"
						>
							<PanelLeft size={19} />
						</button>
					)}
					{activeId && <ModelMenu conversationId={activeId} />}
					<div
						className="tooltip tooltip-bottom"
						data-tip="New chat (⌘/Ctrl+N)"
					>
						<button
							type="button"
							className="btn btn-ghost btn-sm btn-circle"
							onClick={() => newChat()}
							aria-label="New chat"
						>
							<Plus size={19} />
						</button>
					</div>
					<div className="ml-auto flex items-center gap-1">
						{activeId && <ConversationInfoMenu conversationId={activeId} />}
						<UserMenu
							name={session?.user?.name}
							email={session?.user?.email}
							isAdmin={isAdmin}
							onSettings={() => {
								setShowSettings(true);
								setShowPresets(false);
								setShowMcpServers(false);
							}}
						/>
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
					onSelect={(id) => {
						setActiveId(id);
						setDrawerOpen(false);
					}}
					onToggleCollapse={toggleSidebar}
					onNewChat={() => {
						newChat();
						setDrawerOpen(false);
					}}
					presets={presetList.map((p) => ({ id: p.id, name: p.name }))}
					onNewWithPreset={(presetId) => {
						newChat(presetId);
						setDrawerOpen(false);
					}}
					onManagePresets={() => {
						setShowPresets(true);
						setShowSettings(false);
						setShowMcpServers(false);
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
