# Quoted replies — visual representation

Card `532ac7e6` — "When people reply to messages, this should be visually represented".

## Context

Signal messages can carry a `quote`: the message-being-replied-to, copied onto the reply. This UI currently drops it entirely — a reply renders as a bare bubble with no hint of what it answers, so threads read as non-sequiturs. The card's screenshot shows what's wanted: a quote box above the reply's text with the original author's name, the quoted text, and a coloured left bar.

Probed on the running Signal (8.23.0) — `message.quote` is:

```
{ id: 1785935783147,          // sent_at of the referenced message
  authorAci: '<uuid>',
  text: 'the quoted body',    // may be empty for an attachment-only original
  attachments: [{ contentType, fileName, thumbnail: {path, localKey, version, size, w, h, ...} }],
  bodyRanges: [],             // same style ranges as a body
  referencedMessageNotFound: false, isGiftBadge: false, isViewOnce: false }
```

The thumbnail is an ordinary v2 encrypted attachment (`path` + `localKey`), i.e. exactly what `fetchDecrypted()` already handles for attachments and link-preview images. `isMe` is **not** an attribute on the author's conversation model (probed: `conv.isMe` and `conv.get('isMe')` are both undefined) — it comes from the redux `conversationLookup` entry, or from `ConversationController.getOurConversationId()`.

## Design

**src/page-api.js**
- `resolveAuthor(serviceIdOrId)` → `{ title, isMe }`; `resolveAuthorTitle` becomes a thin wrapper so mentions keep working unchanged.
- `describeQuote(q)` → `{ id, authorId, authorTitle, isMe, text, bodyRanges, attachment: {kind, contentType, fileName, hasThumbnail}|null, referencedMessageNotFound, isViewOnce, isGiftBadge }`. Text + ranges go through the existing `formatBody()` so a quoted message with mentions/formatting is aligned the same way a body is.
- `formatMessage` gains `quote: describeQuote(m.quote)`.
- `getQuoteThumbnail(messageId)` — `fetchDecrypted(m.quote.attachments[0].thumbnail)`. Same decrypt path as `getAttachment`/`getPreviewImage`.

**src/bridge.js** — `getQuoteThumbnail(messageId)`.

**src/server.js** — `GET /api/quote-thumbnails/:messageId`, reusing `loadMedia` + the byte cache under key `quote:<messageId>` (message ids are UUIDs, so the prefix can't collide, same argument as `prev:`).

**public/ui-logic.js** (pure, tested)
- `quoteSummary(quote)` → `{ author, text, placeholder }`: `'You'` vs the author title; the text to show, falling back through *Original message not found* / *View-once media* / *Photo* / *Video* / *Voice message* / *Audio* / file name / *Attachment*; `placeholder: true` when that text is a description rather than the real body (rendered dim/italic, and never with `bodyRanges`).
- `jumboSizeFor` gains the quote veto — Signal's own jumbomoji predicate refuses a message carrying a quote, and this UI now has one to veto on (the comment there says so already).

**public/app.js** — `quoteEl(msg)` builds the box (`createElement` only; text is attacker-influenced), inserted as the bubble's first child, above attachments/text. Real body text renders through `renderFormatted` with the quote's own ranges. The thumbnail is a fixed 40×40 box so late-arriving bytes never reflow the thread (the "load older" anchor depends on that).

**public/style.css** — `.quote` box: left bar coloured with `colorFor(authorId)` (the same palette as group author labels), dim background, author line, two-line-clamped text, square thumbnail.

**CLAUDE.md** — a "Quoted replies" bullet in the operations list, the new route in the file map notes, and the jumbomoji bullet's "this UI doesn't render quotes" aside corrected.

## Design — composing a reply

Probed too: `enqueueMessageForSend` takes a `quote` and stores it **verbatim** on the message (`quote: l` straight into the attributes in Signal 8.23's bundle), so what we pass must be the same stored shape we read back. The redux composer route (`composer.setQuoteByMessageId`) is *not* usable — probed against Note to Self, it left `composer.conversations[id]` with no `quotedMessage` at all, i.e. it is coupled to the conversation being open/selected in Signal's own window, exactly like `processAttachments` (see CLAUDE.md). So we build the quote ourselves, the same way `sendMedia` hands Signal in-memory attachments.

- **src/page-api.js** — `buildQuote(conversationId, messageId)` from the referenced message in redux: `{ id: sent_at, authorAci, text, bodyRanges, attachments: [{contentType, fileName}], isViewOnce, isGiftBadge, referencedMessageNotFound: false }`. `sendText`/`sendMedia` take `opts.quoteMessageId`. ⚠️ Signal's own `makeQuote` also copies the original attachment's **thumbnail**; that needs attachment-copy helpers current Signal no longer exposes, so an outgoing reply to a photo carries the attachment's type/name but no thumbnail — recipients see the type label. Noted as a follow-up.
- **src/server.js** — the send + send-gif routes accept `quoteMessageId` (a string id, validated for shape only; the real check is in-page, which returns `quote-message-not-loaded` / `quote-wrong-conversation`).
- **public/ui-logic.js** — `menuActionsFor` gains `'reply'`, first, for any non-tombstone message.
- **public/app.js / index.html / style.css** — a `#replyBanner` above the composer showing who and what you're replying to with an × (Escape cancels, like edit mode); `state.replyTo`; the optimistic echo carries the quote so the reply shows its box immediately; starting an edit cancels a reply and vice versa; switching chats clears it.

## Tests / Verification

- `npm test` — new `quoteSummary` cases (own vs other author, missing original, attachment-only fallbacks, view-once, placeholder flag) and `jumboSizeFor` refusing a quoted emoji-only message.
- Manual: open a thread that contains real quoted replies (text quote, photo quote, quote of a message from me) and confirm the box renders with author, text and thumbnail, no console errors; send a reply *from Signal Desktop* into **Note to Self** quoting an earlier message and confirm it appears in the web UI over SSE.

## Out of scope (follow-up cards)

- Click-a-quote-to-jump-to-the-original scrolling/highlight.
- A **thumbnail on an outgoing** reply to a photo (needs Signal's attachment-copy helpers; see above).
