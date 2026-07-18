import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelSelection } from "../chat/catalog";
import type { ProviderCallTelemetry } from "./types";

export type TelemetryMetadata = Pick<
  ProviderCallTelemetry,
  | "contextPolicySource"
  | "contextPolicyEnabled"
  | "contextPolicyState"
  | "overflowed"
  | "retryAttempt"
  | "compactionTokensBefore"
  | "compactionTokensAfter"
>;

export type ModelCallTelemetry = Omit<
  ProviderCallTelemetry,
  "id" | "conversationId" | "messageId" | "purpose"
>;

export interface ProviderCallErrorMetadata {
  kind: "context_overflow" | "provider_error";
  retrySafe: boolean;
  outputStarted: boolean;
  toolStepsCompleted: boolean;
}

export type ProviderCallObservation = ModelCallTelemetry & {
  error?: ProviderCallErrorMetadata;
};

export type ChatProviderCallPurpose = "chat" | "tool_loop";

export interface ChatProviderCall {
  purpose: ChatProviderCallPurpose;
  observation: ProviderCallObservation;
}

const OVERFLOW_PATTERN = /prompt is too long|request_too_large|input is too long for requested model|exceeds (?:the )?(?:context window|(?:model'?s )?maximum context length|the maximum allowed input length)|input token count.*exceeds the maximum|maximum prompt length is \d+|reduce the length of the messages|maximum context length is \d+ tokens|exceeds the available context size|greater than the context length|context[_ ]length[_ ]exceeded|token limit exceeded/i;
const NON_OVERFLOW_PATTERN = /rate limit|too many requests|throttling error|service unavailable/i;

function isContextOverflow(message: AssistantMessage | undefined, error: unknown, contextWindow?: number): boolean {
  const errorMessage = message?.errorMessage ?? (error instanceof Error ? error.message : "");
  if (errorMessage && !NON_OVERFLOW_PATTERN.test(errorMessage) && OVERFLOW_PATTERN.test(errorMessage)) return true;
  if (!message || !contextWindow) return false;
  const inputTokens = message.usage.input + message.usage.cacheRead;
  return (message.stopReason === "stop" && inputTokens > contextWindow) ||
    (message.stopReason === "length" && message.usage.output === 0 && inputTokens >= contextWindow * 0.99);
}

export function modelCallTelemetry(
  selection: ModelSelection,
  message: AssistantMessage | undefined,
  latencyMs: number,
  metadata: TelemetryMetadata = {},
  contextWindow?: number,
  error?: unknown,
  outputStarted = false,
  toolStepsCompleted = false,
): ProviderCallObservation {
  const overflowed = isContextOverflow(message, error, contextWindow);
  const cost = message?.usage.cost?.total;
  return {
    provider: selection.provider,
    api: message?.api ?? selection.api,
    modelId: message?.responseModel ?? message?.model ?? selection.modelId,
    inputTokens: message?.usage.input,
    outputTokens: message?.usage.output,
    cacheReadTokens: message?.usage.cacheRead,
    cacheWriteTokens: message?.usage.cacheWrite,
    // pi-ai calculates this total from the resolved model's token-rate metadata.
    estimatedCostMicros: typeof cost === "number" && Number.isFinite(cost)
      ? Math.round(cost * 1_000_000)
      : undefined,
    latencyMs,
    ...metadata,
    overflowed: metadata.overflowed ?? overflowed,
    ...(error || message?.stopReason === "error" ? {
      error: {
        kind: overflowed ? "context_overflow" : "provider_error",
        retrySafe: overflowed && !outputStarted && !toolStepsCompleted && (metadata.retryAttempt ?? 0) === 0,
        outputStarted,
        toolStepsCompleted,
      },
    } : {}),
  };
}
