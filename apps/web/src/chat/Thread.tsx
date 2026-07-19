import {
  ActionBarPrimitive,
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Copy, Cog, LoaderCircle, Paperclip, Podcast, Repeat2, Send, Server, Square, SquarePen, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTRPC } from "../trpc";
import { MarkdownText } from "./MarkdownText";
import type { SolarToolCall } from "./useSolarRuntime";
import "./Thread.css";

const EMPTY_TOOL_CALLS: SolarToolCall[] = [];

export type ContextStatus = {
  state: string;
  estimatedTokens: number | null;
  summarized: boolean;
  jobError: string | null;
};

export function ContextStatusIndicator({ status }: { status?: ContextStatus }) {
  if (!status || (status.state === "idle" && !status.summarized)) return null;
  if (status.state === "running") {
    return <span className="flex items-center gap-1 text-xs text-info"><span className="loading loading-spinner loading-xs" />Summarizing history...</span>;
  }
  if (status.state === "failed") {
    return <span className="badge badge-error badge-xs">Summary failed{status.jobError ? `: ${status.jobError}` : ""}</span>;
  }
  return <span className="badge badge-info badge-xs">History summarized</span>;
}

function ContextStatusControl({ conversationId }: { conversationId: string }) {
  const trpc = useTRPC();
  const context = useQuery({
    ...trpc.conversation.contextState.queryOptions({ conversationId }),
    refetchInterval: (query) => query.state.data?.state === "running" ? 2_000 : false,
  });
  return <ContextStatusIndicator status={context.data} />;
}

/** Small image-or-icon chip for a single attachment (composer or message). */
function AttachmentChip({ removable }: { removable?: boolean }) {
  const attachment = useAuiState((s) => s.attachment);
  if (!attachment) return null;
  const imagePart =
    attachment.type === "image"
      ? (attachment.content?.[0] as { type: "image"; image: string } | undefined)
      : undefined;

  return (
    <AttachmentPrimitive.Root className="solar-attachment-chip">
      {imagePart ? (
        <img
          src={imagePart.image}
          alt={attachment.name}
          className="solar-attachment-thumb"
        />
      ) : (
        <span className="solar-attachment-icon">📄</span>
      )}
      <span className="solar-attachment-name">
        <AttachmentPrimitive.Name />
      </span>
      {removable && (
        <AttachmentPrimitive.Remove
          className="solar-attachment-remove"
          aria-label="Remove attachment"
        >
          <X size={12} />
        </AttachmentPrimitive.Remove>
      )}
    </AttachmentPrimitive.Root>
  );
}

/** Live-tailing, collapsible "Thinking" box for reasoning message parts. */
function Reasoning() {
  const text = useAuiState((s) =>
    s.part.type === "reasoning" ? s.part.text : "",
  );
  const isRunning = useAuiState((s) => s.part.status.type === "running");
  const [open, setOpen] = useState(isRunning);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [text, open]);

  if (!text) return null;

  return (
    <div className="solar-reasoning">
      <button
        type="button"
        className="solar-reasoning-toggle"
        onClick={() => setOpen((o) => !o)}
      >
        {isRunning ? "Thinking…" : "Thinking"} {open ? "▾" : "▸"}
      </button>
      {open && (
        <div className="solar-reasoning-body" ref={bodyRef}>
          {text}
        </div>
      )}
    </div>
  );
}

function ToolCalls() {
  const toolCalls = useAuiState(
    (s) => (s.message.metadata?.custom as { toolCalls?: SolarToolCall[] } | undefined)?.toolCalls ?? EMPTY_TOOL_CALLS,
  );

  if (!toolCalls.length) return null;

  return (
    <div className="solar-tool-calls">
      {toolCalls.map((call) => (
        <details key={call.id} className="solar-tool-call" open={call.status === "streaming" || call.status === "executing"}>
          <summary>
            <span className={`solar-tool-status solar-tool-status-${call.status}`} />
            <span className="solar-tool-name">{call.serverName && call.remoteName ? `${call.serverName} (${call.remoteName})` : call.name}</span>
            <span className="solar-tool-state">{call.status === "streaming" ? "Preparing" : call.status === "executing" ? "Running" : call.status === "error" ? "Failed" : "Complete"}</span>
          </summary>
          <div className="solar-tool-call-details">
            <span>Input</span>
            <pre>{call.args || "{}"}</pre>
            {call.output !== undefined && <><span>{call.status === "error" ? "Error" : "Output"}</span><pre>{call.output}</pre></>}
          </div>
        </details>
      ))}
    </div>
  );
}

const iconButton: React.CSSProperties = {
  border: "none",
  background: "transparent",
  cursor: "pointer",
  fontSize: 12,
  color: "#666",
  padding: "2px 6px",
  borderRadius: 6,
};

const REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const VERBOSITY_LEVELS = ["low", "medium", "high"] as const;

function SignalMeter({ level, levels }: { level?: string | null; levels: readonly string[] }) {
  const levelIndex = level ? levels.indexOf(level) : -1;
  const strength = levelIndex < 0 ? 0 : ((levelIndex + 1) / levels.length) * 100;

  return (
    <span title={level ? `${level} strength` : "Provider default"} style={{ position: "relative", width: 4, height: 14, overflow: "hidden", borderRadius: 2, background: "#cbd5e1" }}>
      <span style={{ position: "absolute", right: 0, bottom: 0, left: 0, height: `${strength}%`, background: "currentColor" }} />
    </span>
  );
}

function UserMessage() {
  return (
    <div className="solar-message" style={{ alignSelf: "flex-end", maxWidth: "80%", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
      <MessagePrimitive.Attachments>
        {() => <AttachmentChip />}
      </MessagePrimitive.Attachments>
      <div className="solar-user-output" style={{ background: "#e6f0ff", padding: "8px 12px", borderRadius: 12 }}>
        <MessagePrimitive.Content />
      </div>
      <ActionBarPrimitive.Root className="solar-actions" style={{ display: "flex", gap: 4 }}>
        <ActionBarPrimitive.Edit className="solar-action-btn" aria-label="Edit message">
          <SquarePen size={16} />
        </ActionBarPrimitive.Edit>
        <ActionBarPrimitive.Copy className="solar-action-btn" aria-label="Copy message">
          <Copy size={16} />
        </ActionBarPrimitive.Copy>
      </ActionBarPrimitive.Root>
    </div>
  );
}

function UserEditComposer() {
  return (
    <ComposerPrimitive.Root style={{ alignSelf: "flex-end", maxWidth: "80%", width: "100%", display: "flex", flexDirection: "column", gap: 6, background: "#eef4ff", padding: 8, borderRadius: 12 }}>
      <ComposerPrimitive.Input
        style={{ width: "100%", resize: "none", border: "1px solid #cbd8f0", borderRadius: 8, padding: 8, fontFamily: "inherit", fontSize: 14 }}
      />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <ComposerPrimitive.Cancel style={iconButton}>Cancel</ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send style={{ ...iconButton, color: "#1a56db" }}>Save & submit</ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  );
}

function AssistantMessage() {
  const isEmpty = useAuiState((s) =>
    s.message.content.every((part) =>
      part.type === "text" ? !part.text : part.type === "reasoning" ? !part.text : true,
    ),
  );

  return (
    <div className="solar-message" style={{ alignSelf: "flex-start", maxWidth: "80%", display: "flex", flexDirection: "column", gap: 2 }}>
      <ToolCalls />
      <div className="solar-assistant-output" style={{ background: "#f2f2f2", padding: "8px 12px", borderRadius: 12 }}>
        {isEmpty ? (
          <LoaderCircle className="solar-response-loader" size={18} />
        ) : (
          <MessagePrimitive.Content
            components={{ Text: MarkdownText, Reasoning }}
          />
        )}
      </div>
      <ActionBarPrimitive.Root className="solar-actions" style={{ display: "flex", gap: 4 }}>
        <ActionBarPrimitive.Reload className="solar-action-btn" aria-label="Regenerate response">
          <Repeat2 size={16} />
        </ActionBarPrimitive.Reload>
        <ActionBarPrimitive.Copy className="solar-action-btn" aria-label="Copy response">
          <Copy size={16} />
        </ActionBarPrimitive.Copy>
      </ActionBarPrimitive.Root>
    </div>
  );
}

function GenerationControls({ conversationId }: { conversationId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const settings = useQuery(
    trpc.model.forConversation.queryOptions({ conversationId }),
  );
  const [open, setOpen] = useState<"reasoning" | "verbosity" | null>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const update = useMutation(
    trpc.conversation.setGenerationSettings.mutationOptions({
      onSuccess: () => {
        qc.invalidateQueries({
          queryKey: trpc.model.forConversation.queryKey({ conversationId }),
        });
        setOpen(null);
      },
    }),
  );
  const data = settings.data;
  const showReasoning = Boolean(data?.reasoningLevels.length);
  const showVerbosity = Boolean(data?.supportsVerbosity);
  const reasoningEffort = data?.effectiveReasoningEffort;
  const verbosity = data?.effectiveVerbosity;

  useEffect(() => {
    if (!open) return;

    const dismiss = (event: PointerEvent) => {
      if (!controlsRef.current?.contains(event.target as Node)) setOpen(null);
    };

    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  if (!showReasoning && !showVerbosity) return null;

  return (
    <div ref={controlsRef} style={{ display: "flex", gap: 4 }}>
      {showReasoning && (
        <div style={{ position: "relative" }}>
          <button
            type="button"
            onClick={() => setOpen(open === "reasoning" ? null : "reasoning")}
            style={{ ...iconButton, color: reasoningEffort ? "#1a56db" : "#666", display: "flex", alignItems: "center", gap: 3 }}
            title={`Reasoning effort: ${reasoningEffort ?? "default"}${data?.reasoningEffort ? "" : " (default)"}`}
          >
            <Brain size={18} />
            <SignalMeter level={reasoningEffort} levels={data?.reasoningLevels ?? REASONING_LEVELS} />
          </button>
          {open === "reasoning" && (
            <div style={{ position: "absolute", bottom: 30, left: 0, background: "white", border: "1px solid #ccc", borderRadius: 8, padding: 4, zIndex: 1 }}>
              <button type="button" onClick={() => update.mutate({ id: conversationId, reasoningEffort: null })} style={iconButton}>Default</button>
              {data?.reasoningLevels.map((level) => (
                <button key={level} type="button" onClick={() => update.mutate({ id: conversationId, reasoningEffort: level })} style={iconButton}>{level}</button>
              ))}
            </div>
          )}
        </div>
      )}
      {showVerbosity && (
        <div style={{ position: "relative" }}>
          <button
            type="button"
            onClick={() => setOpen(open === "verbosity" ? null : "verbosity")}
            style={{ ...iconButton, color: verbosity ? "#1a56db" : "#666", display: "flex", alignItems: "center", gap: 3 }}
            title={`Answer verbosity: ${verbosity ?? "default"}${data?.verbosity ? "" : " (default)"}`}
          >
            <Podcast size={18} />
            <SignalMeter level={verbosity} levels={VERBOSITY_LEVELS} />
          </button>
          {open === "verbosity" && (
            <div style={{ position: "absolute", bottom: 30, left: 0, background: "white", border: "1px solid #ccc", borderRadius: 8, padding: 4, zIndex: 1 }}>
              <button type="button" onClick={() => update.mutate({ id: conversationId, verbosity: null })} style={iconButton}>Default</button>
              {VERBOSITY_LEVELS.map((level) => (
                <button key={level} type="button" onClick={() => update.mutate({ id: conversationId, verbosity: level })} style={iconButton}>{level}</button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function McpControls({ conversationId, onConfigure }: { conversationId: string; onConfigure: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const controlsRef = useRef<HTMLDivElement>(null);
  const settings = useQuery(trpc.mcp.forConversation.queryOptions({ conversationId }));
  const invalidate = () => qc.invalidateQueries({ queryKey: trpc.mcp.forConversation.queryKey({ conversationId }) });
  const setServer = useMutation(trpc.mcp.setConversation.mutationOptions({ onSuccess: invalidate }));
  const setAuto = useMutation(trpc.mcp.setAutoExecute.mutationOptions({ onSuccess: invalidate }));

  useEffect(() => {
    if (!open) return;

    const dismiss = (event: PointerEvent) => {
      if (!controlsRef.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  if (!settings.data) return null;
  return <div ref={controlsRef} className="relative"><button type="button" className="btn btn-ghost btn-sm btn-square" title="MCP tools" onClick={() => setOpen((value) => !value)}><Server size={18} /></button>{open && <div className="absolute bottom-11 left-0 z-10 w-64 rounded-box bg-base-100 p-3 shadow-lg ring-1 ring-base-300"><div className="mb-3 flex items-center justify-between gap-3"><span className="text-sm font-medium">MCP tools</span><button type="button" className="btn btn-ghost btn-xs btn-square" title="Configure MCP servers" onClick={() => { setOpen(false); onConfigure(); }}><Cog size={16} /></button></div>{settings.data.servers.length ? <><label className="mb-3 flex items-center justify-between gap-3 text-sm font-medium">Run MCP tools automatically<input className="toggle toggle-primary toggle-sm checked:border-primary checked:bg-primary checked:text-primary-content" type="checkbox" checked={settings.data.autoExecuteTools} disabled={setAuto.isPending} onChange={(event) => setAuto.mutate({ conversationId, enabled: event.target.checked })} /></label><div className="divide-y divide-base-300">{settings.data.servers.map((server) => <label key={server.id} className="flex items-center justify-between gap-3 py-2 text-sm"><span className="truncate">{server.name}</span><input className="toggle toggle-primary toggle-sm checked:border-primary checked:bg-primary checked:text-primary-content" type="checkbox" checked={server.enabled} disabled={setServer.isPending} onChange={(event) => setServer.mutate({ conversationId, serverId: server.id, enabled: event.target.checked })} /></label>)}</div></> : <p className="text-sm opacity-60">No MCP servers configured.</p>}</div>}</div>;
}

/** assistant-ui thread surface (M2): markdown/code/LaTeX, edit & regenerate. */
export function Thread({ conversationId, onConfigureMcp }: { conversationId: string; onConfigureMcp: () => void }) {
  return (
    <ThreadPrimitive.Root style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ThreadPrimitive.Viewport style={{ flex: 1, overflowY: "auto", padding: "1rem", display: "flex", flexDirection: "column", gap: 12 }}>
        <ThreadPrimitive.Messages
          components={{
            UserMessage,
            UserEditComposer,
            AssistantMessage,
          }}
        />
      </ThreadPrimitive.Viewport>

      <ComposerPrimitive.Root
        className="bg-base-200/70 rounded-t-2xl px-3 pt-3 pb-4 shadow-[0_-12px_30px_-24px_rgba(0,0,0,0.7)] sm:px-4"
        style={{ boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 6, minWidth: 0, width: "100%" }}
      >
        <ComposerPrimitive.Attachments>
          {() => <AttachmentChip removable />}
        </ComposerPrimitive.Attachments>
        <ComposerPrimitive.Queue>
          {({ queueItem }) => (
            <span className="badge badge-info badge-sm self-start">Queued: {queueItem.prompt}</span>
          )}
        </ComposerPrimitive.Queue>
        <ContextStatusControl conversationId={conversationId} />
        <div className="flex items-center gap-1 rounded-2xl bg-base-100/70 p-1.5 shadow-sm ring-1 ring-base-300/50">
          <ComposerPrimitive.AddAttachment
            className="btn btn-ghost btn-sm btn-square"
            aria-label="Add attachment"
          >
            <Paperclip size={18} />
          </ComposerPrimitive.AddAttachment>
           <GenerationControls conversationId={conversationId} />
            <McpControls conversationId={conversationId} onConfigure={onConfigureMcp} />
          <ComposerPrimitive.Input
            placeholder="Message…"
            className="textarea textarea-ghost min-h-10 flex-1 px-2 py-2"
          />
          <ComposerPrimitive.Send className="btn btn-ghost btn-sm btn-square rounded-xl" title="Send or queue message">
            <Send size={18} />
          </ComposerPrimitive.Send>
          <ThreadPrimitive.If running>
            <ComposerPrimitive.Cancel className="btn btn-ghost btn-sm btn-square rounded-xl" title="Interrupt response">
              <Square size={16} />
            </ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>
        </div>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}
