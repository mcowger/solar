import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ChevronDown,
	FolderInput,
	MoreHorizontal,
	PanelLeftClose,
	Pencil,
	Search,
	SquarePen,
	Sun,
	Tag,
	Trash2,
	X,
} from "lucide-react";
import { useState } from "react";
import { useTRPC } from "../trpc";
import { trpcClient } from "../trpcClient";

interface SidebarProps {
	activeId: string | undefined;
	onSelect: (id: string) => void;
	onToggleCollapse: () => void;
	onNewChat: () => void;
	presets: { id: string; name: string }[];
	onNewWithPreset: (presetId: string) => void;
}

interface ConversationItem {
	id: string;
	title: string;
	folderId: string | null;
	updatedAt: string;
	tags: { id: string; name: string }[];
}

const startOfDay = (d: Date) =>
	new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Compact relative age for a conversation row, e.g. "now", "3h", "2d". */
function relativeAge(iso: string): string {
	const diffMs = Date.now() - new Date(iso).getTime();
	const minutes = Math.floor(diffMs / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	if (days < 30) return `${Math.floor(days / 7)}w`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo`;
	return `${Math.floor(months / 12)}y`;
}

const RECENCY_GROUPS = [
	{ key: "today", label: "Today" },
	{ key: "yesterday", label: "Yesterday" },
	{ key: "week", label: "Previous 7 Days" },
	{ key: "month", label: "Previous 30 Days" },
	{ key: "older", label: "Older" },
] as const;

type RecencyKey = (typeof RECENCY_GROUPS)[number]["key"];

function recencyKey(iso: string): RecencyKey {
	const days = Math.floor(
		(startOfDay(new Date()) - startOfDay(new Date(iso))) / 86_400_000,
	);
	if (days <= 0) return "today";
	if (days === 1) return "yesterday";
	if (days <= 7) return "week";
	if (days <= 30) return "month";
	return "older";
}

function closeMenu() {
	(document.activeElement as HTMLElement | null)?.blur();
}

export function Sidebar({
	activeId,
	onSelect,
	onToggleCollapse,
	onNewChat,
	presets,
	onNewWithPreset,
}: SidebarProps) {
	const trpc = useTRPC();
	const qc = useQueryClient();
	const [search, setSearch] = useState("");
	const [searchOpen, setSearchOpen] = useState(false);

	const conversations = useQuery(trpc.conversation.list.queryOptions());
	const folders = useQuery(trpc.folder.list.queryOptions());
	const searchResults = useQuery(
		trpc.conversation.search.queryOptions(
			{ query: search.trim() },
			{ enabled: search.trim().length > 0 },
		),
	);

	const invalidateAll = () => {
		qc.invalidateQueries({ queryKey: trpc.conversation.list.queryKey() });
		qc.invalidateQueries({ queryKey: trpc.folder.list.queryKey() });
		qc.invalidateQueries({ queryKey: trpc.tag.list.queryKey() });
	};

	const rename = useMutation(
		trpc.conversation.rename.mutationOptions({ onSuccess: invalidateAll }),
	);
	const remove = useMutation(
		trpc.conversation.remove.mutationOptions({ onSuccess: invalidateAll }),
	);
	const move = useMutation(
		trpc.conversation.move.mutationOptions({ onSuccess: invalidateAll }),
	);
	const createFolder = useMutation(
		trpc.folder.create.mutationOptions({ onSuccess: invalidateAll }),
	);

	const list = (conversations.data ?? []) as ConversationItem[];
	const folderList = folders.data ?? [];

	async function editTags(
		conversationId: string,
		current: { id: string; name: string }[],
	) {
		const input = window.prompt(
			"Tags (comma-separated):",
			current.map((t) => t.name).join(", "),
		);
		if (input === null) return;
		const names = [
			...new Set(
				input
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean),
			),
		];
		const ids = await Promise.all(
			names.map(
				async (name) => (await trpcClient.tag.create.mutate({ name })).id,
			),
		);
		await trpcClient.conversation.setTags.mutate({
			id: conversationId,
			tagIds: ids,
		});
		invalidateAll();
	}

	function renameConversation(id: string, currentTitle: string) {
		const title = window.prompt("Rename conversation:", currentTitle);
		if (title?.trim()) rename.mutate({ id, title: title.trim() });
	}

	function deleteConversation(id: string) {
		if (window.confirm("Delete this conversation?")) remove.mutate({ id });
	}

	async function moveToNewFolder(conversationId: string) {
		const name = window.prompt("New folder name:");
		if (!name?.trim()) return;
		const folder = await trpcClient.folder.create.mutate({ name: name.trim() });
		move.mutate({ id: conversationId, folderId: folder.id });
	}

	const ConversationRow = (c: ConversationItem) => {
		const active = c.id === activeId;
		return (
			<div
				key={c.id}
				className={`group relative flex h-9 items-center gap-1 rounded-lg px-2 ${
					active ? "bg-base-300" : "hover:bg-base-300/60"
				}`}
			>
				<button
					type="button"
					onClick={() => onSelect(c.id)}
					title={c.title}
					className="min-w-0 flex-1 truncate text-left text-sm"
				>
					{c.title}
				</button>
				<span
					className={`shrink-0 text-xs tabular-nums text-base-content/45 ${
						active ? "hidden" : "group-hover:hidden"
					}`}
				>
					{relativeAge(c.updatedAt)}
				</span>
				<div
					className={`dropdown dropdown-end shrink-0 ${
						active ? "" : "hidden group-hover:block"
					}`}
				>
					<div
						tabIndex={0}
						role="button"
						className="btn btn-ghost btn-xs btn-circle"
						aria-label="Conversation options"
					>
						<MoreHorizontal size={15} />
					</div>
					<ul className="menu dropdown-content z-30 mt-1 w-48 rounded-box border border-base-300 bg-base-100 p-1 shadow-lg">
						<li>
							<button
								type="button"
								onClick={() => {
									renameConversation(c.id, c.title);
									closeMenu();
								}}
							>
								<Pencil size={15} />
								Rename
							</button>
						</li>
						<li>
							<button
								type="button"
								onClick={() => {
									void editTags(c.id, c.tags);
									closeMenu();
								}}
							>
								<Tag size={15} />
								Edit tags
							</button>
						</li>
						<li className="menu-title flex-row items-center gap-2 px-3 py-1 text-xs">
							<FolderInput size={13} />
							Move to folder
						</li>
						{c.folderId && (
							<li>
								<button
									type="button"
									onClick={() => {
										move.mutate({ id: c.id, folderId: null });
										closeMenu();
									}}
								>
									No folder
								</button>
							</li>
						)}
						{folderList.map((f) => (
							<li key={f.id}>
								<button
									type="button"
									className={c.folderId === f.id ? "menu-active" : undefined}
									onClick={() => {
										move.mutate({ id: c.id, folderId: f.id });
										closeMenu();
									}}
								>
									{f.name}
								</button>
							</li>
						))}
						<li>
							<button
								type="button"
								onClick={() => {
									void moveToNewFolder(c.id);
									closeMenu();
								}}
							>
								New folder…
							</button>
						</li>
						<li className="menu-title px-0 pt-1">
							<div className="mx-1 border-t border-base-300" />
						</li>
						<li>
							<button
								type="button"
								className="text-error"
								onClick={() => {
									deleteConversation(c.id);
									closeMenu();
								}}
							>
								<Trash2 size={15} />
								Delete
							</button>
						</li>
					</ul>
				</div>
			</div>
		);
	};

	const grouped = new Map<RecencyKey, ConversationItem[]>();
	for (const c of list) {
		const key = recencyKey(c.updatedAt);
		const bucket = grouped.get(key) ?? [];
		bucket.push(c);
		grouped.set(key, bucket);
	}

	return (
		<aside className="flex h-full min-h-0 flex-col bg-base-200">
			<div className="flex h-14 items-center gap-2 px-3">
				<span className="solar-brand">
					<span className="solar-brand-logo">
						<Sun size={16} />
					</span>
					<span className="solar-brand-name">Solar</span>
				</span>
				<button
					type="button"
					className="ml-auto btn btn-ghost btn-sm btn-circle"
					onClick={onToggleCollapse}
					title="Collapse sidebar"
					aria-label="Collapse sidebar"
				>
					<PanelLeftClose size={18} />
				</button>
			</div>

			<nav className="px-2 pb-1">
				<div className="flex items-center">
					<button
						type="button"
						onClick={onNewChat}
						className="flex flex-1 items-center gap-2.5 rounded-lg px-2 py-2 text-sm font-medium hover:bg-base-300"
					>
						<SquarePen size={17} />
						New Chat
					</button>
					{presets.length > 0 && (
						<div className="dropdown dropdown-end">
							<div
								tabIndex={0}
								role="button"
								className="btn btn-ghost btn-sm btn-circle"
								aria-label="New chat from preset"
								title="New chat from preset"
							>
								<ChevronDown size={16} />
							</div>
							<ul className="menu dropdown-content z-30 mt-1 w-52 rounded-box border border-base-300 bg-base-100 p-1 shadow-lg">
								<li className="menu-title text-xs">New chat from preset</li>
								{presets.map((p) => (
									<li key={p.id}>
										<button
											type="button"
											onClick={() => {
												onNewWithPreset(p.id);
												closeMenu();
											}}
										>
											{p.name}
										</button>
									</li>
								))}
							</ul>
						</div>
					)}
				</div>

				{searchOpen ? (
					<div className="flex items-center gap-2 px-2 py-1.5">
						<Search size={17} className="shrink-0 opacity-50" />
						<input
							autoFocus
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder="Search chats…"
							className="solar-search-input w-full min-w-0 text-sm outline-none"
						/>
						<button
							type="button"
							className="shrink-0 text-base-content/50 hover:text-base-content"
							aria-label="Close search"
							onClick={() => {
								setSearch("");
								setSearchOpen(false);
							}}
						>
							<X size={16} />
						</button>
					</div>
				) : (
					<button
						type="button"
						onClick={() => setSearchOpen(true)}
						className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-sm font-medium hover:bg-base-300"
					>
						<Search size={17} />
						Search
					</button>
				)}
			</nav>

			<div className="solar-scroll-overlay min-h-0 flex-1 overflow-y-auto px-2 pb-3">
				{search.trim() ? (
					<div className="pt-1">
						<div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-base-content/45">
							Results
						</div>
						{(searchResults.data ?? []).map((r) => (
							<button
								key={r.id}
								type="button"
								onClick={() => onSelect(r.id)}
								title={r.title}
								className={`block w-full truncate rounded-lg px-2 py-1.5 text-left text-sm ${
									r.id === activeId ? "bg-base-300" : "hover:bg-base-300/60"
								}`}
							>
								{r.title}
							</button>
						))}
						{searchResults.data?.length === 0 && (
							<div className="px-2 py-2 text-sm text-base-content/50">
								No matches.
							</div>
						)}
					</div>
				) : (
					RECENCY_GROUPS.map(({ key, label }) => {
						const items = grouped.get(key);
						if (!items || items.length === 0) return null;
						return (
							<div key={key} className="mt-2 first:mt-1">
								<div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-base-content/45">
									{label}
								</div>
								{items.map(ConversationRow)}
							</div>
						);
					})
				)}
			</div>
		</aside>
	);
}
