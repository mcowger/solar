import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { signOut, useSession } from "../auth";
import { useTRPC } from "../trpc";
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
  const conversations = useQuery(trpc.conversation.list.queryOptions());
  const create = useMutation(
    trpc.conversation.create.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: trpc.conversation.list.queryKey() }),
    }),
  );

  const list = conversations.data ?? [];
  const activeId = list[0]?.id;

  // Ensure at least one conversation exists.
  useEffect(() => {
    if (conversations.isSuccess && list.length === 0 && !create.isPending) {
      create.mutate({});
    }
  }, [conversations.isSuccess, list.length, create.isPending]);

  return (
    <div style={{ fontFamily: "system-ui", display: "flex", flexDirection: "column", height: "100vh" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "0.5rem 1rem", borderBottom: "1px solid #ddd" }}>
        <strong>Solar</strong>
        <button onClick={() => create.mutate({})}>New conversation</button>
        <span style={{ flex: 1 }} />
        <span style={{ color: "#666" }}>{session?.user.email}</span>
        <button onClick={() => signOut()}>Sign out</button>
      </header>
      {activeId ? (
        <ConversationView key={activeId} conversationId={activeId} />
      ) : (
        <p style={{ padding: "1rem" }}>Loading…</p>
      )}
    </div>
  );
}
