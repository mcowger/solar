import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Pencil, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTRPC } from "../trpc";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Unable to update skills";
}

export function Skills({ onClose }: { onClose: () => void }) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const dialogRef = useRef<HTMLDialogElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [error, setError] = useState<string | null>(null);
	const skills = useQuery(trpc.skill.list.queryOptions());
	const selected = useQuery(
		trpc.skill.get.queryOptions(
			{ id: selectedId ?? "" },
			{ enabled: selectedId !== null },
		),
	);
	const invalidate = () =>
		queryClient.invalidateQueries({ queryKey: trpc.skill.list.queryKey() });
	const create = useMutation(
		trpc.skill.create.mutationOptions({ onSuccess: invalidate }),
	);
	const update = useMutation(
		trpc.skill.update.mutationOptions({
			onSuccess: async () => {
				await invalidate();
				await queryClient.invalidateQueries({
					queryKey: trpc.skill.get.queryKey({ id: selectedId ?? "" }),
				});
			},
			onError: (mutationError) => setError(errorMessage(mutationError)),
		}),
	);
	const setExposed = useMutation(
		trpc.skill.setExposed.mutationOptions({
			onSuccess: invalidate,
			onError: (mutationError) => setError(errorMessage(mutationError)),
		}),
	);
	const remove = useMutation(
		trpc.skill.remove.mutationOptions({
			onSuccess: (_, variables) => {
				if (selectedId === variables.id) setSelectedId(null);
				invalidate();
			},
			onError: (mutationError) => setError(errorMessage(mutationError)),
		}),
	);

	useEffect(() => {
		dialogRef.current?.showModal();
	}, []);

	useEffect(() => {
		if (selected.data) setDraft(selected.data.content);
	}, [selected.data]);

	async function upload(file: File | undefined) {
		setError(null);
		if (!file) return;
		if (file.name !== "SKILL.md") {
			setError("Upload the original file named exactly SKILL.md.");
			return;
		}
		try {
			await create.mutateAsync({ content: await file.text() });
			inputRef.current && (inputRef.current.value = "");
		} catch (uploadError) {
			setError(errorMessage(uploadError));
		}
	}

	function openEditor(id: string) {
		setError(null);
		setSelectedId(id);
	}

	async function save() {
		if (!selectedId) return;
		setError(null);
		await update.mutateAsync({ id: selectedId, content: draft });
	}

	function download() {
		if (!selected.data) return;
		const url = URL.createObjectURL(
			new Blob([selected.data.content], { type: "text/markdown" }),
		);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = "SKILL.md";
		anchor.click();
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}

	function close() {
		if (dialogRef.current?.open) dialogRef.current.close();
		else onClose();
	}

	return (
		<dialog ref={dialogRef} className="modal" onClose={onClose}>
			<div className="modal-box flex h-[calc(100dvh-2rem)] w-11/12 max-w-4xl flex-col p-0">
				<header className="flex items-center justify-between gap-4 border-b border-base-300 px-5 py-4 sm:px-6">
					<div>
						<p className="text-sm uppercase tracking-[0.16em] opacity-60">
							Chat setup
						</p>
						<h2 className="m-0 text-3xl">Skills</h2>
					</div>
					<button type="button" className="btn btn-ghost" onClick={close}>
						Close
					</button>
				</header>
				<div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">
					<div className="flex flex-col gap-3 sm:flex-row sm:items-center">
						<input
							ref={inputRef}
							type="file"
							accept=".md,text/markdown"
							className="file-input file-input-sm w-full"
							disabled={create.isPending}
							onChange={(event) => void upload(event.currentTarget.files?.[0])}
						/>
						<span className="flex shrink-0 items-center gap-2 text-sm opacity-60">
							<Upload size={16} /> Exact SKILL.md only
						</span>
					</div>
					{error && (
						<div
							role="alert"
							className="alert alert-error alert-soft mt-4 text-sm"
						>
							{error}
						</div>
					)}
					<p className="mt-4 text-sm text-base-content/65">
						Hidden skills are not automatically discoverable, but remain
						available through <span className="font-mono">/name</span>.
					</p>
					{skills.isLoading ? (
						<div className="flex items-center gap-2 py-8 text-sm opacity-60">
							<span className="loading loading-spinner loading-sm" /> Loading
							skills…
						</div>
					) : skills.isError ? (
						<div className="alert alert-error alert-soft mt-4 text-sm">
							{errorMessage(skills.error)}
						</div>
					) : skills.data?.length ? (
						<ul className="list mt-3">
							{skills.data.map((skill) => (
								<li
									key={skill.id}
									className="list-row gap-3 border-b border-base-300 px-0"
								>
									<span className="badge badge-ghost badge-sm font-mono">
										/{skill.name}
									</span>
									<div className="list-col-grow min-w-0">
										<div className="font-medium">{skill.description}</div>
										<div className="text-xs opacity-60">
											{skill.exposed ? "Discoverable" : "Hidden"}
										</div>
									</div>
									<label className="flex items-center gap-2 text-sm">
										<span>Expose</span>
										<input
											type="checkbox"
											className="toggle toggle-primary toggle-sm checked:border-primary checked:bg-primary checked:text-primary-content"
											checked={skill.exposed}
											disabled={setExposed.isPending}
											onChange={(event) =>
												setExposed.mutate({
													id: skill.id,
													exposed: event.target.checked,
												})
											}
										/>
									</label>
									<button
										type="button"
										className="btn btn-ghost btn-sm btn-square"
										title="Edit skill"
										onClick={() => openEditor(skill.id)}
									>
										<Pencil size={16} />
									</button>
									<button
										type="button"
										className="btn btn-error btn-soft btn-sm btn-square"
										title="Delete skill"
										disabled={remove.isPending}
										onClick={() => {
											if (window.confirm(`Delete /${skill.name}?`))
												remove.mutate({ id: skill.id });
										}}
									>
										<Trash2 size={16} />
									</button>
								</li>
							))}
						</ul>
					) : (
						<div className="alert alert-info alert-soft mt-4 text-sm">
							Upload a SKILL.md file to create your first skill.
						</div>
					)}
					{selectedId && (
						<section className="mt-6 rounded-box border border-base-300 bg-base-200 p-4">
							<div className="mb-3 flex items-center justify-between gap-3">
								<span className="font-mono text-sm">
									Editing /{selected.data?.name ?? "…"}
								</span>
								<div className="flex gap-2">
									<button
										type="button"
										className="btn btn-sm"
										disabled={!selected.data}
										onClick={download}
									>
										<Download size={15} /> Download
									</button>
									<button
										type="button"
										className="btn btn-ghost btn-sm"
										onClick={() => setSelectedId(null)}
									>
										Close editor
									</button>
								</div>
							</div>
							{selected.isLoading ? (
								<span className="loading loading-spinner loading-sm" />
							) : selected.isError ? (
								<p className="text-sm text-error">
									{errorMessage(selected.error)}
								</p>
							) : (
								<fieldset className="fieldset gap-2">
									<legend className="fieldset-legend">SKILL.md</legend>
									<textarea
										className="textarea min-h-80 w-full resize-y font-mono text-xs"
										value={draft}
										disabled={update.isPending}
										onChange={(event) => setDraft(event.target.value)}
									/>
									<div className="mt-2 flex justify-end">
										<button
											type="button"
											className="btn btn-primary btn-sm"
											disabled={update.isPending}
											onClick={() => void save()}
										>
											{update.isPending && (
												<span className="loading loading-spinner loading-xs" />
											)}
											Save changes
										</button>
									</div>
								</fieldset>
							)}
						</section>
					)}
				</div>
			</div>
			<form method="dialog" className="modal-backdrop">
				<button type="submit">close</button>
			</form>
		</dialog>
	);
}
