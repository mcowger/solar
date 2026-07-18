import { parseArgs } from "node:util";

const DEFAULT_URL = "http://localhost:3000";
const SESSION_COOKIE_ENV = "SOLAR_SESSION_COOKIE";
const ADMIN_EMAIL_ENV = "SOLAR_ADMIN_EMAIL";
const ADMIN_PASSWORD_ENV = "SOLAR_ADMIN_PASSWORD";

const usage = `Usage:
  bun run chat-history -- list --user <userId> [authentication options]
  bun run chat-history -- inspect --chat <chatId> [authentication options]
  bun run chat-history -- export --user <userId> --output <path> [authentication options]
  bun run chat-history -- import --user <userId> --input <path> [authentication options]

Authentication options:
  --cookie <cookie>       Admin session cookie (or ${SESSION_COOKIE_ENV})
  --email <email>         Admin email (or ${ADMIN_EMAIL_ENV})
  --password <password>   Admin password (or ${ADMIN_PASSWORD_ENV})
  --url <url>             Solar URL (or SOLAR_URL, default ${DEFAULT_URL})
`;

type TrpcResponse = {
  result?: { data?: { json?: unknown } | unknown };
  error?: { json?: { message?: string } };
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readRequired(value: string | undefined, name: string) {
  if (!value) fail(`Missing required --${name} option.\n\n${usage}`);
  return value;
}

function sessionCookieFromHeaders(headers: Headers) {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = getSetCookie ? getSetCookie.call(headers) : [headers.get("set-cookie") ?? ""];
  const cookie = cookies
    .map((value) => value.split(";", 1)[0])
    .filter(Boolean)
    .join("; ");
  if (!cookie) fail("Login did not return a session cookie.");
  return cookie;
}

async function getSessionCookie(baseUrl: string, cookie: string | undefined, email: string | undefined, password: string | undefined) {
  if (cookie) return cookie;
  if (!email || !password) {
    fail(`Set ${SESSION_COOKIE_ENV}, or provide both --email and --password.`);
  }

  const response = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    const body = await response.text();
    fail(`Admin login failed (${response.status}): ${body}`);
  }
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
  if (method === "GET") {
    requestUrl.searchParams.set("input", JSON.stringify({ json: input }));
  } else {
    headers.set("content-type", "application/json");
    body = JSON.stringify({ json: input });
  }

  const response = await fetch(requestUrl, { method, headers, body });
  const payload = await response.json() as TrpcResponse;
  if (!response.ok || payload.error) {
    fail(`tRPC ${path} failed: ${payload.error?.json?.message ?? response.statusText}`);
  }
  const data = payload.result?.data;
  if (data === undefined) fail(`tRPC ${path} returned no data.`);
  return typeof data === "object" && data !== null && "json" in data
    ? (data as { json: unknown }).json
    : data;
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    user: { type: "string" },
    chat: { type: "string" },
    input: { type: "string" },
    output: { type: "string" },
    cookie: { type: "string" },
    email: { type: "string" },
    password: { type: "string" },
    url: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
  strict: true,
});

if (values.help || positionals.length !== 1) {
  console.log(usage);
  process.exit(values.help ? 0 : 1);
}

const command = positionals[0];
if (!["list", "inspect", "export", "import"].includes(command)) {
  fail(`Unknown command: ${command}\n\n${usage}`);
}

const baseUrl = (values.url ?? process.env.SOLAR_URL ?? DEFAULT_URL).replace(/\/$/, "");
const cookie = await getSessionCookie(
  baseUrl,
  values.cookie ?? process.env[SESSION_COOKIE_ENV],
  values.email ?? process.env[ADMIN_EMAIL_ENV],
  values.password ?? process.env[ADMIN_PASSWORD_ENV],
);

if (command === "list") {
  const userId = readRequired(values.user, "user");
  const chatIds = await trpcRequest(baseUrl, cookie, "admin.debug.chatIds", { userId }, "GET");
  console.log(JSON.stringify(chatIds, null, 2));
}

if (command === "inspect") {
  const chatId = readRequired(values.chat, "chat");
  const rows = await trpcRequest(baseUrl, cookie, "admin.debug.chatRows", { chatId }, "GET");
  console.log(JSON.stringify(rows, null, 2));
}

if (command === "export") {
  const userId = readRequired(values.user, "user");
  const output = readRequired(values.output, "output");
  const history = await trpcRequest(baseUrl, cookie, "admin.history.export", { userId }, "GET");
  await Bun.write(output, `${JSON.stringify(history, null, 2)}\n`);
  console.log(`Exported chat history for ${userId} to ${output}`);
}

if (command === "import") {
  const userId = readRequired(values.user, "user");
  const input = readRequired(values.input, "input");
  let history: unknown;
  try {
    history = JSON.parse(await Bun.file(input).text());
  } catch (error) {
    fail(`Could not read history from ${input}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const summary = await trpcRequest(baseUrl, cookie, "admin.history.import", { userId, history }, "POST");
  console.log(JSON.stringify(summary, null, 2));
}
