import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

const LOCAL_URL = "http://localhost:3000";
const usage = `Usage:
  bun run solar dev <start|stop|restart|status|logs> [options]
  bun run solar history <list|inspect|export|export-all|import> [options]
  bun run solar staging deploy [--url <url>] [--output <path>]

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
	if (method === "GET")
		requestUrl.searchParams.set("input", JSON.stringify(input));
	else {
		headers.set("content-type", "application/json");
		body = JSON.stringify(input);
	}
	const response = await fetch(requestUrl, { method, headers, body });
	const payload = (await response.json()) as TrpcResponse;
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

async function userId(url: string, apiKey: string, email: string) {
	const users = (await trpc(
		url,
		apiKey,
		"admin.listUsers",
		undefined,
		"GET",
	)) as User[];
	const user = users.find(
		(candidate) => candidate.email.toLowerCase() === email.toLowerCase(),
	);
	if (!user) fail(`No user found for ${email} at ${url}.`);
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

if (group === "staging" && command === "deploy") {
	const { values, positionals } = parseArgs({
		args,
		options: {
			url: { type: "string" },
			output: { type: "string" },
			"api-key": { type: "string" },
			help: { type: "boolean", short: "h" },
		},
		allowPositionals: false,
		strict: true,
	});
	if (values.help || positionals.length) {
		console.log(usage);
		process.exit(values.help ? 0 : 1);
	}
	const result = spawnSync("bun", ["scripts/deploy-staging.ts"], {
		env: {
			...process.env,
			SOLAR_URL: values.url ?? process.env.SOLAR_URL,
			SOLAR_HISTORY_OUTPUT: values.output ?? process.env.SOLAR_HISTORY_OUTPUT,
			SOLAR_API_KEY: values["api-key"] ?? process.env.SOLAR_API_KEY,
		},
		stdio: "inherit",
	});
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
const url = (values.url ?? process.env.SOLAR_URL ?? LOCAL_URL).replace(
	/\/$/,
	"",
);
const apiKey = required(
	values["api-key"] ?? process.env.SOLAR_API_KEY,
	"api-key (or set SOLAR_API_KEY)",
);

if (command === "inspect")
	console.log(
		JSON.stringify(
			await trpc(
				url,
				apiKey,
				"admin.debug.chatRows",
				{ chatId: required(values.chat, "chat") },
				"GET",
			),
			null,
			2,
		),
	);
else if (command === "export-all") {
	const output = required(values.output, "output");
	const users = (await trpc(
		url,
		apiKey,
		"admin.listUsers",
		undefined,
		"GET",
	)) as User[];
	const histories = await Promise.all(
		users.map(async (user) => ({
			user,
			history: await trpc(
				url,
				apiKey,
				"admin.history.export",
				{ userId: user.id },
				"GET",
			),
		})),
	);
	await mkdir(dirname(output), { recursive: true });
	await Bun.write(
		output,
		`${JSON.stringify({ format: "solar-chat-history-all-users", version: 1, exportedAt: new Date().toISOString(), users: histories }, null, 2)}\n`,
	);
	console.log(`Exported chat history for ${users.length} users to ${output}`);
} else {
	const email = required(values.user, "user");
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
		console.log(`Exported chat history for ${email} to ${output}`);
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
