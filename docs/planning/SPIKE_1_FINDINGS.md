# Spike 1 Findings — pi-ai ⇄ assistant-ui bridge

Status: **works with caveats** · 2026-07-17

## Result

The bridge requires no assistant-ui fork, Vercel AI SDK dependency, or runtime
reimplementation. `@assistant-ui/react-data-stream` accepts an SSE endpoint
that implements its documented UI Message Stream protocol. The Bun proof uses
`pi-ai` directly and maps its events at the HTTP boundary.

A live OpenAI request produced two incremental `text-delta` events (`bridge`,
then ` verified`) and a normal `finish` event. A second request for the same
conversation returned `bridge verified`, proving that pi-native assistant
history was retained. The browser-level Thread rendering and Stop-button
interaction were not exercised in this shell-only run.

## Criteria assessment

| Criterion | Result | Evidence |
| --- | --- | --- |
| Incremental thread tokens | Live stream validated; browser rendering unverified | OpenAI emitted separate `text-delta` chunks; `bun test` also decodes them through assistant-ui's `UIMessageStreamDecoder`. |
| Lossless message-part mapping | Validated for text, reasoning, and tool-call lifecycle | `adapter.ts` maps pi event types to the native UI Message Stream chunks. |
| UI stop cancels pi | Implemented; browser verification pending | assistant-ui aborts its fetch; Bun's `request.signal` is passed as pi-ai's `signal`. |
| Multi-turn exchange | Live validated | The second OpenAI response recalled `bridge verified` from the first request. |
| Adapter shape | Validated | See below. |

## Adapter shape

```ts
function piEventsToUiMessageStream(
  events: AsyncIterable<AssistantMessageEvent>,
  messageId: string,
): ReadableStream<Uint8Array>;
```

It emits `start`, `text-delta`, `reasoning-delta`, `tool-call-start`,
`tool-call-delta`, `tool-call-end`, `finish` or `error`, and `[DONE]` as SSE.
The frontend uses `useDataStreamRuntime({ protocol: "ui-message-stream" })`
and renders a `ThreadPrimitive.Root`.

## Commands run

```text
bun test            # 1 pass, 0 fail
bun run typecheck   # passed
POST /api/chat      # 200 SSE; incremental OpenAI text-delta events and finish
POST /api/chat      # same conversation; prior assistant reply recalled
```

## Next step

Run `bun --env-file=../../.env run dev` in `.spikes/spike-1`, then verify
visible incremental output and Stop in the browser. Remove or quarantine
`.spikes/spike-1` after recording the final outcome.
