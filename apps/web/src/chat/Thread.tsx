import {
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";

/** Minimal assistant-ui thread surface (M1). Styling stays intentionally lean. */
export function Thread() {
  return (
    <ThreadPrimitive.Root style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ThreadPrimitive.Viewport style={{ flex: 1, overflowY: "auto", padding: "1rem", display: "flex", flexDirection: "column", gap: 12 }}>
        <ThreadPrimitive.Messages
          components={{
            UserMessage: () => (
              <div style={{ alignSelf: "flex-end", background: "#e6f0ff", padding: "8px 12px", borderRadius: 12, maxWidth: "80%" }}>
                <MessagePrimitive.Content />
              </div>
            ),
            AssistantMessage: () => (
              <div style={{ alignSelf: "flex-start", background: "#f2f2f2", padding: "8px 12px", borderRadius: 12, maxWidth: "80%", whiteSpace: "pre-wrap" }}>
                <MessagePrimitive.Content />
              </div>
            ),
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
