import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { signOut, useSession } from "../auth";
import { useTRPC } from "../trpc";
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
  const [activeId, setActiveId] = useState<string | undefined>();
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
        <button onClick={() => signOut()}>Sign out</button>
      </header>
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
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
      </div>
    </div>
  );
}
