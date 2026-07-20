import { trpcServer } from "@hono/trpc-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import * as path from "node:path";
import { logger } from "./logger";
import { config } from "./config";
import { auth } from "./auth";
import { db, sqlite } from "./db";
import { migrateAuth } from "./db/migrate-auth";
import { migrateToLatest } from "./db/migrate";
import { seedDevUser } from "./db/seed-dev";
import { attachmentRoutes } from "./chat/attachmentRoutes";
import { chatRoutes } from "./chat/routes";
import { createContext } from "./trpc/context";
import { appRouter } from "./trpc/router";

const isProduction = process.env.NODE_ENV === "production";
// Production serves the bundled web assets.
const index = isProduction
	? undefined
	: (await import("@solar/web/index.html")).default;
const webDirectory = path.join(
	import.meta.dir,
	isProduction && path.basename(import.meta.dir) === "src"
		? "../dist/web"
		: "web",
);
const webPublicDirectory = path.resolve(import.meta.dir, "../../web/public");
const webIndex = Bun.file(path.join(webDirectory, "index.html"));
const hashedAssetName = /-[a-z0-9]{8}\.[^.]+$/i;

function fileForPath(directory: string, pathname: string) {
	let relativePath: string;
	try {
		relativePath = decodeURIComponent(pathname).replace(/^\/+/, "");
	} catch {
		return;
	}

	const filePath = path.resolve(directory, relativePath);
	return filePath.startsWith(`${directory}${path.sep}`)
		? Bun.file(filePath)
		: undefined;
}

function isFileRequest(pathname: string) {
	return path.extname(pathname) !== "";
}

function staticCacheControl(pathname: string) {
	const filename = path.basename(pathname);
	if (
		pathname === "/" ||
		filename === "index.html" ||
		filename === "manifest.webmanifest" ||
		filename === "sw.js"
	) {
		return "no-cache";
	}
	if (hashedAssetName.test(filename))
		return "public, max-age=31536000, immutable";
	return "public, max-age=3600";
}

async function serveProductionWeb(req: Request) {
	const pathname = new URL(req.url).pathname;
	const file = fileForPath(
		webDirectory,
		pathname === "/" ? "/index.html" : pathname,
	);
	if (file && (await file.exists())) {
		return new Response(file, {
			headers: { "Cache-Control": staticCacheControl(pathname) },
		});
	}
	if (isFileRequest(pathname))
		return new Response("Not Found", { status: 404 });
	return new Response(webIndex, { headers: { "Cache-Control": "no-cache" } });
}

async function serveDevelopmentPublicFile(req: Request) {
	const pathname = new URL(req.url).pathname;
	const file = fileForPath(webPublicDirectory, pathname);
	if (!file || !(await file.exists()))
		return new Response("Not Found", { status: 404 });
	return new Response(file, {
		headers: { "Cache-Control": staticCacheControl(pathname) },
	});
}

if (
	process.env.NODE_ENV === "production" &&
	(config.authSecret === "dev-insecure-secret-change-me" ||
		config.authSecret.length < 32)
) {
	logger.warn(
		"BETTER_AUTH_SECRET is missing, short, or uses the development fallback",
	);
}

// Provision the single solar.db: our app migrations + Better Auth's own tables.
await migrateToLatest();
await migrateAuth();
await db
	.insertInto("app_meta")
	.values({ key: "schema_version", value: "1" })
	.onConflict((oc) => oc.column("key").doUpdateSet({ value: "1" }))
	.execute();
await seedDevUser();

const app = new Hono();

app.use("*", async (c, next) => {
	const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
	const startedAt = performance.now();
	c.header("x-request-id", requestId);
	try {
		await next();
		logger
			.withMetadata({
				requestId,
				method: c.req.method,
				path: c.req.path,
				status: c.res.status,
				durationMs: Math.round(performance.now() - startedAt),
			})
			.debug("request completed");
	} catch (error) {
		logger
			.withError(error)
			.withMetadata({ requestId, method: c.req.method, path: c.req.path })
			.error("request failed");
		throw error;
	}
});

app.onError((error, c) => {
	logger
		.withError(error)
		.withMetadata({ method: c.req.method, path: c.req.path })
		.error("unhandled request error");
	return c.json(
		{ error: error instanceof Error ? error.message : String(error) },
		500,
	);
});

// Dev-only permissive CORS: accept any origin. We reflect the request origin
// (rather than a literal "*") so credentialed requests — cookie-based Better
// Auth sessions — keep working. Never enabled in production.
if (process.env.NODE_ENV !== "production") {
	app.use(
		"*",
		cors({
			origin: (origin) => origin ?? "*",
			credentials: true,
		}),
	);
}

app.get("/healthz", (c) => {
	c.header("Cache-Control", "no-store");
	return c.json({ ok: true });
});

app.use("/api/*", async (c, next) => {
	await next();
	c.header("Cache-Control", "private, no-store");
});

app.use("/trpc/*", async (c, next) => {
	await next();
	c.header("Cache-Control", "private, no-store");
});

// Better Auth handles all of /api/auth/*.
app.all("/api/auth/api-key/*", (c) => c.notFound());
app.all("/api/auth/sign-up/email", (c) => c.notFound());
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// Decoupled chat streaming (SSE) — see chat/generationManager.ts.
app.route("/api/chat", chatRoutes);
app.route("/api/attachments", attachmentRoutes);

app.use(
	"/trpc/*",
	trpcServer({
		router: appRouter,
		endpoint: "/trpc",
		createContext: (opts, c) => createContext(opts, c),
	}),
);

// Bun's fullstack server bundles and serves the React app (with HMR in dev)
// from the HTML entrypoint. No Vite. More-specific API routes are matched before
// the "/*" HTML catch-all and delegate to Hono.
const server = Bun.serve({
	port: config.port,
	routes: {
		"/trpc/*": (req) => app.fetch(req),
		"/api/auth/*": (req) => app.fetch(req),
		"/api/chat/*": (req) => app.fetch(req),
		"/api/chat": (req) => app.fetch(req),
		"/api/attachments/*": (req) => app.fetch(req),
		"/api/attachments": (req) => app.fetch(req),
		"/healthz": (req) => app.fetch(req),
		"/manifest.webmanifest": isProduction
			? serveProductionWeb
			: serveDevelopmentPublicFile,
		"/icons/*": isProduction ? serveProductionWeb : serveDevelopmentPublicFile,
		"/fonts/*": isProduction ? serveProductionWeb : serveDevelopmentPublicFile,
		"/sw.js": isProduction
			? serveProductionWeb
			: () => new Response("Not Found", { status: 404 }),
		"/*": isProduction ? serveProductionWeb : index!,
	},
	development: !isProduction ? { hmr: true } : false,
});

logger
	.withMetadata({ url: server.url.toString() })
	.info("solar server listening");

// Graceful shutdown (Bun exits immediately on SIGTERM by default, dropping
// in-flight requests). Stop accepting connections, drain, close the DB, exit.
const shutdown = async (signal: string) => {
	logger.withMetadata({ signal }).info("solar server shutting down");
	await server.stop();
	sqlite.close();
	process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
