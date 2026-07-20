import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Star } from "lucide-react";
import { useTRPC } from "../trpc";

interface Selection {
	provider: string;
	endpointId: string;
	modelId: string;
	api: string;
}

function key(s: Selection) {
	return `${s.provider}/${s.endpointId}/${s.modelId}/${s.api}`;
}

function closeDropdown() {
	(document.activeElement as HTMLElement | null)?.blur();
}

/**
 * Per-conversation model selector rendered as the page-title dropdown. Switching
 * persists the choice on the conversation immediately (switchable at any time).
 * "Make default" stores the choice as the user's personal default for new
 * conversations.
 */
export function ModelMenu({ conversationId }: { conversationId: string }) {
	const trpc = useTRPC();
	const qc = useQueryClient();

	const available = useQuery(trpc.model.available.queryOptions());
	const current = useQuery(
		trpc.model.forConversation.queryOptions({ conversationId }),
	);
	const userDefault = useQuery(trpc.model.userDefault.queryOptions());

	const setModel = useMutation(
		trpc.conversation.setModel.mutationOptions({
			onSuccess: () => {
				qc.invalidateQueries({
					queryKey: trpc.model.forConversation.queryKey({ conversationId }),
				});
				qc.invalidateQueries({ queryKey: trpc.conversation.list.queryKey() });
			},
		}),
	);
	const setDefault = useMutation(
		trpc.model.setUserDefault.mutationOptions({
			onSuccess: () => {
				qc.invalidateQueries({ queryKey: trpc.model.userDefault.queryKey() });
			},
		}),
	);

	const models = available.data ?? [];
	const cur = current.data;
	const isCurrentDefault =
		cur && userDefault.data && key(cur) === key(userDefault.data);
	const label = cur?.name ?? cur?.modelId ?? "Select model";
	const curUnavailable = cur && !models.some((m) => key(m) === key(cur));

	if (models.length === 0) {
		return (
			<span className="px-2 text-sm text-base-content/60">
				No models configured.
			</span>
		);
	}

	return (
		<div className="dropdown">
			<div
				tabIndex={0}
				role="button"
				className="btn btn-ghost btn-sm min-w-0 gap-1 px-2 text-base font-semibold"
				title="Change model"
			>
				<span className="truncate">{label}</span>
				<ChevronDown size={16} className="shrink-0 opacity-60" />
			</div>
			<ul className="menu dropdown-content z-20 mt-1 max-h-[70vh] w-64 flex-nowrap overflow-y-auto rounded-box border border-base-300 bg-base-100 p-1.5 shadow-lg">
				{curUnavailable && cur && (
					<li className="menu-disabled">
						<span className="justify-between">
							{cur.name ?? cur.modelId}
							<span className="text-xs opacity-60">unavailable</span>
						</span>
					</li>
				)}
				{models.map((m) => {
					const selected = cur && key(m) === key(cur);
					return (
						<li key={key(m)}>
							<button
								type="button"
								className="justify-between"
								onClick={() => {
									if (!selected)
										setModel.mutate({
											id: conversationId,
											provider: m.provider,
											endpointId: m.endpointId,
											modelId: m.modelId,
											api: m.api,
										});
									closeDropdown();
								}}
							>
								<span className="truncate">{m.name}</span>
								{selected && <Check size={15} className="shrink-0" />}
							</button>
						</li>
					);
				})}
				{cur && !isCurrentDefault && (
					<>
						<li className="menu-title px-2 pt-2 pb-0 text-xs">
							New conversations
						</li>
						<li>
							<button
								type="button"
								onClick={() => {
									setDefault.mutate({
										provider: cur.provider,
										endpointId: cur.endpointId,
										modelId: cur.modelId,
										api: cur.api,
									});
									closeDropdown();
								}}
								disabled={setDefault.isPending}
							>
								<Star size={15} className="shrink-0" />
								Make this my default
							</button>
						</li>
					</>
				)}
			</ul>
		</div>
	);
}
