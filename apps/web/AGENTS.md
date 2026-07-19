# Frontend guidance

## Styling & visual verification

- For UI styling or layout changes, capture and inspect a browser screenshot
  before declaring the work complete. Do not rely only on DOM assertions or
  type checks for visual verification.
- Many screens and transitions animate. Wait for animations to settle before
  taking screenshots or evaluating whether controls are present and operable.
- Use DaisyUI toggles for switches. Enabled toggles must visibly use the primary
  color: include `toggle-primary checked:border-primary checked:bg-primary
  checked:text-primary-content` alongside the toggle size class.

## Build & dev

- **No separate web dev server and no Vite.** The single `Bun.serve` process in
  `apps/server` bundles and serves the React app with HMR. `apps/web` has no
  `dev` script by design.
- **Tailwind + DaisyUI are compiled by Bun.** Keep `apps/server/bunfig.toml`
  with its `[serve.static]` `bun-plugin-tailwind` entry: Bun resolves
  `bunfig.toml` from the server's cwd, not the workspace root. The web HTML
  imports `src/app.css` directly; do not add a Tailwind CLI watcher, generated
  stylesheet, or a separate frontend dev server. CSS saves trigger Bun HMR;
  `src/main.tsx` reloads the page after an update as a compatibility fallback
  for CSS plugin updates.
- **Production web build:** `bun run build` (root) runs `build.ts`, which passes
  `bun-plugin-tailwind` to `Bun.build` and writes to `apps/server/dist/web`. In
  dev the HTML is bundled on the fly; `dist/` is gitignored.

## Runtime

- **Frontend uses `useExternalStoreRuntime`, not the data-stream runtime.** We
  own message state (load history via tRPC, stream via `fetch` + our SSE parser,
  Stop via the stop endpoint, resume on load). The data-stream runtime can't
  seed persisted history, which our reload/resume flow needs.

## Tests

- Frontend unit tests use Bun's test runner, React Testing Library, and
  Happy DOM (`bunfig.toml` in this directory). Run with `bun run test:web` from
  the repo root.
