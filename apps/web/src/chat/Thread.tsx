import {
  ActionBarPrimitive,
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Copy, LoaderCircle, Paperclip, Podcast, Repeat2, SquarePen, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTRPC } from "../trpc";
import { MarkdownText } from "./MarkdownText";
import "./Thread.css";

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

const iconButton: React.CSSProperties = {
  border: "none",
  background: "transparent",
  cursor: "pointer",
  fontSize: 12,
  color: "#666",
  padding: "2px 6px",
  borderRadius: 6,
};

function UserMessage() {
  return (
    <div className="solar-message" style={{ alignSelf: "flex-end", maxWidth: "80%", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
      <MessagePrimitive.Attachments>
        {() => <AttachmentChip />}
      </MessagePrimitive.Attachments>
      <div style={{ background: "#e6f0ff", padding: "8px 12px", borderRadius: 12 }}>
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
      <div style={{ background: "#f2f2f2", padding: "8px 12px", borderRadius: 12 }}>
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

  if (!showReasoning && !showVerbosity) return null;

  return (
    <div style={{ display: "flex", gap: 4, position: "relative", alignSelf: "flex-end" }}>
      {showReasoning && (
        <>
          <button
            type="button"
            onClick={() => setOpen(open === "reasoning" ? null : "reasoning")}
            style={{ ...iconButton, color: data?.reasoningEffort ? "#1a56db" : "#666" }}
            title="Reasoning effort"
          >
            <Brain size={18} />
          </button>
          {open === "reasoning" && (
            <div style={{ position: "absolute", bottom: 30, left: 0, background: "white", border: "1px solid #ccc", borderRadius: 8, padding: 4, zIndex: 1 }}>
              <button type="button" onClick={() => update.mutate({ id: conversationId, reasoningEffort: null })} style={iconButton}>Default</button>
              {data?.reasoningLevels.map((level) => (
                <button key={level} type="button" onClick={() => update.mutate({ id: conversationId, reasoningEffort: level })} style={iconButton}>{level}</button>
              ))}
            </div>
          )}
        </>
      )}
      {showVerbosity && (
        <>
          <button
            type="button"
            onClick={() => setOpen(open === "verbosity" ? null : "verbosity")}
            style={{ ...iconButton, color: data?.verbosity ? "#1a56db" : "#666" }}
            title="Answer verbosity"
          >
            <Podcast size={18} />
          </button>
          {open === "verbosity" && (
            <div style={{ position: "absolute", bottom: 30, left: showReasoning ? 32 : 0, background: "white", border: "1px solid #ccc", borderRadius: 8, padding: 4, zIndex: 1 }}>
              <button type="button" onClick={() => update.mutate({ id: conversationId, verbosity: null })} style={iconButton}>Default</button>
              {(["low", "medium", "high"] as const).map((level) => (
                <button key={level} type="button" onClick={() => update.mutate({ id: conversationId, verbosity: level })} style={iconButton}>{level}</button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** assistant-ui thread surface (M2): markdown/code/LaTeX, edit & regenerate. */
export function Thread({ conversationId }: { conversationId: string }) {
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

      <ComposerPrimitive.Root style={{ display: "flex", flexDirection: "column", gap: 6, padding: "0.75rem 1rem", borderTop: "1px solid #ddd" }}>
        <ComposerPrimitive.Attachments>
          {() => <AttachmentChip removable />}
        </ComposerPrimitive.Attachments>
        <div style={{ display: "flex", gap: 8 }}>
          <ComposerPrimitive.AddAttachment
            style={{ ...iconButton, alignSelf: "flex-end" }}
            aria-label="Add attachment"
          >
            <Paperclip size={18} />
          </ComposerPrimitive.AddAttachment>
          <GenerationControls conversationId={conversationId} />
          <ComposerPrimitive.Input
            placeholder="Message…"
            style={{ flex: 1, padding: 8, borderRadius: 8, border: "1px solid #ccc" }}
          />
          <ThreadPrimitive.If running={false}>
            <ComposerPrimitive.Send style={{ padding: "8px 16px" }}>Send</ComposerPrimitive.Send>
          </ThreadPrimitive.If>
          <ThreadPrimitive.If running>
            <ComposerPrimitive.Cancel style={{ padding: "8px 16px" }}>Stop</ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>
        </div>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}
