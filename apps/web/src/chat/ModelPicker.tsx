import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Star } from "lucide-react";
import { useTRPC } from "../trpc";

interface Selection {
  provider: string;
  endpointId: string;
  modelId: string;
  api: string;
}

function key(s: Selection) {
  return `${s.provider}/${s.endpointId}/${s.modelId}/${s.api}`;
}

/**
 * Per-conversation model selector. Switching persists the choice on the
 * conversation immediately (switchable at any time). "Make default" stores the
 * choice as the user's personal default for new conversations.
 */
export function ModelPicker({ conversationId }: { conversationId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const available = useQuery(trpc.model.available.queryOptions());
  const current = useQuery(
    trpc.model.forConversation.queryOptions({ conversationId }),
  );

  const setModel = useMutation(
    trpc.conversation.setModel.mutationOptions({
      onSuccess: () => {
        qc.invalidateQueries({
          queryKey: trpc.model.forConversation.queryKey({ conversationId }),
        });
        qc.invalidateQueries({ queryKey: trpc.conversation.list.queryKey() });
      },
    }),
  );
  const setDefault = useMutation(trpc.model.setUserDefault.mutationOptions());

  const models = available.data ?? [];
  const cur = current.data;

  if (models.length === 0) {
    return (
      <div style={{ padding: "0.5rem 1rem", color: "#999", fontSize: 13 }}>
        No models configured.
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0.4rem 1rem",
        borderBottom: "1px solid #eee",
        fontSize: 13,
      }}
    >
      <select
        value={cur ? key(cur) : ""}
        onChange={(e) => {
          const m = models.find((x) => key(x) === e.target.value);
          if (m) setModel.mutate({ id: conversationId, provider: m.provider, endpointId: m.endpointId, modelId: m.modelId, api: m.api });
        }}
      >
        {cur && !models.some((m) => key(m) === key(cur)) && (
          <option value={key(cur)}>
            {cur.modelId} (unavailable)
          </option>
        )}
        {models.map((m) => (
          <option key={key(m)} value={key(m)}>
            {m.name}
          </option>
        ))}
      </select>
      {cur && (
        <div
          className="tooltip tooltip-bottom"
          data-tip="Use this model as your default for new conversations"
        >
          <button
            type="button"
            className="btn btn-ghost btn-xs btn-circle"
            onClick={() =>
              setDefault.mutate({ provider: cur.provider, endpointId: cur.endpointId, modelId: cur.modelId, api: cur.api })
            }
            disabled={setDefault.isPending}
          >
            {setDefault.isSuccess ? <Check size={15} /> : <Star size={15} />}
          </button>
        </div>
      )}
    </div>
  );
}
