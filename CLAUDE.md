# CLAUDE.md

Guidance for Claude Code (and humans) working in this repo. Read before editing.

## What this is

A **local web UI for Signal**. It does *not* reimplement Signal's protocol — it bridges
to the user's already-running **Signal Desktop** via the Chrome DevTools Protocol (CDP)
and calls Signal's own internal functions. You open it as a browser tab.

```
Browser tab (vanilla JS)  <—REST + SSE—>  Node server  <—CDP (ws)—>  Signal Desktop renderer (:9222)
```

- **Trello board:** https://trello.com/b/xPTe6ZZx (id `6a353dfe`) — workflow in [CONTRIBUTING.md](CONTRIBUTING.md).
- **Zero runtime dependencies.** Node built-ins only (`http`, global `fetch`/`WebSocket`),
  vanilla JS frontend. No build step, no `npm install`, no framework.

## The one thing you must know about the CDP layer

Signal Desktop runs with context isolation. **Its internals
(`ConversationController`, `reduxStore`, `reduxActions`, conversation models, …) live in
the renderer's *isolated* execution context — NOT the main world.** A naive
`Runtime.evaluate` targets the main world and sees `undefined` for everything. Every
evaluate must target the isolated context's id.

- Context ids change on reload/navigation. [src/cdp.js](src/cdp.js) tracks
  `Runtime.executionContextCreated` / `…Destroyed` / `…Cleared` and always re-resolves
  the isolated context. `evaluate()` waits for it and retries once on context loss.
- After any reconnect or context swap, the injected page API must be re-installed
  ([src/bridge.js](src/bridge.js) clears its `_injected` flag on `context-changed`).

## File map

| File | Role |
|------|------|
| [src/cdp.js](src/cdp.js) | Generic CDP client over the built-in `WebSocket`. Connects to the `background.html` page target, tracks the isolated context, auto-reconnects with backoff. |
| [src/page-api.js](src/page-api.js) | **The contract with Signal.** A string of JS injected into the isolated context. Defines `window.__sb` (list/getMessages/sendText/markRead/sendTyping) and a redux subscriber that queues change events into `window.__sbQueue`. This is the single place to repair if Signal renames internals. |
| [src/bridge.js](src/bridge.js) | Composes CDP + page API into clean async methods; runs the 200ms drain loop that turns `__sbQueue` into `'event'` emissions. |
| [src/server.js](src/server.js) | `http` server: REST routes, SSE stream (`/api/events`), static files. **Binds `127.0.0.1` only.** |
| [public/](public/) | UI: `index.html`, `style.css`, `app.js`. |
| [scripts/](scripts/) | `launch-signal.ps1` (relaunch Signal w/ debug port, tray), `autostart.ps1` + `install-autostart.ps1` (login plumbing). |

## How the core operations work (don't relearn these the hard way)

- **List conversations** — read `reduxStore.getState().conversations.conversationLookup`.
  Already UI-shaped. Filter to `activeAt || isPinned`; sort pinned-first then by timestamp.
- **Read history** — `conversation.loadNewestMessages()` / `loadOlderMessages(oldestId)`.
  This populates `messagesByConversation[id]` + `messagesLookup` in redux **without
  changing the user's visible Signal window** (verified). Then read those. Messages are
  *not* in redux until loaded.
- **Send text** — `conversation.enqueueMessageForSend({ body, attachments: [], preview: [], bodyRanges: [] }, { dontClearDraft: true })`.
  ⚠️ `attachments` **must be an array** — the function does `attachments.map(...)` and
  throws `undefined.map` if you pass only `{ body }`.
- **Realtime** — the in-page redux subscriber compares slice references and pushes
  `{type:'conversations'}` / `{type:'messages',conversationId}` into `__sbQueue`. The
  server drains every 200ms and forwards over SSE. ~instant, no polling of large state.

## Conventions

- **No new dependencies** without a very good reason — zero-dep is a feature (instant
  start, no supply-chain surface). Prefer Node built-ins.
- **ESM** everywhere (`"type": "module"`). The injected `page-api.js` body is plain ES5-ish
  for safety in Signal's context, but Electron is modern so async/`const` are fine.
- **Frontend builds DOM with `createElement`**, never `innerHTML`, for any message,
  conversation, or contact-derived content — message bodies are attacker-influenced
  (XSS). The `el()` helper's `html:` option is for trusted static markup only.
- **Localhost only.** Never bind the server to a non-loopback interface; this exposes the
  user's Signal. CDP is localhost-only by nature.
- **Reading does not send read receipts.** `loadNewestMessages` doesn't; `markRead` is a
  separate, opt-in endpoint the UI does not auto-call.
- Match the surrounding style; comment only where the *why* is non-obvious.

## Running

```bash
npm run launch-signal   # relaunch Signal w/ --remote-debugging-port=9222 (tray)
npm start               # server on http://127.0.0.1:7700
```

`npm run autostart:install` wires up login autostart (Windows). See README.

## Gotchas

- Signal **must** run with `--remote-debugging-port=9222`. Its own login-launch and Start
  Menu shortcut do **not** pass the flag — use `launch-signal.ps1` / the autostart.
- Internals are **undocumented** and can change between Signal versions. If something
  breaks after a Signal update, the fix is almost always localized to
  [src/page-api.js](src/page-api.js). Re-probe with a small CDP `Runtime.evaluate` in the
  isolated context.
- No automated test suite yet. Verify by running the app and exercising it (the
  `Claude_Preview` / `claude-in-chrome` tools work well; test sends against **Note to
  Self** so you never message real contacts).
