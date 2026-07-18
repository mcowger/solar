import type { Context } from "@earendil-works/pi-ai";
import { db } from "../db";
import type { MessageStatus } from "../db/schema";
import { piEventToUiChunks, type UiChunk } from "./adapter";
import type { GenerationParams, ModelSelection } from "./catalog";
import { streamChat } from "./models";
import { logger } from "../logger";

interface BufferedChunk {
  id: number;
  chunk: UiChunk;
}

interface Subscriber {
  push: (bc: BufferedChunk) => void;
  end: () => void;
}

interface Generation {
  messageId: string;
  conversationId: string;
  model: string;
  selection: ModelSelection;
  params: GenerationParams;
  chunks: BufferedChunk[];
  nextId: number;
  status: "running" | "done" | "error";
  controller: AbortController;
  subscribers: Set<Subscriber>;
  text: string;
  parts: unknown | null;
  usage: { inputTokens: number; outputTokens: number } | null;
}

const encoder = new TextEncoder();
const sseChunk = (bc: BufferedChunk) =>
  encoder.encode(`id: ${bc.id}\nevent: message\ndata: ${JSON.stringify(bc.chunk)}\n\n`);
const sseDone = () => encoder.encode(`event: message\ndata: [DONE]\n\n`);

/** How long a finished generation stays resumable in memory after completion. */
const RETENTION_MS = 60_000;

/**
 * Owns server-side generation as a task decoupled from any HTTP request.
 *
 * - Generation runs against its own AbortController, not the request signal, so
 *   a client disconnect never cancels it — the completed message still persists.
 * - Chunks are buffered per message id; SSE subscribers replay missed chunks
 *   (via Last-Event-ID) then attach live. This is the WS-ready subscriber seam.
 * - Only `stop(messageId)` (an explicit user Stop) aborts a generation.
 *
 * In-memory + single-node by design (see ARCHITECTURE.md §5): buffers do not
 * survive a process restart mid-generation.
 */
class GenerationManager {
  private generations = new Map<string, Generation>();

  /** Starts a decoupled generation for an already-persisted placeholder message. */
  start(opts: {
    conversationId: string;
    messageId: string;
    context: Context;
    selection: ModelSelection;
    params: GenerationParams;
  }): void {
    const gen: Generation = {
      messageId: opts.messageId,
      conversationId: opts.conversationId,
      model: `${opts.selection.provider}/${opts.selection.modelId}`,
      selection: opts.selection,
      params: opts.params,
      chunks: [],
      nextId: 1,
      status: "running",
      controller: new AbortController(),
      subscribers: new Set(),
      text: "",
      parts: null,
      usage: null,
    };
    this.generations.set(opts.messageId, gen);
    logger.withMetadata({ conversationId: opts.conversationId, messageId: opts.messageId, model: gen.model }).info("generation started");
    void this.run(gen, opts.context);
  }

  isActive(messageId: string): boolean {
    return this.generations.get(messageId)?.status === "running";
  }

  /** Explicit user Stop — the only thing that cancels a generation. */
  stop(messageId: string): boolean {
    const gen = this.generations.get(messageId);
    if (!gen || gen.status !== "running") return false;
    gen.controller.abort();
    return true;
  }

  /**
   * Subscribe to a generation's stream as SSE, replaying any chunks after
   * `lastEventId`. Cancelling the returned stream (client disconnect) only
   * detaches the subscriber; it never aborts the generation.
   */
  subscribe(messageId: string, lastEventId = 0): ReadableStream<Uint8Array> {
    const gen = this.generations.get(messageId);
    let subscriber: Subscriber | null = null;

    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        if (!gen) {
          controller.enqueue(sseDone());
          controller.close();
          return;
        }
        for (const bc of gen.chunks) {
          if (bc.id > lastEventId) controller.enqueue(sseChunk(bc));
        }
        if (gen.status !== "running") {
          controller.enqueue(sseDone());
          controller.close();
          return;
        }
        subscriber = {
          push: (bc) => {
            try {
              controller.enqueue(sseChunk(bc));
            } catch {
              /* stream already closed */
            }
          },
          end: () => {
            try {
              controller.enqueue(sseDone());
              controller.close();
            } catch {
              /* already closed */
            }
          },
        };
        gen.subscribers.add(subscriber);
      },
      cancel: () => {
        if (gen && subscriber) gen.subscribers.delete(subscriber);
      },
    });
  }

  private async run(gen: Generation, context: Context): Promise<void> {
    const emit = (chunk: UiChunk) => {
      const bc: BufferedChunk = { id: gen.nextId++, chunk };
      gen.chunks.push(bc);
      for (const s of gen.subscribers) s.push(bc);
    };

    emit({ type: "start", messageId: gen.messageId });

    try {
      const events = await streamChat(context, gen.selection, gen.params, gen.controller.signal);
      for await (const event of events) {
        if (event.type === "text_delta") gen.text += event.delta;
        if (event.type === "done") {
          // Store the whole pi assistant message so context can be
          // reconstructed losslessly on later turns.
          gen.parts = event.message;
          gen.usage = {
            inputTokens: event.message.usage.input,
            outputTokens: event.message.usage.output,
          };
        }
        for (const chunk of piEventToUiChunks(event)) emit(chunk);
      }
      gen.status = "done";
      await this.persist(gen, "complete");
      logger.withMetadata({ conversationId: gen.conversationId, messageId: gen.messageId, model: gen.model }).trace(gen.text);
      logger.withMetadata({ conversationId: gen.conversationId, messageId: gen.messageId, model: gen.model }).info("generation completed");
    } catch (err) {
      if (gen.controller.signal.aborted) {
        // Explicit user Stop: keep the partial text, mark complete.
        gen.status = "done";
        emit({ type: "finish", finishReason: "stop", usage: gen.usage ?? { inputTokens: 0, outputTokens: 0 } });
        await this.persist(gen, "complete");
        logger.withMetadata({ conversationId: gen.conversationId, messageId: gen.messageId, model: gen.model }).trace(gen.text);
        logger.withMetadata({ conversationId: gen.conversationId, messageId: gen.messageId, model: gen.model }).info("generation stopped");
      } else {
        gen.status = "error";
        emit({ type: "error", errorText: err instanceof Error ? err.message : String(err) });
        await this.persist(gen, "error");
        logger.withError(err).withMetadata({ conversationId: gen.conversationId, messageId: gen.messageId, model: gen.model }).error("generation failed");
      }
    } finally {
      for (const s of gen.subscribers) s.end();
      gen.subscribers.clear();
      setTimeout(() => this.generations.delete(gen.messageId), RETENTION_MS);
    }
  }

  private async persist(gen: Generation, status: MessageStatus): Promise<void> {
    await db
      .updateTable("message")
      .set({
        text: gen.text,
        parts: gen.parts ? JSON.stringify(gen.parts) : null,
        status,
        model: gen.model,
        inputTokens: gen.usage?.inputTokens ?? null,
        outputTokens: gen.usage?.outputTokens ?? null,
      })
      .where("id", "=", gen.messageId)
      .execute();

    await db
      .updateTable("conversation")
      .set({ updatedAt: new Date().toISOString() })
      .where("id", "=", gen.conversationId)
      .execute();
  }
}

export const generationManager = new GenerationManager();
