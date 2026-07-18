import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { signOut, useSession } from "../auth";
import { useTRPC } from "../trpc";
import { Settings } from "../admin/Settings";
import { ModelPicker } from "./ModelPicker";
import { Presets } from "./Presets";
import { Sidebar } from "./Sidebar";
import { Thread } from "./Thread";
import { useSolarRuntime } from "./useSolarRuntime";

function ConversationView({ conversationId }: { conversationId: string }) {
  const trpc = useTRPC();
  const current = useQuery(
    trpc.model.forConversation.queryOptions({ conversationId }),
  );
  const runtime = useSolarRuntime(conversationId, current.data?.vision ?? false);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <ModelPicker conversationId={conversationId} />
        <div style={{ flex: 1, minHeight: 0 }}>
          <Thread conversationId={conversationId} />
        </div>
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
  const [showPresets, setShowPresets] = useState(false);
  // Guards against React StrictMode double-invoking the auto-create effect.
  const autoCreated = useRef(false);

  const conversations = useQuery(trpc.conversation.list.queryOptions());
  const presets = useQuery(trpc.preset.list.queryOptions());
  const create = useMutation(
    trpc.conversation.create.mutationOptions({
      onSuccess: ({ id }) => {
        qc.invalidateQueries({ queryKey: trpc.conversation.list.queryKey() });
        setActiveId(id);
      },
    }),
  );

  const list = conversations.data ?? [];
  const presetList = presets.data ?? [];

  // Start a new conversation, optionally snapshotting a chosen preset.
  const newChat = (presetId?: string) =>
    create.mutate(presetId ? { presetId } : {});

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
        <button onClick={() => { setShowPresets((s) => !s); setShowSettings(false); }}>
          {showPresets ? "Back to chat" : "Presets"}
        </button>
        {isAdmin && (
          <button onClick={() => { setShowSettings((s) => !s); setShowPresets(false); }}>
            {showSettings ? "Back to chat" : "Settings"}
          </button>
        )}
        <button onClick={() => signOut()}>Sign out</button>
      </header>
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {showSettings && isAdmin ? (
          <Settings onClose={() => setShowSettings(false)} />
        ) : showPresets ? (
          <Presets onClose={() => setShowPresets(false)} />
        ) : (
          <>
            <Sidebar
              activeId={activeId}
              onSelect={setActiveId}
              onNew={() => newChat()}
              presets={presetList.map((p) => ({ id: p.id, name: p.name }))}
              onNewWithPreset={newChat}
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
