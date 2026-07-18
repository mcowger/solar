import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderPlus, Menu, SquarePen } from "lucide-react";
import { useState } from "react";
import { useTRPC } from "../trpc";
import { trpcClient } from "../trpcClient";

const rowButton: React.CSSProperties = {
  border: "none",
  background: "transparent",
  cursor: "pointer",
  fontSize: 12,
  color: "#888",
  padding: "0 4px",
};

interface SidebarProps {
  activeId: string | undefined;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
  presets: { id: string; name: string }[];
  onNewWithPreset: (presetId: string) => void;
}

export function Sidebar({
  activeId,
  onSelect,
  onNew,
  onClose,
  presets,
  onNewWithPreset,
}: SidebarProps) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  const conversations = useQuery(trpc.conversation.list.queryOptions());
  const folders = useQuery(trpc.folder.list.queryOptions());
  const tags = useQuery(trpc.tag.list.queryOptions());
  const searchResults = useQuery(
    trpc.conversation.search.queryOptions(
      { query: search.trim() },
      { enabled: search.trim().length > 0 },
    ),
  );

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: trpc.conversation.list.queryKey() });
    qc.invalidateQueries({ queryKey: trpc.folder.list.queryKey() });
    qc.invalidateQueries({ queryKey: trpc.tag.list.queryKey() });
  };

  const rename = useMutation(trpc.conversation.rename.mutationOptions({ onSuccess: invalidateAll }));
  const remove = useMutation(trpc.conversation.remove.mutationOptions({ onSuccess: invalidateAll }));
  const move = useMutation(trpc.conversation.move.mutationOptions({ onSuccess: invalidateAll }));
  const createFolder = useMutation(trpc.folder.create.mutationOptions({ onSuccess: invalidateAll }));
  const renameFolder = useMutation(trpc.folder.rename.mutationOptions({ onSuccess: invalidateAll }));
  const removeFolder = useMutation(trpc.folder.remove.mutationOptions({ onSuccess: invalidateAll }));

  const list = conversations.data ?? [];
  const folderList = folders.data ?? [];
  const tagList = tags.data ?? [];

  const filtered = tagFilter
    ? list.filter((c) => c.tags.some((t) => t.id === tagFilter))
    : list;

  const byFolder = (folderId: string | null) =>
    filtered.filter((c) => c.folderId === folderId);

  async function editTags(conversationId: string, current: { id: string; name: string }[]) {
    const input = window.prompt(
      "Tags (comma-separated):",
      current.map((t) => t.name).join(", "),
    );
    if (input === null) return;
    const names = [...new Set(input.split(",").map((s) => s.trim()).filter(Boolean))];
    const ids = await Promise.all(
      names.map(async (name) => (await trpcClient.tag.create.mutate({ name })).id),
    );
    await trpcClient.conversation.setTags.mutate({ id: conversationId, tagIds: ids });
    invalidateAll();
  }

  function renameConversation(id: string, currentTitle: string) {
    const title = window.prompt("Rename conversation:", currentTitle);
    if (title?.trim()) rename.mutate({ id, title: title.trim() });
  }

  function deleteConversation(id: string) {
    if (window.confirm("Delete this conversation?")) remove.mutate({ id });
  }

  const ConversationRow = (c: (typeof list)[number]) => (
    <div
      key={c.id}
      className={`solar-conversation-row${c.id === activeId ? " bg-secondary/15" : ""}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: "6px 8px",
        borderRadius: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <button
          onClick={() => onSelect(c.id)}
          title={c.title}
          style={{
            flex: 1,
            textAlign: "left",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            fontSize: 14,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {c.title}
        </button>
        <button style={rowButton} title="Rename" onClick={() => renameConversation(c.id, c.title)}>✎</button>
        <button style={rowButton} title="Tags" onClick={() => editTags(c.id, c.tags)}>#</button>
        <select
          className="select select-xs w-15"
          value={c.folderId ?? ""}
          onChange={(e) => move.mutate({ id: c.id, folderId: e.target.value || null })}
          title="Move to folder"
          style={{ cursor: "pointer" }}
        >
          <option value="">—</option>
          {folderList.map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </select>
        <button style={rowButton} title="Delete" onClick={() => deleteConversation(c.id)}>🗑</button>
      </div>
      {c.tags.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {c.tags.map((t) => (
            <span key={t.id} style={{ fontSize: 10, background: "#dde7fb", color: "#1a56db", padding: "1px 6px", borderRadius: 8 }}>
              {t.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <aside style={{ width: 280, borderRight: "1px solid #ddd", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ padding: 8, display: "flex", gap: 6 }}>
        <button type="button" className="btn btn-ghost btn-sm btn-circle lg:hidden" onClick={onClose} title="Close menu"><Menu size={19} /></button>
        <div className="tooltip tooltip-bottom" data-tip="New chat">
          <button type="button" className="btn btn-ghost btn-sm btn-circle" onClick={onNew}>
            <SquarePen size={18} />
          </button>
        </div>
        <div className="tooltip tooltip-bottom" data-tip="New folder">
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-circle"
            onClick={() => {
              const name = window.prompt("Folder name:");
              if (name?.trim()) createFolder.mutate({ name: name.trim() });
            }}
          >
            <FolderPlus size={18} />
          </button>
        </div>
      </div>
      {presets.length > 0 && (
        <div style={{ padding: "0 8px 8px" }}>
          <select
            className="select select-sm w-full"
            value=""
            onChange={(e) => {
              if (e.target.value) onNewWithPreset(e.target.value);
              e.target.value = "";
            }}
            title="Start a new chat from a preset"
          >
            <option value="">+ New chat from preset…</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div style={{ padding: "0 8px 8px" }}>
        <input
          className="input input-sm w-full"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
        />
      </div>

      {tagList.length > 0 && (
        <div style={{ padding: "0 8px 8px", display: "flex", flexWrap: "wrap", gap: 4 }}>
          {tagList.map((t) => (
            <button
              key={t.id}
              onClick={() => setTagFilter(tagFilter === t.id ? null : t.id)}
              style={{
                fontSize: 10,
                padding: "2px 8px",
                borderRadius: 10,
                border: "1px solid #cbd8f0",
                cursor: "pointer",
                background: tagFilter === t.id ? "#1a56db" : "#fff",
                color: tagFilter === t.id ? "#fff" : "#1a56db",
              }}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 8px" }}>
        {search.trim() ? (
          <div>
            <div style={{ fontSize: 11, color: "#999", padding: "4px 8px" }}>Results</div>
            {(searchResults.data ?? []).map((r) => (
              <button
                key={r.id}
                onClick={() => onSelect(r.id)}
                className={r.id === activeId ? "bg-secondary/15" : undefined}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 14,
                  padding: "6px 8px",
                  borderRadius: 8,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {r.title}
              </button>
            ))}
            {searchResults.data?.length === 0 && (
              <div style={{ fontSize: 12, color: "#999", padding: 8 }}>No matches.</div>
            )}
          </div>
        ) : (
          <>
            {folderList.map((f) => (
              <div key={f.id} style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 8px" }}>
                  <span style={{ flex: 1, fontSize: 11, fontWeight: 600, color: "#666", textTransform: "uppercase" }}>{f.name}</span>
                  <button
                    style={rowButton}
                    title="Rename folder"
                    onClick={() => {
                      const name = window.prompt("Rename folder:", f.name);
                      if (name?.trim()) renameFolder.mutate({ id: f.id, name: name.trim() });
                    }}
                  >
                    ✎
                  </button>
                  <button
                    style={rowButton}
                    title="Delete folder"
                    onClick={() => {
                      if (window.confirm(`Delete folder "${f.name}"? Conversations are kept.`))
                        removeFolder.mutate({ id: f.id });
                    }}
                  >
                    🗑
                  </button>
                </div>
                {byFolder(f.id).map(ConversationRow)}
              </div>
            ))}

            <div style={{ marginBottom: 8 }}>
              {folderList.length > 0 && (
                <div style={{ fontSize: 11, fontWeight: 600, color: "#666", textTransform: "uppercase", padding: "4px 8px" }}>
                  Unfiled
                </div>
              )}
              {byFolder(null).map(ConversationRow)}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
