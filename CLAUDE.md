# CLAUDE.md

Guidance for Claude Code (and humans) working in this repo. Read before editing.

> **Picking up a Trello ticket, or making any change?** Always work it through the card → worktree → PR workflow in
> **[CONTRIBUTING.md](CONTRIBUTING.md)**. This file covers *architecture and conventions*;
> CONTRIBUTING.md covers *how to pick up a card and ship it*.

## What this is

A **local web UI for Signal**. It does *not* reimplement Signal's protocol — it bridges
to the user's already-running **Signal Desktop** via the Chrome DevTools Protocol (CDP)
and calls Signal's own internal functions. You open it as a browser tab.

```
Browser tab (vanilla JS)  <—REST + SSE—>  Node server  <—CDP (ws)—>  Signal Desktop renderer (:9222)
```

- **Trello board:** local file backend, board id `6a353dfe` (use `trello --backend local`) — workflow in [CONTRIBUTING.md](CONTRIBUTING.md).
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
| [src/cdp.js](src/cdp.js) | Generic CDP client over the built-in `WebSocket`. Probes `127.0.0.1` then `::1` (override with `SIGNAL_CDP_HOST`) for the host actually exposing `background.html`, connects to that page target, tracks the isolated context, auto-reconnects with backoff. |
| [src/page-api.js](src/page-api.js) | **The contract with Signal.** A string of JS injected into the isolated context. Defines `window.__sb` (list/getMessages/getAttachment/sendText/sendMedia/markRead/sendTyping) and a redux subscriber that queues change events into `window.__sbQueue`. This is the single place to repair if Signal renames internals. |
| [src/bridge.js](src/bridge.js) | Composes CDP + page API into clean async methods; runs the 200ms drain loop that turns `__sbQueue` into `'event'` emissions. |
| [src/server.js](src/server.js) | `http` server: REST routes, SSE stream (`/api/events`), static files. **Binds `127.0.0.1` only.** |
| [src/youtube.js](src/youtube.js) | YouTube link detection (`findYouTubeUrl`/`parseVideoId`) + transcript fetch: a zero-dep HTTP path (watch page → `captionTracks` → timedtext `json3`), with a `yt-dlp` fallback (if installed; `TLDR_YTDLP=0` disables it) for when YouTube bot-gates the direct fetch. The one place to re-probe if YouTube changes and auto-TLDR stops working. |
| [src/tldr.js](src/tldr.js) | Auto-TLDR feature: per-chat settings (`.tldr-settings.json`), the Gemini call, and the realtime watcher. Pure orchestration over the bridge's existing `getMessages`/`sendText` — no `page-api.js`/`bridge.js` change. |
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
- **Send media** — `window.__sb.sendMedia(id, body, files)` where
  `files = [{ fileName, contentType, base64, width?, height? }]`. It hands Signal
  *in-memory* attachment objects (`{ data: Uint8Array, contentType, size, fileName }`)
  through the **same `enqueueMessageForSend`** as text — Signal's own send path then
  writes+encrypts them to disk (v2/`localKey`), thumbnails, uploads to CDN, and delivers.
  Deliberately *not* the redux composer (`processAttachments`/`sendMultiMediaMessage`):
  that path only populates draft state for a conversation that is open/mounted in
  Signal's own window, so it can't be driven headlessly without `showConversation`.
  The route is `POST /api/conversations/:id/send` with body `{ text?, attachments? }`
  (base64-in-JSON, zero-dep; raw-file cap 25 MB, ≤10 files, 48 MB total body). Empty
  `body` is allowed when there's at least one attachment. (The old
  `window.Signal.Migrations.processNewAttachment` namespace is gone in current Signal —
  re-probe if this ever breaks.) The base64 rides *inside* the CDP evaluate
  expression (`bridge._call` stringifies args), so the bytes cross the wire as
  base64 — that's inherent to CDP's JSON-over-WebSocket transport (no binary arg
  channel; a `data:` URL can't be `fetch()`ed to decode it natively because
  Signal's CSP blocks `data:` in `connect-src` — probed). The server's caps above
  bound it. `sendMedia` decodes each file with `base64ToBytes` in `page-api.js`:
  native `Uint8Array.fromBase64` (Chrome 140+/current Signal, ~30x faster than a
  per-byte loop, no intermediate binary string), falling back to a chunked `atob`
  that yields to the event loop so a large decode never freezes Signal's UI.
- **Send a GIF:** the composer's `/gif` command (and the **GIF** button) open a
  Giphy-backed picker. The key stays server-side: `GET /api/gif/search?q=` proxies
  Giphy search/trending (needs `GIPHY_API_KEY`; if unset, the picker shows a
  "set your key" hint), returning only `{id, title, preview}` per result, so
  thumbnails load straight from Giphy's CDN. Picking one POSTs `{id, text?}` to
  `POST /api/conversations/:id/send-gif`; the server resolves that id to a media
  URL via Giphy, fetches the bytes (cap 12 MB), and sends them down the **same
  `sendMedia` path** as any attachment, so there's no `page-api.js`/`bridge.js`
  change. The browser only ever passes a Giphy id, so the proxy can't be aimed at
  arbitrary hosts. Optional `GIPHY_RATING` (default `g`) caps the content rating.
- **Inline media** - attachments are stored ENCRYPTED on disk (v2, per-file `localKey`).
  Signal's renderer registers an `attachment://` protocol that decrypts on the fly, so
  `window.__sb.getAttachment(messageId, index, {thumbnail})` just fetches
  `attachment://v2/<path>?size=&key=<localKey>&contentType=` *inside* the isolated
  context (the `key` param is `localKey`; `localKey=` 400s) and returns base64. The
  server route `GET /api/attachments/:messageId/:index` (`?thumb=1` for video posters)
  decodes it, serves with immutable caching + Range support, and keeps a small bounded
  in-memory Buffer cache so re-views/seeks don't re-hit the renderer.
- **Realtime** — the in-page redux subscriber compares slice references and pushes
  `{type:'conversations'}` / `{type:'messages',conversationId}` into `__sbQueue`. The
  server drains every 200ms and forwards over SSE. ~instant, no polling of large state.
- **Auto-TLDR YouTube links** — opt-in per chat (thread header → ⋮ menu →
  `GET`/`POST /api/conversations/:id/tldr`; the set of enabled ids persists in the
  gitignored `.tldr-settings.json`). [src/tldr.js](src/tldr.js) subscribes to the bridge's
  own `'event'` stream (same `{type:'messages',conversationId}` events the SSE layer uses)
  and, for an **enabled** conversation, loads the newest messages and looks for a *new,
  outgoing* message containing a YouTube link. Only the user's own links trigger it
  (`msg.direction === 'outgoing'`), and only messages newer than a per-chat timestamp floor
  (server boot / enable time) so history is never re-summarized; a bounded `processed` set
  dedupes. It fetches the transcript ([src/youtube.js](src/youtube.js) -- direct HTTP, then a
  `yt-dlp` fallback if installed; `TLDR_YTDLP=0` disables it), asks Gemini
  (`GEMINI_API_KEY`, `GEMINI_MODEL`, default `gemini-2.5-flash`) for a ~2-sentence summary
  (clamped to `MAX_TLDR_CHARS` before sending, since it auto-posts to real contacts),
  and sends `🤖 TLDR: …` back via the bridge's existing `sendText`. The TLDR has no link, so
  it can't trigger itself. **Failures are logged and swallowed — never posted into the
  chat.** This is entirely server-side (works with no browser tab open) and touches no
  Signal internals beyond `getMessages`/`sendText`, so a Signal update won't break it; a
  *YouTube* change will, and the fix is localized to `src/youtube.js`.

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
- **Loading history does not send read receipts; *opening* a thread does.**
  `loadNewestMessages`/`loadOlderMessages` only populate redux. But `openConversation`
  in [public/app.js](public/app.js) calls the `markRead` endpoint
  (`POST /api/conversations/:id/read`) so the unread badge clears — that goes through
  Signal's real `markRead`, which sends read receipts per the user's Signal settings
  (normal Signal Desktop behavior).
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
