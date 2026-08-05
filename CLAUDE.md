# CLAUDE.md

Guidance for Claude Code (and humans) working in this repo. Read before editing.

> **Picking up a Trello ticket, or making any change?** Always work it through the card → worktree → PR workflow in
> the global runbook **`~/.claude/CONTRIBUTING.md`** (Signal Web App specifics are in the
> **Contributing workflow** section below). This file covers *architecture and conventions*;
> the runbook covers *how to pick up a card and ship it*.

## What this is

A **local web UI for Signal**. It does *not* reimplement Signal's protocol — it bridges
to the user's already-running **Signal Desktop** via the Chrome DevTools Protocol (CDP)
and calls Signal's own internal functions. You open it as a browser tab.

```
Browser tab (vanilla JS)  <—REST + SSE—>  Node server  <—CDP (ws)—>  Signal Desktop renderer (:9222)
```

- **Trello board:** local file backend, board id `6a353dfe` (use `trello --backend local`) — workflow in `~/.claude/CONTRIBUTING.md` (see the **Contributing workflow** section).
- **Zero runtime dependencies.** Node built-ins only (`http`, global `fetch`/`WebSocket`),
  vanilla JS frontend. No build step, no `npm install`, no framework.

## Contributing workflow

Card -> worktree -> PR runbook: follow `~/.claude/CONTRIBUTING.md` (the global generic runbook). Signal Web App specifics:

- **Board:** Signal Web App, id `6a353dfe`, **local backend** - every board command needs `--backend local`. Lists: To Do / Doing / Done. Atomic pickup (truly atomic on the local backend): `trello --backend local --board 6a353dfe grab --from "To Do" --to "Doing"`.
- **Default branch:** `main`. **GitHub:** solo public repo (unprotected `main` -> PR + self-merge, no approval needed).
- **Worktrees:** `.trees/<branch>` (branch-named, gitignored). **Zero-dep app** - no `.env`, no `node_modules`, no build step - so a fresh worktree is ready to run immediately (no bootstrap).
- **Verification gate:** `npm test` (node's built-in runner, zero-dep) covers the DOM-free logic: [public/format.js](public/format.js) (the formatting parser and the shortcode lookups), [public/ui-logic.js](public/ui-logic.js), and the pure helpers of [src/tldr.js](src/tldr.js). Everything else is hands-on: `npm start` with Signal running (`npm run launch-signal`); hit `GET /api/status` -> expect `{"status":"ready", ...}`; exercise the change in a browser (Claude_Preview / claude-in-chrome) and confirm no console errors. **Do all send/receive testing against "Note to Self"** so you never message a real contact.

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
| [src/page-api.js](src/page-api.js) | **The contract with Signal.** A string of JS injected into the isolated context. Defines `window.__sb` (list/getMessages/getAttachment/getPreviewImage/sendText/sendMedia/warmLinkPreview/editMessage/deleteMessage/markRead/sendTyping) and a redux subscriber that queues change events into `window.__sbQueue`. This is the single place to repair if Signal renames internals. ⚠️ The whole file body is a **template literal**, so a `/` inside a regex literal must be written `\\/` or the template silently turns it into a `//` line comment — `node -e "import('./src/page-api.js').then(m=>new Function(m.INSTALL_SCRIPT))"` catches it. |
| [src/bridge.js](src/bridge.js) | Composes CDP + page API into clean async methods; runs the 200ms drain loop that turns `__sbQueue` into `'event'` emissions. |
| [src/server.js](src/server.js) | `http` server: REST routes, SSE stream (`/api/events`), static files. **Binds `127.0.0.1` only.** |
| [src/youtube.js](src/youtube.js) | YouTube link detection (`findYouTubeUrl`/`parseVideoId`) + transcript fetch: a zero-dep HTTP path (watch page → `captionTracks` → timedtext `json3`), with a `yt-dlp` fallback (if installed; `TLDR_YTDLP=0` disables it) for when YouTube bot-gates the direct fetch. Its `--sub-langs` request is narrow-then-wide (`subLangsFor`): a trailing `.*` there fans out to every auto-translated track and earns a `429`, so the wide pattern is the fallback, never the first attempt. The one place to re-probe if YouTube changes and auto-TLDR stops working. |
| [src/tldr.js](src/tldr.js) | Auto-TLDR feature: per-chat settings (`.tldr-settings.json`), the `claude` CLI spawn, and the realtime watcher. Pure orchestration over the bridge's existing `getMessages`/`sendText` — no `page-api.js`/`bridge.js` change. |
| [public/](public/) | UI: `index.html`, `style.css`, `app.js`. |
| [public/format.js](public/format.js) | Message-text formatting, both directions: the composer's markdown-ish syntax + `:shortcode:` emoji → `{ text, bodyRanges }` (`parseFormatting`), Signal's style ranges → DOM (`renderFormatted`), and back to source for the edit box (`toMarkdown`). Also the two lookups behind the composer's shortcode autocomplete: `shortcodeQueryBefore` + `matchShortcodes`. |
| [public/ui-logic.js](public/ui-logic.js) | The **DOM-free half of the frontend**: decision logic lifted out of `app.js` so `npm test` can reach it (avatar colour/initials, conversation preview text, the message-menu eligibility rules, attachment kind/icon, the emoji pick-frequency parse + decay/cap maths, `/gif` parsing, the auto-TLDR map eviction, retry error text, the jumbomoji size ladder). **Nothing here may touch a browser global** — no `document`/`window`/`localStorage`/`fetch`; anything needing one takes it as an argument (storage is passed in as the raw stored string). Put new pure logic here rather than in `app.js`. |
| [public/emoji-shortcodes.js](public/emoji-shortcodes.js) | **Generated** `:shortcode:` → emoji map (~1900 entries). Do not hand-edit — re-run `node scripts/gen-emoji-map.mjs` (it reads Signal's own `build/emoji-data.json` out of its `app.asar`, so our shortcodes are exactly Signal's). |
| [scripts/](scripts/) | `launch-signal.ps1` (relaunch Signal w/ debug port, tray), `autostart.ps1` + `install-autostart.ps1` (login plumbing), `gen-emoji-map.mjs` (regenerates the emoji map after a Signal update). |

## How the core operations work (don't relearn these the hard way)

- **List conversations** — read `reduxStore.getState().conversations.conversationLookup`.
  Already UI-shaped. Filter to `activeAt || isPinned`; sort pinned-first then by timestamp.
- **Read history** — `conversation.loadNewestMessages()` / `loadOlderMessages(oldestId)`.
  This populates `messagesByConversation[id]` + `messagesLookup` in redux **without
  changing the user's visible Signal window** (verified). Then read those. Messages are
  *not* in redux until loaded.
- **Send text** — `conversation.enqueueMessageForSend({ body, attachments: [], preview: [], bodyRanges }, { dontClearDraft: true })`.
  ⚠️ `attachments` **must be an array** — the function does `attachments.map(...)` and
  throws `undefined.map` if you pass only `{ body }`. `bodyRanges` carries the formatting
  (see **Text formatting** below); `[]` for unformatted text.
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
- **Text formatting (bold/italic/…) + emoji shortcodes** — Signal keeps a message's `body`
  **plain** and describes formatting out-of-band in `bodyRanges`:
  `{ start, length, style }` with `style` = Signal's `BodyRange.Style`
  (**BOLD=1, ITALIC=2, SPOILER=3, STRIKETHROUGH=4, MONOSPACE=5** — probed out of Signal's
  own bundle; @mentions ride in the same array instead carrying a `mentionAci`). Offsets are
  **UTF-16 code units** (plain JS string indices), the same units Signal's own composer uses.
  Signal Desktop has **no markdown input** (its formatting comes from the toolbar/hotkeys),
  so the `*bold*` / `_italic_` / `~strike~` / `` `mono` `` / `||spoiler||` syntax is **ours**,
  parsed in [public/format.js](public/format.js) — but what goes on the wire is Signal's
  native ranges, so recipients on any client see real formatting. Flow: the composer parses
  `raw → { text, bodyRanges }` **client-side** (one parser, also used for the optimistic echo
  and re-used by the `↑` quick-edit prefill via `toMarkdown`), the server *sanitizes* the
  ranges (`sanitizeBodyRanges` — drops anything malformed/out-of-bounds; they go straight into
  Signal), and `page-api.js` hands them to the same `enqueueMessageForSend` /
  `sendEditedMessage` calls as before. Reading back, `formatBody` in
  [src/page-api.js](src/page-api.js) inlines mentions into the text **and realigns the style
  ranges** across each splice (a mention placeholder is 1 char but renders as `@Name`), so the
  frontend gets `{ text, bodyRanges }` already aligned. `:shortcode:` emoji expand **as you
  type** in the composer and again at send time (for pasted text); the map is generated from
  Signal's own emoji table (see the file map). A marker or shortcode you meant literally is
  escaped with a backslash (`\_not italic\_`).
- **Emoji shortcode autocomplete** — the open half of the above: `shortcodeBefore` handles a
  *closed* `:shrug:`, `shortcodeQueryBefore` spots an *open* `:shr` at the caret and
  `matchShortcodes(query, limit, weights)` ranks candidates (both in
  [public/format.js](public/format.js)), which [public/app.js](public/app.js) renders as a
  popup above the composer (`.emoji-pop`, appended into `.composer`; arrows move, Enter/Tab
  pick, Escape dismisses). Matching is **substring**, not just prefix — Signal's names are
  often unguessable, so `:up` has to find `thumbs_up`. Ranking tiers (exact → prefix →
  substring) are primary and stay primary; a per-browser `localStorage` pick-count
  (`sb.emojiFreq`) only breaks ties *within* a tier, so a prefix match is never buried under
  a favourite substring one. Those counts **decay** — halved every `EMOJI_FREQ_HALFLIFE`
  picks — so a phase ages out instead of ranking forever. The list is a **hard cap of 8**
  with no scrolling (type another char to narrow). The popup's keys are handled at the top of
  the composer's existing `keydown` listener, so while it's open they win over Enter→send and
  ↑→quick-edit; it's suppressed mid-IME-composition like the inline expansion is.
- **Jumbomoji (emoji-only messages)** - a message whose text is *nothing but* emoji renders
  large and with no bubble at all. The sizes and the cap are **Signal Desktop's own**, read out
  of its bundle (`getJumboEmojiCount` + the size enum): whitespace is ignored, any non-emoji
  character disqualifies it, and the cap is **5** emoji -> **1=56px, 2=48px, 3=40px, 4=36px,
  5=32px**; 6+ or mixed text falls back to the ordinary 14.5px bubble. Signal's veto clauses
  come with it - **attachments** (a caption beside a photo is still a caption), **link preview
  cards**, and **any `bodyRanges`**, so a spoilered or monospaced emoji stays an ordinary
  message. (Signal's predicate also lists quotes; this UI doesn't render those into the bubble,
  so there is nothing to veto on there.) Where we *do* diverge from Signal knowingly: Signal filters
  its matches through its own emoji table, we go by Unicode properties, so a handful of bare
  pre-VS16 pictographs (`☝`, `⬆`) jumbo here and don't there.
  `jumboSizeFor` in [public/ui-logic.js](public/ui-logic.js) is the whole decision;
  `applyJumbo` in [public/app.js](public/app.js) only paints it (class + inline `font-size`,
  which is why the `.bubble.jumbomoji` CSS must never set a size of its own). Counting uses
  `/\p{RGI_Emoji}/v` - the `v` flag's set-of-strings property, so a ZWJ family, flag, keycap or
  skin-toned emoji is **one** match rather than several code points; `\p{Extended_Pictographic}`
  is a second alternative purely to catch the bare pre-VS16 forms (a bare `❤` with no U+FE0F)
  that RGI excludes but other clients still send - minus a deny-list of five that are
  typography rather than emoji when written bare (`© ® ™ ‼ ⁉`), or the one-character message
  "™" would render at 56px. `applyJumbo` always *clears* as well as sets,
  because an in-place edit reuses the same bubble node and can cross the emoji-only line in
  either direction; both optimistic send echoes re-apply it after they inject their media,
  since `messageRow` built those rows with an empty `attachments` array.
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
- **Edit a message** — `window.__sb.editMessage(conversationId, targetMessageId, body, bodyRanges)` →
  `window.reduxActions.composer.sendEditedMessage(conversationId, { targetMessageId, message, bodyRanges })`.
  This is Signal's own edit path (the composer thunk); it replaces the body, **keeps
  the same message id**, records an edit revision, and re-sends per Signal's edit
  protocol. Verified it works **without the conversation being open**. There is **no**
  `enqueueEditMessageForSend` model method in current Signal — the composer action is the
  path. Text-only (attachments on the message are left untouched). `formatMessage` exposes
  an `edited` flag (from `editMessageTimestamp`/`editHistory`) so the UI shows an "Edited"
  marker. Route: `POST /api/conversations/:id/messages/:messageId/edit` with `{ text, bodyRanges? }`.
- **Delete a message** — `window.__sb.deleteMessage(conversationId, messageId, forEveryone)`.
  `forEveryone:false` → `reduxActions.conversations.deleteMessages({ conversationId, messageIds:[id] })`
  (local-only delete; **always works**, removes the message). `forEveryone:true` →
  `reduxActions.conversations.deleteMessagesForEveryone([id])` — Signal's **unsend**, which
  can fail (outside the time window, undelivered, or in **Note to Self**, which has no other
  recipient to retract from → it raises a `DeleteForEveryoneFailed` toast). The redux action
  does **not** throw on failure, so for the forEveryone path `deleteMessage` briefly watches
  both the message's `deletedForEveryone` flag (success) and that toast (failure) to return a
  real `{ok}`. ⚠️ **Delete-for-everyone cannot be verified against Note to Self** — test it
  against a real recent message. Route:
  `POST /api/conversations/:id/messages/:messageId/delete` with `{ forEveryone? }`. The
  frontend adds a hover "…" menu (Edit / Delete for everyone / Delete for me), a composer
  edit mode (banner + Escape to cancel), and **↑ on an empty composer** to quick-edit your
  last message.
- **Mark a thread read** — `window.__sb.markRead(id)` →
  `conv.markRead({ received_at, sent_at }, { sendReadReceipts: true })`. ⚠️ Current Signal's
  `markRead` takes the **newest message as `{ received_at, sent_at }`, not a bare timestamp**
  (`received_at` — the monotonic counter, *not* `received_at_ms` — drives which messages get
  marked read; `sent_at` is only logged). `conv.markRead(Date.now())` silently threw a SQL
  bind error inside `getUnreadByConversationAndMarkRead`, so the read state never persisted
  and the unread badge came back on reload. We read those two values straight off the
  conversation (`lastMessageReceivedAt` / `timestamp`) so no message load is needed, then
  `throttledUpdateUnread.flush()` so the recomputed `unreadCount` reaches redux/SSE promptly,
  and also clear the manual `markedUnread` flag (which `markRead` leaves alone). **Do not**
  reach for Signal's redux `conversations.markConversationRead` action: it no-ops unless the
  Signal window `isActive()`, which it isn't while we drive it headlessly. Route:
  `POST /api/conversations/:id/read`.
- **Inline media** - attachments are stored ENCRYPTED on disk (v2, per-file `localKey`).
  Signal's renderer registers an `attachment://` protocol that decrypts on the fly, so
  `window.__sb.getAttachment(messageId, index, {thumbnail})` just fetches
  `attachment://v2/<path>?size=&key=<localKey>&contentType=` *inside* the isolated
  context (the `key` param is `localKey`; `localKey=` 400s) and returns base64. The
  server route `GET /api/attachments/:messageId/:index` (`?thumb=1` for video posters)
  decodes it, serves with immutable caching + Range support, and keeps a small bounded
  in-memory Buffer cache so re-views/seeks don't re-hit the renderer.
- **Link preview cards ("postcards")** — Signal keeps them out-of-band on the message as
  `preview: [{ url, title, description, date, image }]`, where `image` is an **ordinary v2
  encrypted attachment** (`path` + `localKey`) — so `attachmentUrl()` handles it verbatim and
  `fetchDecrypted()` in [src/page-api.js](src/page-api.js) is shared by `getAttachment` and the
  new `getPreviewImage`. Route: `GET /api/previews/:messageId/:index`, which reuses the
  attachment byte cache and its in-flight dedupe (`loadMedia`, keyed `prev:<id>:<i>` — message
  ids are UUIDs and hold no `:`, so it can't collide with the unprefixed attachment keys).
  Stored previews carry **no `domain` field** (only freshly-grabbed ones do), so the frontend
  derives it from the url (`previewDomain`).
  **Sending** one uses Signal's *own* fetcher rather than an OG scraper of ours:
  `reduxActions.linkPreviews.debouncedMaybeGrabLinkPreview(text, 'Composer', {conversationId})`
  fills `reduxStore.getState().linkPreviews.linkPreview`, and that object goes straight into the
  same `enqueueMessageForSend` — Signal then encrypts, stores and uploads the image exactly as
  it does for an attachment (verified round-trip: 26665 bytes in, 26665 out). The grab happens
  **in-page, inside `sendText`**, because the preview's image is an in-memory `Uint8Array`;
  returning it over CDP would serialize the bytes into an integer-keyed object for nothing.
  ⚠️ **Gated on the user's `items.linkPreviews` setting** (Signal → Settings → Privacy →
  *Generate link previews*). With it off Signal fetches nothing and neither do we — that
  setting is the entire gate, because we never fetch a URL by any other route.
  ⚠️ **`linkPreviews` is ONE GLOBAL redux slot, not per-composer.** Grabbing stomps whatever
  Signal's own window has staged if the user is typing a link there at that instant; it
  self-heals on their next keystroke, and there is no per-conversation slot to use instead.
  So a preview is only ever attached when its url actually appears in the body being sent.
  To keep sends snappy the composer **warms** the slot while you type (debounced,
  `POST /api/link-preview/warm`), so `sendText` normally finds one waiting and waits 0ms; the
  in-send grab (up to 5s) is the fallback for paste-and-send. A failed preview never costs the
  message — it's caught and the message goes out bare. **A link needs an explicit `http(s)://`
  scheme** to get a card: `bodyHasLink` gates the in-send poll and `hasLink` gates the warm, and
  without that gate every link-free message would sit out the full 5s timeout waiting for a
  preview that was never coming. Signal itself previews a bare `example.com`; we don't (yet). Media sends and the GIF path keep
  `preview: []` (Signal doesn't card a message that carries attachments), and the card vetoes
  jumbomoji.
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
  `yt-dlp` fallback if installed; `TLDR_YTDLP=0` disables it), asks **Claude** for a summary
  of at most four sentences (~100 words) plus **one verbatim quote from the video** -- 5 to 20
  words, copied word-for-word, and omitted entirely rather than invented when nothing is worth
  quoting,
  and sends `🤖 TLDR: …` back via the bridge's existing `sendText`. **There is no LLM API key.** The
  summary comes from spawning the **Claude Code CLI** (`claude -p`, see `claudeOnce`), so it
  bills the user's Claude *subscription* rather than a metered API key -- the same
  subprocess shape as the `yt-dlp` fallback, and the reason this is a spawn and not a
  `fetch`. Knobs: `TLDR_CLAUDE_BIN` (default `claude`), `TLDR_MODEL` (default
  `claude-opus-5`), `TLDR_EFFORT` (default `medium`). Five things about that invocation hold the feature up and
  should not be dropped casually:
  (1) the transcript goes in on **stdin**, never argv -- 600k chars would blow past the
  Windows command-line limit;
  (2) `cwd` is an empty dir of ours (`runDir`), because `claude` discovers *project* CLAUDE.md
  and settings from its cwd upward and must not inherit *this* repo's. Never point it at
  `os.tmpdir()` itself, which is a plausible discovery root full of other processes' files;
  (3) `--tools ""` `--strict-mcp-config` `--disable-slash-commands` `--setting-sources ""` are
  cost **and safety** -- measured **48.5k -> 648** cache-creation tokens and ~2s per summary
  (`--setting-sources ""` is most of that: otherwise the user's global `~/.claude/CLAUDE.md` is
  prepended to every summary), and a run with no tools, no MCP servers and no user hooks has
  nothing an untrusted transcript can talk it into doing. Note `--exclude-dynamic-system-prompt-sections`
  is **ignored** whenever `--system-prompt` is passed, so it is not in the list;
  (4) `--no-session-persistence`, or `claude -p` writes a full session transcript under
  `~/.claude/projects/` keyed on cwd -- i.e. up to `MAX_TRANSCRIPT_CHARS` of third-party caption
  text per video, persisted to the user's home directory forever;
  (5) failure is reported **in-band**: the JSON envelope can carry `is_error` with exit 0, so
  the callback checks the envelope even when `err` is null. `isTransientClaudeError` is an
  allow-list (`timeout`/`bad-output`) for the same reason -- retrying a logged-out CLI or a bad
  `TLDR_MODEL` just burns three spawns to fail identically. Summaries are also serialized
  process-wide (`enqueue`), since each one is a whole Node runtime rather than a `fetch`.
  The transcript and title are untrusted third-party text, so the **instructions live in the
  system prompt and the transcript in the user turn** (`buildPrompt` returns `{system, user}`)
  -- that turn split is the real privilege boundary, with the `<transcript>` fence kept on top
  of it and a literal tag in the captions stripped first. `SYSTEM_PROMPT` asks for a JSON
  object `{summary, quote}`, so `parseReply` gets the quote as its own field instead of
  reverse-engineering it out of the reply's last line; `splitQuoteLine` is now only the
  fallback for a reply that misses the schema. The TLDR can't trigger itself because
  `defangUrls` **strips the URL scheme** from the summary before sending (`https://youtu.be/x`
  -> `youtu.be/x`), and `findYouTubeUrl` requires a literal `http(s)://` - the TLDR is an
  outgoing message, so without that a quoted link would loop. `formatTldr` composes what
  actually goes out, taking **either** the parsed `{summary, quote}` object **or** the raw
  reply text; a string goes through `splitQuoteLine`, which peels off the trailing quoted line
  only when that line is *nothing but* a quoted span -- an attribution or an inline quote stays
  in the paragraph, since a mis-split would italicise half a sentence. `quoteLine` then
  normalises either shape into one wrapped, single-line span: the JSON field arrives **bare**
  (its string was the wrapper) while the text path arrives already wrapped, and a literal `""`
  means "no quote" rather than an empty pair of marks in the chat. The summary and
  the quote are clamped separately (`MAX_TLDR_CHARS` / `MAX_QUOTE_CHARS`, so the clamp cannot
  eat the quote we just went to the trouble of pulling out; `clampSummary` closes an
  unbalanced quotation mark when it truncates, so a cut never presents half a quote as
  speech), and the quote line carries a **real Signal ITALIC `bodyRange`** (style 2, offsets
  measured on the composed string -- the prefix emoji is a surrogate pair) rather than literal
  `_underscores_`. That is the only reason this feature passes `bodyRanges` to `sendText` at
  all. **Failures are logged and swallowed — never posted into the
  chat.**
- **The "For context" block (`TLDR_CONTEXT`, default on)** - a third section under the quote:
  who the channel/author is, and how the video's claims hold up. It is a **SECOND, SEPARATE
  `claude` run** (`researchContext`), and that separation is the whole design, not an
  accident of implementation:
  - Researching a channel needs `WebSearch`/`WebFetch`. The **summary** pass holds up to
    `MAX_TRANSCRIPT_CHARS` of attacker-influenceable caption text, and giving web tools to
    *that* run is exactly the injection surface `--tools ""` exists to close. **Never merge
    the two passes.**
  - So the context pass never sees the transcript. Its entire input is the channel name, the
    title and the summary pass's own output (~430 chars measured, vs up to 600k) -- still
    transcript-derived, but a fraction of the surface -- and its tools are limited to search
    and fetch. Its fence is `<video>`; `stripFenceTags` strips **both** fence names from every
    untrusted field so a caption cannot forge the *other* pass's delimiter and ride through on
    the summary handed between them.
  - ⚠️ **`--tools` and `--allowedTools` are both required.** `--tools` decides which tools
    exist, `--allowedTools` which may run unprompted. In `-p` mode nobody can approve a
    permission prompt, so a tool that exists but isn't allowed makes the model ask and then
    give up -- which looks identical to "researched it and found nothing". That cost a
    debugging round: 5 turns, 0 searches, both fields empty.
  - The prompt (`CONTEXT_SYSTEM_PROMPT`) ports the Core Principles of the user's `research`
    skill rather than loading it: a search blurb is not a source, never fill a gap with a
    guess, don't supplement from memory, delete anything unsupported, prefer `""` over a
    hedge. Loading the real skill would need `--setting-sources user`, which re-prepends the
    global CLAUDE.md to every run and re-enables user hooks on transcript-derived input, and
    would couple a shipped feature to personal files outside the repo. These guardrails matter
    more here than anywhere else in the app: the block asserts things about **real people** and
    auto-sends with nobody reviewing it.
  - Both fields are optional and an empty pair means **no block at all** (`parseContext`
    returns null) -- a music video with nothing to fact-check is a normal outcome. The pass is
    never retried and every failure is swallowed: the summary goes out without the block
    rather than not at all.
  - ⚠️ **Title and channel do NOT come from the watch page in practice.** `videoDetails` has
    both, but that page is the bot-gated one -- on a gated network *every* transcript comes
    from the yt-dlp fallback, which writes subtitles and nothing else, so both were null for
    every video (the summary pass had been running title-less long before the context block
    existed). `fetchMeta` in [src/youtube.js](src/youtube.js) tops up whatever is missing from
    YouTube's **oEmbed** endpoint -- public, unauthenticated, ungated -- on every path. Only if
    oEmbed itself fails does the block degrade to researching the summary alone.
  - The label carries a **BOLD** `bodyRange` (style 1) covering exactly `For context:` and not
    its trailing space, alongside the quote's ITALIC range.
  This is entirely server-side (works with no browser tab open) and touches no
  Signal internals beyond `getMessages`/`sendText`, so a Signal update won't break it; a
  *YouTube* change will, and the fix is localized to `src/youtube.js`.
- **Live UI feedback for auto-TLDR** - the pipeline emits per-stage events
  (`fetching` -> `summarizing` -> `researching` -> `retrying` -> `done`/`failed`, keyed by
  conversationId) through an `onStage` callback passed into `createTldr`.
  [src/server.js](src/server.js) forwards them over the **existing** SSE channel as
  `broadcast('signal', {type:'tldr', conversationId, state, url, reason?})`. The
  frontend ([public/app.js](public/app.js)) renders a transient, **local-only**
  status bubble pinned below the open thread (`#tldrStatus`, kept outside
  `#messagesInner` so message refreshes don't wipe it) - a spinner + label while
  working; on failure it stays put with the friendly `reason`, a **Retry** button,
  and a dismiss "x". A `done` event can carry a `reason` too: it means the TLDR was
  **sent but its "For context" block was lost to a failure** (a clean `done` has no
  reason and just clears the bubble), and the UI renders a quieter dismiss-only
  notice for it - no Retry, since the summary is already in the chat and a retry
  would send a duplicate. What each stage renders (label/icon/buttons) is the pure
  `tldrBubble` in [public/ui-logic.js](public/ui-logic.js); app.js only paints it.
  It is **never** a Signal message. Retry POSTs to
  `/api/conversations/:id/tldr/retry {url}` -> `tldr.retry(id, url)`, which re-runs
  the summary **bypassing the dedup/`since`-floor guards**, so it works even after
  the automatic retries are spent (the point on a bad day). `reason`
  is sanitized server-side (`friendlyReason` / `friendlyContextReason` in
  [src/tldr.js](src/tldr.js)): both return only fixed phrases derived from our own `claude-*`
  error tags, so raw stdout/stderr -- which can
  carry transcript text or a timedtext URL -- never reaches the browser. The bubble shows the open
  conversation's status, but app.js keeps status **per conversation** in an
  in-memory `Map` (`tldrByConv`) so it survives switching chats and re-hydrates
  when you reopen a chat mid-run; it's cleared on a page reload / server restart
  (no persisted log). A sidebar / cross-conversation indicator is still out of
  scope.

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
- **Loading older history: one path, one anchor.** `loadOlderMessages()` in
  [public/app.js](public/app.js) is the only caller of `?older=1` — the `#loadOlder`
  button *and* the scroll gesture both go through it, so the scroll-anchor settle
  (pin the topmost `data-mid` row, keep correcting via `ResizeObserver` until sizes
  go quiet or the user scrolls) behaves identically either way. The gesture arms
  within `OLDER_ARM_PX` of the top, then needs `OLDER_INTENT_PX` of *further* upward
  scrolling spread over at least `OLDER_DWELL_MS`, with `OLDER_COOLDOWN_MS` after each
  load — so one flick to the top can't chain-load the whole history. Those four
  constants are pure feel; retune freely. Upward intent comes from falling `scrollTop`
  *and* from raw wheel/touch deltas, because a thread parked at `scrollTop 0` stops
  emitting scroll events entirely.
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
- `npm test` only reaches pure, DOM-free logic ([public/format.js](public/format.js),
  [public/ui-logic.js](public/ui-logic.js), the helpers in [src/tldr.js](src/tldr.js)). Nothing that touches
  CDP, the server, or the DOM is covered (notably the emoji popup's state machine, which
  still lives in `app.js`), so **also** run the app and exercise the change (the
  `Claude_Preview` / `claude-in-chrome` tools work well; test sends against **Note to
  Self** so you never message real contacts).
- **`textarea.setRangeText()` does not write to the browser's undo stack** — Ctrl+Z skips
  straight past anything inserted with it (verified in Chrome 150). Any programmatic edit to
  the composer goes through `replaceRange()` in [public/app.js](public/app.js), which uses
  `document.execCommand('insertText')` instead. Deprecated, but it's the only API that still
  records undo. It fires a **synchronous `input` event**, so the composer's own `input`
  handler re-enters once per edit — harmless (the second pass finds nothing left to expand)
  but worth knowing before adding work to that handler.
