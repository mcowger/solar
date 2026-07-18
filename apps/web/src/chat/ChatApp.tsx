import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { signOut, useSession } from "../auth";
import { useTRPC } from "../trpc";
import { Settings } from "../admin/Settings";
import { Sidebar } from "./Sidebar";
import { Thread } from "./Thread";
import { useSolarRuntime } from "./useSolarRuntime";

function ConversationView({ conversationId }: { conversationId: string }) {
  const runtime = useSolarRuntime(conversationId);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Thread />
      </div>
    </AssistantRuntimeProvider>
  );
}

export function ChatApp() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { data: session } = useSession();
  const isAdmin = (session?.user as { role?: string })?.role === "admin";
  const [activeId, setActiveId] = useState<string | undefined>();
  const [showSettings, setShowSettings] = useState(false);
  // Guards against React StrictMode double-invoking the auto-create effect.
  const autoCreated = useRef(false);

  const conversations = useQuery(trpc.conversation.list.queryOptions());
  const create = useMutation(
    trpc.conversation.create.mutationOptions({
      onSuccess: ({ id }) => {
        qc.invalidateQueries({ queryKey: trpc.conversation.list.queryKey() });
        setActiveId(id);
      },
    }),
  );

  const list = conversations.data ?? [];

  // Ensure a conversation exists and one is always selected.
  useEffect(() => {
    if (!conversations.isSuccess) return;
    if (list.length === 0) {
      if (!autoCreated.current && !create.isPending) {
        autoCreated.current = true;
        create.mutate({});
      }
      return;
    }
    if (!activeId || !list.some((c) => c.id === activeId)) {
      setActiveId(list[0]?.id);
    }
  }, [conversations.isSuccess, list, activeId, create.isPending]);

  return (
    <div style={{ fontFamily: "system-ui", display: "flex", flexDirection: "column", height: "100vh" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "0.5rem 1rem", borderBottom: "1px solid #ddd" }}>
        <strong>Solar</strong>
        <span style={{ flex: 1 }} />
        <span style={{ color: "#666" }}>{session?.user.email}</span>
        {isAdmin && (
          <button onClick={() => setShowSettings((s) => !s)}>
            {showSettings ? "Back to chat" : "Settings"}
          </button>
        )}
        <button onClick={() => signOut()}>Sign out</button>
      </header>
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {showSettings && isAdmin ? (
          <Settings onClose={() => setShowSettings(false)} />
        ) : (
          <>
            <Sidebar
              activeId={activeId}
              onSelect={setActiveId}
              onNew={() => create.mutate({})}
            />
            {activeId ? (
              <ConversationView key={activeId} conversationId={activeId} />
            ) : (
              <p style={{ padding: "1rem" }}>Loading…</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
