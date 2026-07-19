import { parseArgs } from "node:util";

const DEFAULT_STAGING_URL = "https://solar.home.cowger.us";
const DEFAULT_LOCAL_URL = "http://localhost:3000";
const DEFAULT_STAGING_USER_EMAIL = "devuser@cowger.us";
const DEFAULT_LOCAL_USER_EMAIL = "admin@solar.local";
const DEFAULT_OUTPUT = ".staging-history.json";

const usage = `Usage: bun run sync-staging-history -- [options]

Exports a staging user's history through admin.history.export, writes it to a
gitignored bundle, then restores it locally through admin.history.import.

Options:
  --output <path>          Bundle path (default ${DEFAULT_OUTPUT})
  --staging-url <url>      Source URL (default ${DEFAULT_STAGING_URL})
  --local-url <url>        Destination URL (default ${DEFAULT_LOCAL_URL})
  --staging-user <email>   Source user (default ${DEFAULT_STAGING_USER_EMAIL})
  --local-user <email>     Destination user (default ${DEFAULT_LOCAL_USER_EMAIL})
  --staging-cookie <cookie>
  --staging-email <email>
  --staging-password <password>
  --local-cookie <cookie>
  --local-email <email>
  --local-password <password>
`;

type TrpcResponse = {
	result?: { data?: { json?: unknown } | unknown };
	error?: { json?: { message?: string } };
};

type User = { id: string; email: string };

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

async function userIdForEmail(baseUrl: string, cookie: string, email: string) {
	const users = (await trpcRequest(
		baseUrl,
		cookie,
		"admin.listUsers",
		undefined,
		"GET",
	)) as User[];
	const user = users.find(
		(candidate) => candidate.email.toLowerCase() === email.toLowerCase(),
	);
	if (!user) fail(`No user found for ${email} at ${baseUrl}.`);
	return user.id;
}

const { values, positionals } = parseArgs({
	args: process.argv.slice(2),
	options: {
		output: { type: "string" },
		"staging-url": { type: "string" },
		"local-url": { type: "string" },
		"staging-user": { type: "string" },
		"local-user": { type: "string" },
		"staging-cookie": { type: "string" },
		"staging-email": { type: "string" },
		"staging-password": { type: "string" },
		"local-cookie": { type: "string" },
		"local-email": { type: "string" },
		"local-password": { type: "string" },
		help: { type: "boolean", short: "h" },
	},
	allowPositionals: false,
	strict: true,
});

if (values.help || positionals.length) {
	console.log(usage);
	process.exit(values.help ? 0 : 1);
}

const stagingUrl = (
	values["staging-url"] ??
	process.env.SOLAR_STAGING_URL ??
	DEFAULT_STAGING_URL
).replace(/\/$/, "");
const localUrl = (
	values["local-url"] ??
	process.env.SOLAR_URL ??
	DEFAULT_LOCAL_URL
).replace(/\/$/, "");
const stagingCookie = await getSessionCookie(
	stagingUrl,
	values["staging-cookie"] ?? process.env.SOLAR_STAGING_SESSION_COOKIE,
	values["staging-email"] ??
		process.env.SOLAR_STAGING_ADMIN_EMAIL ??
		"devuser@cowger.us",
	values["staging-password"] ??
		process.env.SOLAR_STAGING_ADMIN_PASSWORD ??
		"password",
);
const localCookie = await getSessionCookie(
	localUrl,
	values["local-cookie"] ?? process.env.SOLAR_SESSION_COOKIE,
	values["local-email"] ??
		process.env.SOLAR_ADMIN_EMAIL ??
		DEFAULT_LOCAL_USER_EMAIL,
	values["local-password"] ?? process.env.SOLAR_ADMIN_PASSWORD ?? "password",
);
const stagingUserId = await userIdForEmail(
	stagingUrl,
	stagingCookie,
	values["staging-user"] ??
		process.env.SOLAR_STAGING_USER_EMAIL ??
		DEFAULT_STAGING_USER_EMAIL,
);
const localUserId = await userIdForEmail(
	localUrl,
	localCookie,
	values["local-user"] ??
		process.env.SOLAR_LOCAL_USER_EMAIL ??
		DEFAULT_LOCAL_USER_EMAIL,
);
const history = await trpcRequest(
	stagingUrl,
	stagingCookie,
	"admin.history.export",
	{ userId: stagingUserId },
	"GET",
);
const output = values.output ?? DEFAULT_OUTPUT;
await Bun.write(output, `${JSON.stringify(history, null, 2)}\n`);
const summary = await trpcRequest(
	localUrl,
	localCookie,
	"admin.history.import",
	{ userId: localUserId, history },
	"POST",
);
console.log(
	`Exported staging history to ${output} and restored it for ${values["local-user"] ?? process.env.SOLAR_LOCAL_USER_EMAIL ?? DEFAULT_LOCAL_USER_EMAIL}.`,
);
console.log(JSON.stringify(summary, null, 2));
