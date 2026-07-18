import {
  ActionBarPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { MarkdownText } from "./MarkdownText";

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
    <div style={{ alignSelf: "flex-end", maxWidth: "80%", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
      <div style={{ background: "#e6f0ff", padding: "8px 12px", borderRadius: 12 }}>
        <MessagePrimitive.Content />
      </div>
      <ActionBarPrimitive.Root style={{ display: "flex", gap: 4 }}>
        <ActionBarPrimitive.Edit style={iconButton}>Edit</ActionBarPrimitive.Edit>
        <ActionBarPrimitive.Copy style={iconButton}>Copy</ActionBarPrimitive.Copy>
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
  return (
    <div style={{ alignSelf: "flex-start", maxWidth: "80%", display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ background: "#f2f2f2", padding: "8px 12px", borderRadius: 12 }}>
        <MessagePrimitive.Content components={{ Text: MarkdownText }} />
      </div>
      <ActionBarPrimitive.Root style={{ display: "flex", gap: 4 }}>
        <ActionBarPrimitive.Copy style={iconButton}>Copy</ActionBarPrimitive.Copy>
        <ActionBarPrimitive.Reload style={iconButton}>Regenerate</ActionBarPrimitive.Reload>
      </ActionBarPrimitive.Root>
    </div>
  );
}

/** assistant-ui thread surface (M2): markdown/code/LaTeX, edit & regenerate. */
export function Thread() {
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

      <ComposerPrimitive.Root style={{ display: "flex", gap: 8, padding: "0.75rem 1rem", borderTop: "1px solid #ddd" }}>
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
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}
