/** Configuration for the pi-backed chat engine (docs/planning/pi-rpc-rewrite.md). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter } from "node:path";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config";

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_STALL_TIMEOUT_MS = 90_000;
const DEFAULT_ABORT_GRACE_MS = 5_000;
const DEFAULT_MAX_PROCESSES = 8;
const BRIDGE_TIMEOUT_HEADROOM_MS = 15_000;

function positiveIntEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const piConfig = {
	/** Chat engine: pi by default — chat-v2 is the legacy fallback allowed only
	 * via an explicit SOLAR_CHAT_ENGINE=chat-v2 opt-out. Read dynamically so
	 * tests can flip it per file without module-cache pain. */
	get enabled(): boolean {
		const raw = process.env.SOLAR_CHAT_ENGINE;
		if (!raw) return true;
		return raw.trim().toLowerCase() !== "chat-v2";
	},

	/** Root of pi's agent state (auth.json, models.json, sessions/). */
	agentDir: resolve(
		process.env.SOLAR_PI_AGENT_DIR ?? join(dataRoot(), "pi-agent"),
	),
	/** Scratch directories handed to pi as cwd (never meaningfully written). */
	cwdRoot: resolve(process.env.SOLAR_PI_CWD_ROOT ?? join(dataRoot(), "pi-cwd")),

	maxProcesses: positiveIntEnv("SOLAR_PI_MAX_PROCESSES", DEFAULT_MAX_PROCESSES),
	idleTimeoutMs: positiveIntEnv(
		"SOLAR_PI_IDLE_TIMEOUT_MS",
		DEFAULT_IDLE_TIMEOUT_MS,
	),
	startupTimeoutMs: positiveIntEnv(
		"SOLAR_PI_STARTUP_TIMEOUT_MS",
		DEFAULT_STARTUP_TIMEOUT_MS,
	),
	stallTimeoutMs: positiveIntEnv(
		"SOLAR_PI_STALL_TIMEOUT_MS",
		DEFAULT_STALL_TIMEOUT_MS,
	),
	abortGraceMs: positiveIntEnv(
		"SOLAR_PI_ABORT_GRACE_MS",
		DEFAULT_ABORT_GRACE_MS,
	),
	/** How long the pi child's bridge waits on Solar for one tool call: Solar's
	 * own MCP timeout plus headroom, so the MCP call ends (and reports why)
	 * before the bridge gives up on it. */
	get bridgeTimeoutMs(): number {
		return config.mcpToolTimeoutMs + BRIDGE_TIMEOUT_HEADROOM_MS;
	},
} as const;

// NOTE: pi's own RpcClient hardcodes `spawn("node", cliPath)`. Solar does not
// run node: we write a tiny shim directory with an executable named `node`
// that execs bun, and prepend it to the child's PATH (see manager.ts).

function bunExecutable(): string {
	// process.execPath is the bun binary when running under bun; production
	// packaging also runs `bun dist/index.js`, so this holds everywhere Solar
	// itself runs.
	return process.execPath;
}

export function piNodeShimDir(): string {
	return join(piConfig.agentDir, "shim");
}

/** (Re)write the `node`→bun shim script used for pi child spawns. */
export function ensurePiNodeShim(): void {
	mkdirSync(piNodeShimDir(), { recursive: true });
	const shimPath = join(piNodeShimDir(), "node");
	const want = `#!/bin/sh\nexec "${bunExecutable()}" "$@"\n`;
	const existing = existsSync(shimPath)
		? readFileSync(shimPath, "utf-8")
		: null;
	if (existing !== want) {
		writeFileSync(shimPath, want, { mode: 0o755 });
	}
}

export { bunExecutable };

function dataRoot(): string {
	// Attachments and solar.db already live under a deployment data root; do the
	// same for pi. In dev that root is the server cwd's data/; in compose it's
	// /data (see compose.yaml).
	const fromAttachments = config.attachmentsDataDir;
	if (fromAttachments.endsWith("attachments")) return dirname(fromAttachments);
	return fromAttachments;
}

export function piSessionDir(conversationId: string): string {
	return join(piConfig.agentDir, "sessions", conversationId);
}

export function piCwdDir(conversationId: string): string {
	return join(piConfig.cwdRoot, conversationId);
}

/** The generic tool-bridge extension source file, from source tree or packaged dist. */
export function piBridgeExtensionPath(): string {
	if (process.env.SOLAR_PI_EXTENSION) return process.env.SOLAR_PI_EXTENSION;
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(here, "bridge", "extension.ts"),
		join(here, "pi-extension.ts"),
	];
	for (const candidate of candidates)
		if (existsSync(candidate)) return candidate;
	throw new Error(
		`pi bridge extension not found next to ${here}; copy it beside the bundle (pi-extension.ts) or set SOLAR_PI_EXTENSION.`,
	);
}

/** Absolute path to pi-coding-agent's cli.js (RpcClient's cliPath). */
export function piCliPath(): string {
	// An explicit SOLAR_PI_CLI override wins (the packaged Docker image sets it
	// directly — a resolved absolute path beats asking a bundled file to locate
	// node_modules it may sit outside of).
	const override = process.env.SOLAR_PI_CLI;
	if (override) return override;

	// Bun.resolveSync handles the actual resolution: createRequire().resolve is
	// unreliable with packages whose `exports` map omits ./package.json, and
	// import.meta.resolveSync can hand back non-file URLs under bun. Anchoring
	// from this module is right in dev (src/ inside apps/server) and packaged
	// (dist/ sits beside apps/server/node_modules in the image).
	const here = fileURLToPath(import.meta.url);
	try {
		const mainPath = Bun.resolveSync("@earendil-works/pi-coding-agent", here);
		return join(dirname(mainPath), "cli.js");
	} catch {
		// Fall through to the packaged-image-invariant path.
	}
	const packaged = join(
		dirname(here),
		"../apps/server/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
	);
	if (existsSync(packaged)) return packaged;
	throw new Error(
		`@earendil-works/pi-coding-agent is not resolvable from ${here}; set SOLAR_PI_CLI to the cli.js path.`,
	);
}

let dirsEnsured = false;
export function ensurePiDirs(): void {
	if (dirsEnsured) return;
	dirsEnsured = true;
	mkdirSync(piConfig.agentDir, { recursive: true });
	mkdirSync(piConfig.cwdRoot, { recursive: true });
}
