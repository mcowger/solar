import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSession } from "../auth";
import { useTRPC } from "../trpc";

export function McpServers({ onClose }: { onClose: () => void }) {
	const trpc = useTRPC();
	const qc = useQueryClient();
	const { data: session } = useSession();
	const isAdmin = (session?.user as { role?: string })?.role === "admin";
	const servers = useQuery(trpc.mcp.list.queryOptions());
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [headerName, setHeaderName] = useState("Authorization");
	const [headerValue, setHeaderValue] = useState("");
	const [global, setGlobal] = useState(false);
	const invalidate = () =>
		qc.invalidateQueries({ queryKey: trpc.mcp.list.queryKey() });
	const create = useMutation(
		trpc.mcp.create.mutationOptions({
			onSuccess: () => {
				setName("");
				setUrl("");
				setHeaderValue("");
				invalidate();
			},
		}),
	);
	const remove = useMutation(
		trpc.mcp.remove.mutationOptions({ onSuccess: invalidate }),
	);
	const setDefault = useMutation(
		trpc.mcp.setDefault.mutationOptions({ onSuccess: invalidate }),
	);
	const test = useMutation(trpc.mcp.test.mutationOptions());
	const headers = headerValue.trim()
		? { [headerName.trim() || "Authorization"]: headerValue.trim() }
		: {};

	return (
		<div className="modal modal-open">
			<div className="modal-box flex h-[calc(100dvh-2rem)] w-11/12 max-w-5xl flex-col p-0">
				<header className="flex items-center justify-between gap-4 border-b border-base-300 px-5 py-4 sm:px-6">
					<div>
						<p className="text-sm uppercase tracking-[0.16em] opacity-60">
							Extensions
						</p>
						<h2 className="m-0 text-3xl">MCP servers</h2>
					</div>
					<button className="btn btn-ghost" onClick={onClose}>
						Close
					</button>
				</header>
				<div className="overflow-y-auto p-5 sm:p-6">
					<div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
						<section className="card card-border bg-base-100 shadow-sm">
							<div className="card-body gap-4">
								<h3 className="card-title">Add server</h3>
								<div className="grid gap-4 sm:grid-cols-2">
									<fieldset className="fieldset gap-2">
										<legend className="fieldset-legend">Name</legend>
										<input
											className="input w-full"
											value={name}
											onChange={(event) => setName(event.target.value)}
											placeholder="GitHub"
										/>
									</fieldset>
									<fieldset className="fieldset gap-2">
										<legend className="fieldset-legend">
											Streamable HTTP URL
										</legend>
										<input
											className="input w-full"
											value={url}
											onChange={(event) => setUrl(event.target.value)}
											placeholder="https://example.com/mcp"
										/>
									</fieldset>
								</div>
								<div className="grid gap-4 sm:grid-cols-2">
									<fieldset className="fieldset gap-2">
										<legend className="fieldset-legend">Header name</legend>
										<input
											className="input w-full"
											value={headerName}
											onChange={(event) => setHeaderName(event.target.value)}
										/>
									</fieldset>
									<fieldset className="fieldset gap-2">
										<legend className="fieldset-legend">Header value</legend>
										<input
											className="input w-full"
											type="password"
											value={headerValue}
											onChange={(event) => setHeaderValue(event.target.value)}
											placeholder="Optional; saved values stay masked"
										/>
									</fieldset>
								</div>
								{isAdmin && (
									<label className="flex items-center gap-3 text-sm">
										<input
											className="toggle toggle-primary toggle-sm checked:border-primary checked:bg-primary checked:text-primary-content"
											type="checkbox"
											checked={global}
											onChange={(event) => setGlobal(event.target.checked)}
										/>{" "}
										Make available to every user
									</label>
								)}
								<div className="card-actions items-center justify-end gap-2">
									{create.isError && (
										<span className="text-sm text-error">
											{create.error.message}
										</span>
									)}
									<button
										className="btn btn-outline"
										disabled={!url || test.isPending}
										onClick={() => test.mutate({ url, headers })}
									>
										{test.isPending ? "Testing…" : "Test connection"}
									</button>
									<button
										className="btn btn-primary"
										disabled={!name || !url || create.isPending}
										onClick={() =>
											create.mutate({
												name,
												url,
												headers,
												enabled: true,
												global,
											})
										}
									>
										{create.isPending ? "Saving…" : "Save server"}
									</button>
								</div>
								{test.data && (
									<p className="text-sm text-success">
										Connected to {test.data.name ?? "server"}: {test.data.tools}{" "}
										tools, {test.data.prompts} prompts, {test.data.resources}{" "}
										resources.
									</p>
								)}
								{test.isError && (
									<p className="text-sm text-error">{test.error.message}</p>
								)}
							</div>
						</section>
						<section className="card card-border bg-base-100 shadow-sm">
							<div className="card-body">
								<h3 className="card-title">Configured servers</h3>
								{servers.data?.length === 0 && (
									<p className="opacity-60">
										Add a Streamable HTTP MCP server to use external tools and
										resources in chat.
									</p>
								)}
								<div className="divide-y divide-base-300">
									{servers.data?.map((server) => (
										<div
											key={server.id}
											className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center"
										>
											<div className="min-w-0 flex-1">
												<p className="font-medium">
													{server.name}{" "}
													{server.global && (
														<span className="badge badge-sm">Global</span>
													)}
												</p>
												<p className="truncate text-sm opacity-60">
													{server.url}
												</p>
											</div>
											<div className="flex flex-wrap items-center gap-2">
												<label className="flex items-center gap-2 text-sm">
													Default
													<input
														className="toggle toggle-primary toggle-sm checked:border-primary checked:bg-primary checked:text-primary-content"
														type="checkbox"
														checked={server.defaultEnabled}
														disabled={setDefault.isPending}
														onChange={(event) =>
															setDefault.mutate({
																serverId: server.id,
																enabled: event.target.checked,
															})
														}
													/>
												</label>
												<button
													className="btn btn-sm btn-outline"
													onClick={() =>
														test.mutate({ id: server.id, headers: {} })
													}
												>
													Test
												</button>
												<button
													className="btn btn-sm btn-error btn-soft"
													disabled={remove.isPending}
													onClick={() => remove.mutate({ id: server.id })}
												>
													Remove
												</button>
											</div>
										</div>
									))}
								</div>
							</div>
						</section>
					</div>
				</div>
			</div>
			<div className="modal-backdrop" onClick={onClose} />
		</div>
	);
}
