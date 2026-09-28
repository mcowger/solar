import { trpcServer } from "@hono/trpc-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import * as path from "node:path";
import { getLogLevel, logger } from "./logger";
import { config } from "./config";
import { auth } from "./auth";
import { OAUTH_CALLBACK_PATH, oauthCallbackPathIsRegistered } from "./oidc";
import type {} from "./db";
import { db, sqlite } from "./db";
import { migrateAuth } from "./db/migrate-auth";
import { migrateToLatest } from "./db/migrate";
import { seedDevUser } from "./db/seed-dev";
import { attachmentRoutes } from "./chat/attachmentRoutes";
import { imageRoutes } from "./images/routes";
import { imageGenerationService } from "./images/service";
import { chatRoutes } from "./chat/routes";
import { piBridgeRoutes } from "./pi/bridge/server";
import { piSessionManager } from "./pi/manager";
import { syncPiModelConfig } from "./pi/models";
import { createContext } from "./trpc/context";
import { appRouter } from "./trpc/router";
import { traceJsonBody } from "./requestTracing";

const isProduction = process.env.NODE_ENV === "production";
// Global Bun.serve body cap. Must cover attachment uploads (16 MiB file +
// multipart overhead) and pi bridge provider payloads (which carry base64
// history images) posted to /internal/pi-bridge/inject-documents.
const MAX_REQUEST_BODY_BYTES = 50 * 1024 * 1024;
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

function traceRequestHeaders(headers: Headers) {
	return {
		contentType: headers.get("content-type") ?? null,
		hasAuthorization: headers.has("authorization"),
		hasCookie: headers.has("cookie"),
		hasApiKey: headers.has("x-api-key"),
	};
}

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
		filename === "sw.js" ||
		filename === "favicon.ico"
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

// OIDC needs all three of issuer, client id, and client secret; a partial set
// silently leaves sign-in unavailable, so say so instead.
const oidcParts = [
	process.env.OIDC_ISSUER,
	process.env.OIDC_CLIENT_ID,
	process.env.OIDC_CLIENT_SECRET,
].filter((value) => Boolean(value?.trim()));
if (oidcParts.length > 0 && oidcParts.length < 3) {
	logger.warn(
		"OIDC is partially configured and disabled; set OIDC_ISSUER, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET",
	);
}
if (
	Boolean(process.env.OIDC_ADMIN_CLAIM?.trim()) !==
	Boolean(process.env.OIDC_ADMIN_VALUE?.trim())
) {
	logger.warn(
		"OIDC role mapping is disabled; OIDC_ADMIN_CLAIM and OIDC_ADMIN_VALUE must both be set",
	);
}
// Role sync hangs off Better Auth's OAuth callback route. If a future release
// renames it the hook would just stop firing, freezing every admin role with
// nothing in the log, so fail loudly here instead.
if (config.oidc?.adminClaim) {
	const registeredPaths = Object.values(
		auth.api as unknown as Record<string, { path?: string }>,
	).map((endpoint) => endpoint?.path);
	if (!oauthCallbackPathIsRegistered(registeredPaths)) {
		logger
			.withMetadata({ expected: OAUTH_CALLBACK_PATH })
			.error(
				"OIDC role mapping will not run: better-auth no longer registers the expected OAuth callback route",
			);
	}
}

// Provision the single solar.db: our app migrations + Better Auth's own tables.
await migrateToLatest();
await migrateAuth();
await imageGenerationService.recoverActiveAttempts();
await db
	.insertInto("app_meta")
	.values({ key: "schema_version", value: "1" })
	.onConflict((oc) => oc.column("key").doUpdateSet({ value: "1" }))
	.execute();
await seedDevUser();
await syncPiModelConfig(config.port);

const app = new Hono();

app.use("*", async (c, next) => {
	const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
	const startedAt = performance.now();
	c.header("x-request-id", requestId);
	try {
		const requestTrace = await traceJsonBody(c.req.raw);
		logger
			.withMetadata({
				requestId,
				method: c.req.method,
				path: c.req.path,
				requestHeaders: traceRequestHeaders(c.req.raw.headers),
				request: requestTrace,
			})
			.trace("request received");
		await next();
		const responseTrace = await traceJsonBody(c.res);
		logger
			.withMetadata({
				requestId,
				method: c.req.method,
				path: c.req.path,
				status: c.res.status,
				durationMs: Math.round(performance.now() - startedAt),
				responseHeaders: traceRequestHeaders(c.res.headers),
				response: responseTrace,
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

app.route("/api/chat", chatRoutes);
app.route("/api/attachments", attachmentRoutes);
app.route("/api/images", imageRoutes);

app.use(
	"/trpc/*",
	trpcServer({
		router: appRouter,
		endpoint: "/trpc",
		createContext: (opts, c) => createContext(opts, c),
	}),
);

/**
 * /internal/* — loopback-only surface used by spawned pi child processes
 * (tool/attachment bridge, mock LLM). The bearer token is also checked per
 * route; this IP gate is defense in depth for a mis-issued token never
 * leaving the box.
 */
function dispatchInternalRequest(
	request: Request,
	server: { requestIP: (req: Request) => { address: string } | null },
): Promise<Response> | Response {
	const remote = server.requestIP(request)?.address ?? "";
	const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote);
	if (!loopback) return new Response("Forbidden", { status: 403 });
	return piBridgeRoutes.fetch(request);
}

async function dispatchAppRequest(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const metadata = {
		method: request.method,
		path: url.pathname,
		queryKeys: [...new Set(url.searchParams.keys())].sort(),
	};
	logger.withMetadata(metadata).info("request dispatched to Hono");
	const response = await app.fetch(request);
	logger
		.withMetadata({
			...metadata,
			status: response.status,
			contentType: response.headers.get("content-type"),
		})
		.info("response returned by Hono");
	return response;
}

// Bun's fullstack server bundles and serves the React app (with HMR in dev)
// from the HTML entrypoint. No Vite. More-specific API routes are matched before
// the "/*" HTML catch-all and delegate to Hono.
const server = Bun.serve({
	port: config.port,
	maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
	routes: {
		"/trpc/*": dispatchAppRequest,
		"/api/auth/*": dispatchAppRequest,
		"/api/chat/*": dispatchAppRequest,
		"/api/chat": dispatchAppRequest,
		"/api/attachments/*": dispatchAppRequest,
		"/api/attachments": dispatchAppRequest,
		"/api/images/*": dispatchAppRequest,
		"/api/images": dispatchAppRequest,
		"/api/*": dispatchAppRequest,
		"/internal/*": dispatchInternalRequest,
		"/health": dispatchAppRequest,
		"/healthz": dispatchAppRequest,
		"/manifest.webmanifest": isProduction
			? serveProductionWeb
			: serveDevelopmentPublicFile,
		"/favicon.ico": isProduction
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
logger
	.withMetadata({
		logLevel: getLogLevel(),
		openWebUiTracing: true,
	})
	.info("server logging configured");

// Graceful shutdown (Bun exits immediately on SIGTERM by default, dropping
// in-flight requests). Stop accepting connections, drain, close the DB, exit.
const shutdown = async (signal: string) => {
	logger.withMetadata({ signal }).info("solar server shutting down");
	await imageGenerationService.shutdown();
	await piSessionManager.shutdown();
	await server.stop();
	sqlite.close();
	process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
