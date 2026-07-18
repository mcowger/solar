import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Menu } from "lucide-react";
import { signOut, useSession } from "../auth";
import { useTRPC } from "../trpc";
import { ThemeToggle } from "../ThemeToggle";
import { Settings } from "../admin/Settings";
import { ModelPicker } from "./ModelPicker";
import { Presets } from "./Presets";
import { Sidebar } from "./Sidebar";
import { Thread } from "./Thread";
import { McpServers } from "./McpServers";
import { useSolarRuntime } from "./useSolarRuntime";

function ConversationView({ conversationId }: { conversationId: string }) {
  const trpc = useTRPC();
  const current = useQuery(
    trpc.model.forConversation.queryOptions({ conversationId }),
  );
  const runtime = useSolarRuntime(conversationId, current.data?.vision ?? false);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ModelPicker conversationId={conversationId} />
        <div className="min-h-0 flex-1">
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
  const [showMcpServers, setShowMcpServers] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
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
    <div className="drawer lg:drawer-open solar-app h-dvh">
      <input id="solar-drawer" type="checkbox" className="drawer-toggle" checked={drawerOpen} onChange={(event) => setDrawerOpen(event.target.checked)} />
      <div className="drawer-content solar-main flex min-h-0 flex-col bg-base-100">
       <header className="navbar min-h-16 border-b border-base-300 bg-base-100 px-3 sm:px-5">
         <div className="navbar-start gap-2"><label htmlFor="solar-drawer" className="btn btn-ghost btn-sm btn-circle lg:hidden"><Menu size={19} /></label><strong className="solar-wordmark text-3xl">Solar</strong></div>
         <div className="navbar-end gap-1 sm:gap-2">
         <span className="hidden max-w-48 truncate text-sm opacity-60 sm:inline">{session?.user.email}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => { setShowPresets((s) => !s); setShowSettings(false); setShowMcpServers(false); }}>
           {showPresets ? "Back to chat" : "Presets"}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => { setShowMcpServers((s) => !s); setShowSettings(false); setShowPresets(false); }}>{showMcpServers ? "Back to chat" : "MCP servers"}</button>
         {isAdmin && (
            <button className="btn btn-ghost btn-sm" onClick={() => { setShowSettings((s) => !s); setShowPresets(false); setShowMcpServers(false); }}>
             {showSettings ? "Back to chat" : "Settings"}
           </button>
         )}
         <ThemeToggle />
         <button className="btn btn-ghost btn-sm" onClick={() => signOut()}>Sign out</button>
         </div>
       </header>
       <div className="flex min-h-0 flex-1">
          {showSettings && isAdmin ? (
            <Settings onClose={() => setShowSettings(false)} />
          ) : showMcpServers ? (
            <McpServers onClose={() => setShowMcpServers(false)} />
         ) : showPresets ? (
           <Presets onClose={() => setShowPresets(false)} />
         ) : (
           <>
            {activeId ? (
              <ConversationView key={activeId} conversationId={activeId} />
            ) : (
               <p className="p-4">Loading…</p>
            )}
          </>
        )}
       </div>
      </div>
      <div className="drawer-side solar-sidebar">
        <label htmlFor="solar-drawer" className="drawer-overlay" onClick={() => setDrawerOpen(false)} />
        <Sidebar
          activeId={activeId}
          onSelect={(id) => { setActiveId(id); setDrawerOpen(false); }}
          onNew={() => { newChat(); setDrawerOpen(false); }}
          presets={presetList.map((p) => ({ id: p.id, name: p.name }))}
          onNewWithPreset={(presetId) => { newChat(presetId); setDrawerOpen(false); }}
        />
      </div>
    </div>
  );
}
