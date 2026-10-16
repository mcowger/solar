import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

function defaultLocalUrl(): string {
	if (process.env.PORT) return `http://localhost:${process.env.PORT}`;
	try {
		const log = readFileSync(".dev-server.log", "utf-8");
		const match = /->\s+(http:\/\/localhost:\d+)/.exec(log);
		if (match?.[1]) return match[1];
	} catch {}
	try {
		const proc = spawnSync(
			"bash",
			["scripts/port-allocator.sh", "", "", "", process.cwd()],
			{ encoding: "utf-8" },
		);
		const port = proc.stdout?.trim();
		if (port && /^\d+$/.test(port)) return `http://localhost:${port}`;
	} catch {}
	return "http://localhost:3000";
}

function defaultLocalApiKey(): string | undefined {
	try {
		const log = readFileSync(".dev-server.log", "utf-8");
		const match = /seeded dev API key:\s*(\S+)/.exec(log);
		if (match?.[1]) return match[1];
	} catch {}
	return undefined;
}

const usage = `Usage:
  bun run solar dev <start|stop|restart|status|logs> [options]
  bun run solar history <list|inspect|export|export-all|import> [options]

History commands use --url (or SOLAR_URL) and --api-key (or SOLAR_API_KEY).`;

type TrpcResponse = {
	result?: { data?: { json?: unknown } | unknown };
	error?: { json?: { message?: string } };
};
type User = { id: string; name: string; email: string; role: string };

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

function required(value: string | undefined, name: string) {
	if (!value) fail(`Missing required --${name} option.\n\n${usage}`);
	return value;
}

async function trpc(
	url: string,
	apiKey: string,
	path: string,
	input: unknown,
	method: "GET" | "POST",
) {
	const requestUrl = new URL(`/trpc/${path}`, url);
	const headers = new Headers({ "X-API-Key": apiKey });
	let body: string | undefined;
	if (method === "GET") {
		if (input !== undefined) {
			requestUrl.searchParams.set("input", JSON.stringify(input));
		}
	} else {
		headers.set("content-type", "application/json");
		body = JSON.stringify(input);
	}
	let response: Response;
	try {
		response = await fetch(requestUrl, { method, headers, body });
	} catch (error) {
		fail(
			`Could not connect to ${url}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	let payload: TrpcResponse;
	try {
		payload = (await response.json()) as TrpcResponse;
	} catch {
		fail(
			`tRPC ${path} failed: server returned non-JSON response (${response.status} ${response.statusText})`,
		);
	}
	if (!response.ok || payload.error)
		fail(
			`tRPC ${path} failed: ${payload.error?.json?.message ?? response.statusText}`,
		);
	const data = payload.result?.data;
	if (data === undefined) fail(`tRPC ${path} returned no data.`);
	return typeof data === "object" && data !== null && "json" in data
		? (data as { json: unknown }).json
		: data;
}

async function userId(url: string, apiKey: string, email?: string) {
	const users = (await trpc(
		url,
		apiKey,
		"admin.listUsers",
		undefined,
		"GET",
	)) as User[];
	if (!users.length) fail(`No users found at ${url}.`);
	if (!email) {
		if (users.length === 1) return users[0]!.id;
		fail(
			`Missing required --user option. Available users: ${users.map((u) => u.email).join(", ")}`,
		);
	}
	const user = users.find(
		(candidate) => candidate.email.toLowerCase() === email.toLowerCase(),
	);
	if (!user) {
		fail(
			`No user found for ${email} at ${url}. Available users: ${users.map((u) => u.email).join(", ")}`,
		);
	}
	return user.id;
}

const [group, command, ...args] = process.argv.slice(2);
if (!group || group === "--help" || group === "-h") {
	console.log(usage);
	process.exit(0);
}
if (command === "--help" || command === "-h") {
	console.log(usage);
	process.exit(0);
}

if (group === "dev") {
	if (
		!command ||
		!["start", "stop", "restart", "status", "logs"].includes(command)
	)
		fail(usage);
	const result = spawnSync(
		"bash",
		["scripts/dev-server.sh", command, ...args],
		{ stdio: "inherit" },
	);
	process.exit(result.status ?? 1);
}

if (
	group !== "history" ||
	!["list", "inspect", "export", "export-all", "import"].includes(command ?? "")
)
	fail(usage);
const { values, positionals } = parseArgs({
	args,
	options: {
		user: { type: "string" },
		chat: { type: "string" },
		input: { type: "string" },
		output: { type: "string" },
		"api-key": { type: "string" },
		url: { type: "string" },
		help: { type: "boolean", short: "h" },
	},
	allowPositionals: false,
	strict: true,
});
if (values.help || positionals.length) {
	console.log(usage);
	process.exit(values.help ? 0 : 1);
}
const defaultUrl = process.env.SOLAR_URL ?? defaultLocalUrl();
const url = (values.url ?? defaultUrl).replace(/\/$/, "");
const defaultApiKey =
	process.env.SOLAR_API_KEY ??
	(url.includes("localhost") || url.includes("127.0.0.1")
		? defaultLocalApiKey()
		: undefined);
const apiKey = required(
	values["api-key"] ?? defaultApiKey,
	"api-key (or set SOLAR_API_KEY)",
);

if (command === "inspect") {
	const email = values.user;
	const id = await userId(url, apiKey, email);
	console.log(
		JSON.stringify(
			await trpc(
				url,
				apiKey,
				"admin.debug.chatRows",
				{ chatId: required(values.chat, "chat"), userId: id },
				"GET",
			),
			null,
			2,
		),
	);
} else if (command === "export-all") {
	const output = required(values.output, "output");
	const users = (await trpc(
		url,
		apiKey,
		"admin.listUsers",
		undefined,
		"GET",
	)) as User[];
	const histories: Array<{ user: User; history: unknown }> = [];
	const failedUsers: string[] = [];
	for (const user of users) {
		try {
			const history = await trpc(
				url,
				apiKey,
				"admin.history.export",
				{ userId: user.id },
				"GET",
			);
			histories.push({ user, history });
		} catch (error) {
			console.error(
				`Export failed for ${user.email}: ${error instanceof Error ? error.message : String(error)}`,
			);
			failedUsers.push(user.email);
		}
	}
	await mkdir(dirname(output), { recursive: true });
	await Bun.write(
		output,
		`${JSON.stringify({ format: "solar-chat-history-all-users", version: 1, exportedAt: new Date().toISOString(), users: histories }, null, 2)}\n`,
	);
	console.log(
		`Exported chat history for ${histories.length} users to ${output}`,
	);
	if (failedUsers.length > 0) {
		fail(`Failed to export history for: ${failedUsers.join(", ")}`);
	}
} else {
	const email = values.user;
	const id = await userId(url, apiKey, email);
	if (command === "list")
		console.log(
			JSON.stringify(
				await trpc(url, apiKey, "admin.debug.chatIds", { userId: id }, "GET"),
				null,
				2,
			),
		);
	else if (command === "export") {
		const output = required(values.output, "output");
		await mkdir(dirname(output), { recursive: true });
		await Bun.write(
			output,
			`${JSON.stringify(await trpc(url, apiKey, "admin.history.export", { userId: id }, "GET"), null, 2)}\n`,
		);
		console.log(`Exported chat history for ${email ?? id} to ${output}`);
	} else {
		const input = required(values.input, "input");
		let history: unknown;
		try {
			history = JSON.parse(await Bun.file(input).text());
		} catch (error) {
			fail(
				`Could not read history from ${input}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		console.log(
			JSON.stringify(
				await trpc(
					url,
					apiKey,
					"admin.history.import",
					{ userId: id, history },
					"POST",
				),
				null,
				2,
			),
		);
	}
}
