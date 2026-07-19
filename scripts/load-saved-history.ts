import { parseArgs } from "node:util";

const DEFAULT_INPUT = ".staging-history.json";
const DEFAULT_URL = "http://localhost:3000";
const DEFAULT_USER_EMAIL = "admin@solar.local";

const usage = `Usage: bun run dev:load-history -- [options]

Starts the local dev server, then imports a saved Solar history bundle.

Options:
  --input <path>           Bundle path (default ${DEFAULT_INPUT})
  --url <url>              Local Solar URL (default ${DEFAULT_URL})
  --user <email>           Destination user email (default ${DEFAULT_USER_EMAIL})
  --cookie <cookie>        Admin session cookie (or SOLAR_SESSION_COOKIE)
  --email <email>          Admin email (or SOLAR_ADMIN_EMAIL)
  --password <password>    Admin password (or SOLAR_ADMIN_PASSWORD)
`;

type TrpcResponse = {
	result?: { data?: { json?: unknown } | unknown };
	error?: { json?: { message?: string } };
};

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

function sessionCookieFromHeaders(headers: Headers) {
	const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] })
		.getSetCookie;
	const cookie = (
		getSetCookie
			? getSetCookie.call(headers)
			: [headers.get("set-cookie") ?? ""]
	)
		.map((value) => value.split(";", 1)[0])
		.filter(Boolean)
		.join("; ");
	if (!cookie) fail("Login did not return a session cookie.");
	return cookie;
}

async function getSessionCookie(
	baseUrl: string,
	cookie: string | undefined,
	email: string | undefined,
	password: string | undefined,
) {
	if (cookie) return cookie;
	if (!email || !password)
		fail("Provide a session cookie, or both an admin email and password.");
	const response = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email, password }),
	});
	if (!response.ok)
		fail(`Admin login failed (${response.status}): ${await response.text()}`);
	return sessionCookieFromHeaders(response.headers);
}

async function trpcRequest(
	baseUrl: string,
	cookie: string,
	path: string,
	input: unknown,
	method: "GET" | "POST",
) {
	const requestUrl = new URL(`/trpc/${path}`, baseUrl);
	const headers = new Headers({ cookie });
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

const { values, positionals } = parseArgs({
	args: process.argv.slice(2),
	options: {
		input: { type: "string" },
		url: { type: "string" },
		user: { type: "string" },
		cookie: { type: "string" },
		email: { type: "string" },
		password: { type: "string" },
		help: { type: "boolean", short: "h" },
	},
	allowPositionals: false,
	strict: true,
});

if (values.help || positionals.length) {
	console.log(usage);
	process.exit(values.help ? 0 : 1);
}

const baseUrl = (values.url ?? process.env.SOLAR_URL ?? DEFAULT_URL).replace(
	/\/$/,
	"",
);
const cookie = await getSessionCookie(
	baseUrl,
	values.cookie ?? process.env.SOLAR_SESSION_COOKIE,
	values.email ?? process.env.SOLAR_ADMIN_EMAIL ?? DEFAULT_USER_EMAIL,
	values.password ?? process.env.SOLAR_ADMIN_PASSWORD ?? "password",
);
const userEmail =
	values.user ?? process.env.SOLAR_LOCAL_USER_EMAIL ?? DEFAULT_USER_EMAIL;
const users = (await trpcRequest(
	baseUrl,
	cookie,
	"admin.listUsers",
	undefined,
	"GET",
)) as { id: string; email: string }[];
const user = users.find(
	(candidate) => candidate.email.toLowerCase() === userEmail.toLowerCase(),
);
if (!user) fail(`No user found for ${userEmail} at ${baseUrl}.`);

const input = values.input ?? DEFAULT_INPUT;
let history: unknown;
try {
	history = JSON.parse(await Bun.file(input).text());
} catch (error) {
	fail(
		`Could not read history from ${input}: ${error instanceof Error ? error.message : String(error)}`,
	);
}
const summary = await trpcRequest(
	baseUrl,
	cookie,
	"admin.history.import",
	{ userId: user.id, history },
	"POST",
);
console.log(`Imported ${input} for ${userEmail}.`);
console.log(JSON.stringify(summary, null, 2));
