/**
 * PiSessionManager — owns the pool of spawned `pi --mode rpc` child processes
 * (via pi's own exported RpcClient), one per actively-generating conversation.
 *
 * A process is spawned ONLY for live generation: reads use the library path
 * (./turns.ts). Identity is pure convention (plan: Process & session
 * lifecycle — Identity): conversationId maps to `--session-id
 * <conversationId>` + `--session-dir ${SOLAR_PI_AGENT_DIR}/sessions/<conversationId>`.
 */
import { mkdirSync } from "node:fs";
import { delimiter } from "node:path";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { logger } from "../logger";
import { issueBridgeToken, revokeBridgeToken } from "./bridge/tokens";
import type { BridgeIdentity } from "./bridge/tokens";
import {
	ensurePiDirs,
	ensurePiNodeShim,
	piNodeShimDir,
	piBridgeExtensionPath,
	piCliPath,
	piConfig,
	piCwdDir,
	piSessionDir,
} from "./config";

export interface AcquirePiSessionOptions {
	identity: BridgeIdentity;
	/** Fully-rendered system prompt (Solar owns framing; pi's coding-agent
	 * default is never used). */
	systemPrompt: string;
	/** Skill catalog to append to the system prompt, if any. */
	appendSystemPrompt?: string;
	/** Reachable URL Solar serves on (loopback) for the bridge extension. */
	bridgeUrl: string;
	/** Solar selection mapped onto pi provider/model ids. */
	provider: string;
	modelId: string;
	/** Called by the manager the moment the child's process exits. */
	onExit?: (conversationId: string) => void;
}

export interface LivePiSession {
	conversationId: string;
	client: RpcClient;
	/** Token the child's extension callbacks authenticate with. */
	bridgeToken: string;
	lastActivityAt: number;
	generating: boolean;
	/** Distinguishes respawns with different startup arguments. */
	spawnSignature: string;
}

/**
 * pi's credential resolution also consults ambient `*_API_KEY` environment
 * variables (see pi-ai's env-api-keys). Solar's NEVER lets the host machine
 * configure providers: all auth a pi child sees comes from
 * `${SOLAR_PI_AGENT_DIR}/auth.json`, which Solar regenerates from its own DB.
 * Blank out every known provider key variable so a developer box or container
 * image carrying stray keys cannot change what "available" means.
 */
const AMBIENT_PROVIDER_KEY_VARS = [
	"AI_GATEWAY_API_KEY",
	"ANTHROPIC_API_KEY",
	"ANT_LING_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"BASETEN_API_KEY",
	"CEREBRAS_API_KEY",
	"CLOUDFLARE_API_KEY",
	"DEEPSEEK_API_KEY",
	"FIREWORKS_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_CLOUD_API_KEY",
	"GOOGLE_GENERATIVE_AI_API_KEY",
	"GROQ_API_KEY",
	"KIMI_API_KEY",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"MISTRAL_API_KEY",
	"MOONSHOT_API_KEY",
	"NVIDIA_API_KEY",
	"OPENAI_API_KEY",
	"OPENCODE_API_KEY",
	"OPENROUTER_API_KEY",
	"QWEN_TOKEN_PLAN_API_KEY",
	"QWEN_TOKEN_PLAN_CN_API_KEY",
	"RADIUS_API_KEY",
	"TOGETHER_API_KEY",
	"XAI_API_KEY",
	"XIAOMI_API_KEY",
	"XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"XIAOMI_TOKEN_PLAN_CN_API_KEY",
	"XIAOMI_TOKEN_PLAN_SGP_API_KEY",
] as const;

function scrubbedChildEnv(
	options: AcquirePiSessionOptions,
	bridgeToken: string,
): Record<string, string> {
	ensurePiNodeShim();
	const env: Record<string, string> = {
		PI_CODING_AGENT_DIR: piConfig.agentDir,
		PI_OFFLINE: "1",
		SOLAR_PI_BRIDGE_URL: options.bridgeUrl,
		SOLAR_PI_BRIDGE_TOKEN: bridgeToken,
		SOLAR_PI_BRIDGE_TIMEOUT_MS: String(piConfig.bridgeTimeoutMs),
		// RpcClient spawns `node` — we never run node, so redirect that name to
		// bun via our shim, regardless of what the caller's PATH contains.
		PATH: `${piNodeShimDir()}${delimiter}${process.env.PATH ?? ""}`,
	};
	for (const name of AMBIENT_PROVIDER_KEY_VARS) env[name] = "";
	return env;
}

/** Hash-free identity for spawn-affecting args; reused handles must match it. */
function spawnSignature(options: AcquirePiSessionOptions): string {
	return JSON.stringify([
		options.systemPrompt,
		options.appendSystemPrompt ?? null,
		options.bridgeUrl,
	]);
}

export class PiSessionManager {
	private sessions = new Map<string, LivePiSession>();
	private pending = new Map<string, Promise<LivePiSession>>();
	private reaper: ReturnType<typeof setInterval> | null = null;

	constructor() {
		this.reaper = setInterval(() => this.reapIdle(), 30_000);
		this.reaper.unref?.();
	}

	get(conversationId: string): LivePiSession | undefined {
		return this.sessions.get(conversationId);
	}

	/**
	 * Spawn (or reuse) the pi process for a conversation. Serialized per
	 * conversation so concurrent callers never double-spawn.
	 */
	async acquire(options: AcquirePiSessionOptions): Promise<LivePiSession> {
		const { conversationId } = options.identity;
		const existing = this.sessions.get(conversationId);
		if (existing && existing.spawnSignature === spawnSignature(options)) {
			existing.lastActivityAt = Date.now();
			return existing;
		}
		if (existing) await this.drop(conversationId);

		const inflight = this.pending.get(conversationId);
		if (inflight) return inflight;

		const spawn = this.spawn(options).finally(() =>
			this.pending.delete(conversationId),
		);
		this.pending.set(conversationId, spawn);
		return spawn;
	}

	private async spawn(
		options: AcquirePiSessionOptions,
	): Promise<LivePiSession> {
		const { conversationId } = options.identity;
		this.enforcePoolLimit();
		ensurePiDirs();
		mkdirSync(piCwdDir(conversationId), { recursive: true });
		mkdirSync(piSessionDir(conversationId), { recursive: true });

		const bridgeToken = issueBridgeToken(options.identity);
		const client = new RpcClient({
			cliPath: piCliPath(),
			cwd: piCwdDir(conversationId),
			env: scrubbedChildEnv(options, bridgeToken),
			args: [
				"--session-id",
				conversationId,
				"--session-dir",
				piSessionDir(conversationId),
				"--no-builtin-tools",
				"--no-extensions",
				"--extension",
				piBridgeExtensionPath(),
				"--no-skills",
				"--no-prompt-templates",
				"--no-context-files",
				"--system-prompt",
				options.systemPrompt,
				...(options.appendSystemPrompt
					? ["--append-system-prompt", options.appendSystemPrompt]
					: []),
			],
		});

		const session: LivePiSession = {
			conversationId,
			client,
			bridgeToken,
			lastActivityAt: Date.now(),
			generating: true,
			spawnSignature: spawnSignature(options),
		};

		await client.start();
		// Startup watchdog: the child must answer an RPC roundtrip within the
		// startup window — that's the "first stdout line" liveness check (plan:
		// Watchdog — Startup timeout).
		try {
			await Promise.race([
				client.getState(),
				new Promise((_resolve, reject) =>
					setTimeout(
						() => reject(new Error("pi startup timeout (no RPC response)")),
						piConfig.startupTimeoutMs,
					),
				),
			]);
		} catch (error) {
			await this.teardownSession(session);
			throw error;
		}

		// Wire crash recovery: an unexpected exit drops the handle; the next
		// generation spawns fresh (plan: Crash recovery).
		const childProcess = (
			client as unknown as {
				process?: { once?: (ev: string, cb: () => void) => void };
			}
		).process;
		childProcess?.once?.("exit", () => {
			logger
				.withMetadata({ conversationId })
				.warn("pi process exited unexpectedly; dropping session handle");
			void this.drop(conversationId);
			options.onExit?.(conversationId);
		});

		this.sessions.set(conversationId, session);
		logger.withMetadata({ conversationId }).info("pi session process spawned");
		return session;
	}

	/** Kill and forget a session (crash, eviction, force-stop, cwd change). */
	async drop(conversationId: string): Promise<void> {
		const session = this.sessions.get(conversationId);
		if (!session) return;
		this.sessions.delete(conversationId);
		await this.teardownSession(session);
	}

	private async teardownSession(session: LivePiSession): Promise<void> {
		revokeBridgeToken(session.bridgeToken);
		try {
			await session.client.stop();
		} catch {
			// Already gone.
		}
	}

	/** Reap idle sessions past SOLAR_PI_IDLE_TIMEOUT_MS. */
	reapIdle(): void {
		const now = Date.now();
		for (const session of this.sessions.values()) {
			if (session.generating) continue;
			if (now - session.lastActivityAt > piConfig.idleTimeoutMs) {
				logger
					.withMetadata({ conversationId: session.conversationId })
					.info("reaping idle pi session");
				void this.drop(session.conversationId);
			}
		}
	}

	private enforcePoolLimit(): void {
		if (this.sessions.size < piConfig.maxProcesses) return;
		let oldest: LivePiSession | null = null;
		for (const session of this.sessions.values()) {
			if (session.generating) continue;
			if (!oldest || session.lastActivityAt < oldest.lastActivityAt)
				oldest = session;
		}
		if (!oldest)
			throw new Error(
				`pi process pool exhausted (${piConfig.maxProcesses} concurrent generations)`,
			);
		// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
		void this.drop(oldest.conversationId);
	}

	async shutdown(): Promise<void> {
		if (this.reaper) clearInterval(this.reaper);
		this.reaper = null;
		await Promise.all(
			[...this.sessions.keys()].map((conversationId) =>
				this.drop(conversationId),
			),
		);
	}
}

export const piSessionManager = new PiSessionManager();
