# Groundwork Frontend Build Contract

Read this before writing any frontend code. It is the shared contract the
build agents work against.

## Stack and layout

- React 19 + Vite 8 + TypeScript + Tailwind v4 (CSS-first theme in
  `web/src/theme.css`). Source root: `web/`. Build output: `dist/`
  (served by the Worker via the [assets] binding + SPA fallback).
- Routing: react-router-dom (BrowserRouter) wired in `web/src/App.tsx`.
  Add routes there; feature screens live in `web/src/features/<area>/`.
- Shared code: `web/src/lib/api.ts` (typed REST client for every Worker
  endpoint), `web/src/lib/ws.ts` (SessionSocket with auto-reconnect +
  outbox), `web/src/lib/session-store.ts` (useSession hook),
  `web/src/lib/types.ts` (client mirror of src/session-protocol.ts).

## Design system (mandatory)

Tokens are CSS custom properties in `web/src/theme.css` (also Tailwind
`@theme` colors: `bg-paper`, `text-ink`, `text-muted`, `bg-brand`,
`text-accent`, ...). Component classes: `.btn` (.btn-primary/.btn-accent/
.btn-ghost), `.card`, `.chip`, `.input`, `.label`, `.ledger-rule`.
Vibe: warm paper, deep navy ink, one amber accent, Fraunces display serif +
Sora body. Nothing generic; no purple gradients, no emoji-as-icons
(lucide-react is the icon set), no placeholder copy like "Lorem ipsum".
Every screen must look intentional on both the shared screen and phones.

## Backend API surface (see web/src/lib/api.ts for typed wrappers)

- Org/program: POST /org, POST /org/:id/users, POST /org/:id/program,
  GET /program/:id, POST /program/:id/lab-session,
  POST /lab-session/:id/complete, POST /lab-session/:id/consent,
  POST /program/:id/initiative, POST /initiative/:id/step,
  GET /program/:id/overdue-steps, POST /program/:id/coach/nudges,
  POST /program/:id/review-cycle, POST /review-cycle/:id/complete
- Session WS: /session/:key/connect (WebSocket; protocol in lib/types.ts:
  join, advance_segment, submit, vote; server pushes state)
- Audio: GET/POST /session/:id/audio/consent, POST /session/:id/audio/kill-switch,
  POST /session/:id/audio/chunk?segmentKey&sequence&offsetMs (binary body)
- Synthesis: POST /session/:id/synthesize, GET /session/:id/plan
- Commerce: POST /org/:id/checkout-session, POST /org/:id/billing-portal

## Rules

- IP firewall: no trademarked terms (see docs/vocabulary.md). Never touch
  docs/source-principles.md or content/packs/ (curriculum is human-gated).
- Keep the design language consistent; reuse theme.css tokens and classes.
- `npm run typecheck` (worker + web) and `npm run build:web` must pass.
- The room UI must degrade gracefully offline (banner + queued input).
- Leader override is absolute: nothing may lock the human in the room out.
