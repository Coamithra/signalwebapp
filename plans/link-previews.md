# Link preview cards (render + send)

Card `0a5474a5`. Branch `feat/link-previews`.

## Context

Links in the message list are bare text. Every other chat app shows a "postcard" —
domain, title, description, hero image. Signal already carries exactly that data on
messages that have it; we just throw it away.

Two halves, and they're independent:

- **Render** — messages that already carry `preview` (anything sent by someone whose
  client generated one). Unconditional, no network, no settings.
- **Send** — links posted from *our* composer currently go out bare, because both send
  calls hardcode `preview: []`.

## Probed facts (2026-08-04, Signal 8.21.0)

Read side, off a real incoming Guardian message in `messagesLookup`:

```
msg.preview = [{ url, title, description, image }]
image = v2 encrypted attachment: { path, localKey, contentType:'image/jpeg',
                                   size:102412, width:1200, height:630, blurHash, ... }
```

So `attachmentUrl()` in page-api.js already handles the image verbatim — the decrypt
path needs no new work. Note the *stored* preview has no `domain` field (the freshly
grabbed one does); derive it from `url` instead of depending on it.

Send side:

```
reduxActions.linkPreviews = { addLinkPreview, debouncedMaybeGrabLinkPreview, removeLinkPreview }
reduxStore.getState().linkPreviews = { linkPreview?: {...} }   // ONE global slot
reduxStore.getState().items.linkPreviews = boolean             // the user's privacy setting
```

`debouncedMaybeGrabLinkPreview(text, 'Composer', { conversationId })` with the setting
**on** populates the slot within ~1-2s:

```
{ url, title, description, date, domain, isStickerPack, isCallLink,
  image: { data: Uint8Array(26665), contentType:'image/png', width:1024, height:576, blurHash } }
```

`image.data` is an **in-memory `Uint8Array`** — the same shape `sendMedia` already hands
to `enqueueMessageForSend`, which is why the send half is a reuse rather than new
machinery. With the setting **off** the grabber runs and produces nothing (verified).

## Design

### 1. Read — `src/page-api.js`

- Extract `fetchDecrypted(a)` out of `getAttachment` (the pending/path/key/size guards +
  `fetch(attachmentUrl(a))` + base64). `getAttachment` keeps the message/thumbnail lookup
  and delegates; the new `getPreviewImage(messageId, index)` does the same against
  `m.preview[index].image`.
- `describePreview(p)` beside `describeAttachment` — metadata only, never bytes:
  `{ url, title, description, date, image: { contentType, width, height } | null }`.
- `formatMessage` gains `preview: [...]`.

### 2. Read — `src/server.js`

- `GET /api/previews/:messageId/:index`, mirroring the attachment route: same LRU byte
  cache, same in-flight dedupe, same `serveBuffer` (immutable caching + Range).
- `loadAttachment(key, ...)` currently hardcodes `bridge.getAttachment`. Generalize to
  take a fetcher thunk so both routes share the cache and the dedupe.
- Cache keys: previews get a `prev:` prefix. Message ids are UUIDs and contain no `:`,
  so this cannot collide with the existing unprefixed `messageId:index` keys — the
  attachment keys stay untouched, keeping the diff small and existing etags valid.

### 3. Send — `src/page-api.js`

The preview object holds a `Uint8Array`. Returning it over CDP would JSON-serialize the
bytes into an integer-keyed object and ship them out and back for no reason, so **the
grab and the send happen in the same in-page call** — the bytes never leave the renderer.

`sendText(id, body, bodyRanges, opts)` with `opts.linkPreview`:

1. Bail to a bare send unless `items.linkPreviews` is on. The setting is the user's
   decision about whether their machine fetches links; we never override it, and we
   never fetch anything ourselves.
2. Read the slot first. If it already holds a preview whose url appears in `body`, use it
   with **zero wait** — the common case, because the composer warms it while you type.
3. Otherwise fire `debouncedMaybeGrabLinkPreview` and poll the slot up to `timeoutMs`
   (default 5000), then use whatever arrived — or nothing.
4. Pass it as `preview: [obj]` into the same `enqueueMessageForSend`.

Warming is a separate `warmLinkPreview(text)` on `__sb`, called debounced from the
composer's `input` handler, so by send time the slot is hot and the send has no added
latency. If warming never happened, step 3 still covers it.

`sendMedia` keeps `preview: []` — Signal doesn't put a link card on a message that
carries attachments.

**Hazard to document:** `linkPreviews` is one *global* redux slot, not per-composer. If
the user is typing a link into Signal Desktop's own window at the same instant we warm,
whichever fires last wins and the other window briefly shows the wrong preview. Low
probability, self-healing on the next keystroke there, but it goes in a comment.

### 4. Send — `src/server.js` + `src/bridge.js`

- `bridge.sendText(id, body, bodyRanges, opts)` and `bridge.warmLinkPreview(text)`.
- `POST /api/conversations/:id/send` passes `linkPreview: true` for text-only sends.
- `POST /api/link-preview/warm { text }` — fire-and-forget, returns `{ok}`.

### 5. Frontend — `public/app.js`, `public/ui-logic.js`, `public/style.css`

`previewEl(msg)` appended inside the bubble after the text: left accent bar, domain,
title, description, hero image below (`/api/previews/:mid/0`, `loading="lazy"`, sized
from the probed width/height so it doesn't reflow). Built with `createElement` like
everything else — title/description/url are attacker-influenced.

New pure helpers in `ui-logic.js` (so `npm test` reaches them):

- `safeHttpUrl(url)` — **required**: the href comes off a received message, so anything
  that isn't `http:`/`https:` renders as a non-clickable card rather than a live
  `javascript:` URL.
- `previewDomain(url)` — hostname, `www.` stripped.
- `hasLink(text)` — cheap gate so the composer only warms when there's a URL to warm.

`jumboSizeFor` gains a `msg.preview` veto. Signal's own predicate already lists link
previews; CLAUDE.md currently says there's nothing to veto on because we don't render
them — that stops being true here, and the note needs updating with it.

## Verification

- `npm test` for the four pure helpers + the new jumbo veto.
- Manual, **Note to Self only**: send a link → card appears, image loads, no console
  errors. Confirm an incoming message with an existing preview renders. Confirm a link
  sent with the Signal setting off goes out bare and nothing is fetched.
- Confirm `enqueueMessageForSend` really does accept the hydrated preview (encrypts +
  uploads the image) rather than silently dropping it — this is the one genuinely
  unverified assumption in the design.

## Out of scope

- Linkifying URLs in message *text* (the card is clickable; the text isn't). Follow-up card.
- A composer-side staged preview with a remove "x" (Signal/Discord show one). The card
  appears on the sent message; the SSE repaint brings it in near-instantly.
- Previews on edited messages, media messages, and the GIF path.
- Sticker-pack and call-link previews (`isStickerPack` / `isCallLink`), which Signal
  renders as their own special cards.
