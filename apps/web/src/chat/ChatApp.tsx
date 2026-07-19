import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Hash, LogOut, Menu, Settings2, SlidersHorizontal } from "lucide-react";
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

const SIDEBAR_DEFAULT_WIDTH = 280;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 480;
const PINNED_SIDEBAR_MEDIA_QUERY = "(min-width: 650px)";

function ConversationView({ conversationId, onConfigureMcp }: { conversationId: string; onConfigureMcp: () => void }) {
  const trpc = useTRPC();
  const current = useQuery(
    trpc.model.forConversation.queryOptions({ conversationId }),
  );
  const runtime = useSolarRuntime(
    conversationId,
    current.data?.vision ?? false,
    current.data?.documentMimeTypes ?? [],
  );
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ModelPicker conversationId={conversationId} />
        <div className="min-h-0 flex-1">
          <Thread conversationId={conversationId} onConfigureMcp={onConfigureMcp} />
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
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [copiedChatId, setCopiedChatId] = useState<string>();
  // Guards against React StrictMode double-invoking the auto-create effect.
  const autoCreated = useRef(false);

  const conversations = useQuery(trpc.conversation.list.queryOptions());
  const presets = useQuery(trpc.preset.list.queryOptions());
  const create = useMutation(
    trpc.conversation.create.mutationOptions({
      onSuccess: async ({ id }) => {
        // Wait for the list to contain the new conversation before selecting it.
        await qc.invalidateQueries({ queryKey: trpc.conversation.list.queryKey() });
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

  function startSidebarResize(event: React.PointerEvent<HTMLDivElement>) {
    if (!window.matchMedia(PINNED_SIDEBAR_MEDIA_QUERY).matches) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    const resize = (moveEvent: PointerEvent) => {
      setSidebarWidth(
        Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, moveEvent.clientX)),
      );
    };
    const stopResize = () => {
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };

    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }

  async function copyChatId() {
    if (!activeId) return;
    await navigator.clipboard.writeText(activeId);
    setCopiedChatId(activeId);
  }

  return (
    <div className="drawer min-[650px]:drawer-open solar-app h-dvh" style={{ "--solar-sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}>
      <input id="solar-drawer" type="checkbox" className="drawer-toggle" checked={drawerOpen} onChange={(event) => setDrawerOpen(event.target.checked)} />
      <div className="drawer-content solar-main flex min-h-0 flex-col overflow-x-clip bg-base-100">
       <header className="navbar min-h-16 border-b border-base-300 bg-base-100 px-3 sm:px-5">
          <div className="navbar-start gap-2"><label htmlFor="solar-drawer" className="solar-menu-toggle btn btn-ghost btn-sm btn-circle"><Menu size={19} /></label><strong className="solar-wordmark text-3xl">Solar</strong></div>
          <div className="navbar-end gap-1 sm:gap-2">
            {activeId && <div className="tooltip tooltip-bottom hidden sm:block" data-tip="Copy chat ID"><button className="btn btn-ghost btn-xs h-7 min-h-0 gap-1 px-2 font-mono text-[11px] font-normal opacity-45 hover:opacity-100" onClick={() => void copyChatId()}><Hash size={13} />{copiedChatId === activeId ? "Copied" : activeId.slice(0, 8)}</button></div>}
            <div className="tooltip tooltip-bottom" data-tip="Presets"><button className="btn btn-ghost btn-sm btn-circle" onClick={() => { setShowPresets(true); setShowSettings(false); setShowMcpServers(false); }}><SlidersHorizontal size={18} /></button></div>
            {isAdmin && (
              <div className="tooltip tooltip-bottom" data-tip="Settings"><button className="btn btn-ghost btn-sm btn-circle" onClick={() => { setShowSettings(true); setShowPresets(false); setShowMcpServers(false); }}><Settings2 size={18} /></button></div>
          )}
          <ThemeToggle />
          <div className="tooltip tooltip-bottom" data-tip="Sign out"><button className="btn btn-ghost btn-sm btn-circle" onClick={() => signOut()}><LogOut size={18} /></button></div>
         </div>
       </header>
       <div className="flex min-h-0 flex-1">
          {activeId ? (
            <ConversationView key={activeId} conversationId={activeId} onConfigureMcp={() => { setShowMcpServers(true); setShowSettings(false); setShowPresets(false); }} />
          ) : (
            <p className="p-4">Loading…</p>
          )}
        </div>
        {showSettings && isAdmin && <Settings onClose={() => setShowSettings(false)} />}
        {showMcpServers && <McpServers onClose={() => setShowMcpServers(false)} />}
        {showPresets && <Presets onClose={() => setShowPresets(false)} />}
      </div>
       <div className="drawer-side solar-sidebar">
         <label htmlFor="solar-drawer" className="drawer-overlay" onClick={() => setDrawerOpen(false)} />
        <Sidebar
          activeId={activeId}
          onClose={() => setDrawerOpen(false)}
          onSelect={(id) => { setActiveId(id); setDrawerOpen(false); }}
          onNew={() => { newChat(); setDrawerOpen(false); }}
          presets={presetList.map((p) => ({ id: p.id, name: p.name }))}
           onNewWithPreset={(presetId) => { newChat(presetId); setDrawerOpen(false); }}
         />
         <div className="solar-sidebar-resizer" onPointerDown={startSidebarResize} />
       </div>
    </div>
  );
}
