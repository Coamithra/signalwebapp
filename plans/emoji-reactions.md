# Emoji reactions from the message menu

Card `2ee38787` — *"in message options, allow me to react with an emoji"*. Branch `feat/emoji-reactions`.

## Context

Reactions are already **read** end to end: `formatMessage` in [src/page-api.js](../src/page-api.js) maps `m.reactions` to `{ emoji, from }`, and [public/app.js](../public/app.js) renders them as `.reaction-pill`s under the bubble. There is no way to *send* one — the hover "⋯" menu offers only Edit / Delete for everyone / Delete for me.

## What was probed (Signal 8.23.0, live CDP)

- The send path is **`window.reduxActions.composer.reactToMessage(messageId, { emoji, remove })`** → `enqueueReactionForSend({ messageId, emoji, remove })`. There is no `reactToMessage` on the conversation model or on `reduxActions.conversations`; the composer thunk is the path (same shape as `sendEditedMessage`).
- **Verified to work headlessly**, with the conversation not open in Signal's own window — reacted 👍 to a Note-to-Self message and removed it again.
- The thunk **catches its own errors** and dispatches a `ReactionFailed` toast instead of throwing — same trap as `deleteMessagesForEveryone`. But unlike that one it `await`s the send *inside* the try, so the returned promise resolves only after either the success dispatch or the toast. **One toast check after the await is exact**; no polling loop needed.
- `reaction.fromId` is a **conversationId**, not a serviceId — so "is this mine" is `fromId === state.user.ourConversationId`. (`ConversationController.get` accepts either, which is why `resolveAuthorTitle` already works on it.)
- **A pending removal appears as a reaction entry with no `emoji` field**, sitting alongside the old one until the send settles. `formatMessage` maps `m.reactions` without filtering, so today that would render an empty pill. Must be filtered.
- The user's quick-reaction row is `reduxStore.getState().items.preferredReactionEmoji` (synced from the account record; `['❤️','👍','👎','😂','😮','😢']` by default).
- Signal's own `canReact` predicate: not `deletedForEveryone`, conversation accepted/not blocked/not terminated, not SMS; **outgoing messages additionally require the send to have reached someone** (an unsent/errored message can't be reacted to). Incoming is always allowed. View-once is *not* excluded.
- ⚠️ **A reaction change does NOT fire our SSE `messages` event.** It replaces `conversations.messagesLookup[id]` but leaves `messagesByConversation` untouched, and the in-page subscriber only diffs the latter. Confirmed by reference comparison before/after. So reactions arriving from other people (or from Signal Desktop itself) never repaint the thread — a **pre-existing** gap, since reactions already render today. Out of scope here; follow-up card. Our own reaction repaints via an explicit refresh.

## Design

### [src/page-api.js](../src/page-api.js)

- `formatMessage` — **filter reactions to those that actually carry an `emoji`** (drops the pending-removal tombstone above), and add `fromMe: r.fromId === ourConversationId`, read once from `s.user.ourConversationId`.
- New **`sendReaction(conversationId, messageId, emoji, remove)`**: resolve the conversation (`conversation-not-found` if absent), snapshot the current toast, dispatch `composer.reactToMessage`, `await` it, then check for a *new* `ReactionFailed` toast → `{ ok: false, error: 'reaction-failed' }`. Otherwise `{ ok: true }`.
- `ping()` gains **`preferredReactions`** from `items.preferredReactionEmoji` (falling back to `[]`), so the picker offers the same six emoji Signal does.

### [src/bridge.js](../src/bridge.js)

- `sendReaction(conversationId, messageId, emoji, remove)` → `this._call('sendReaction', …)`.

### [src/server.js](../src/server.js)

- **`POST /api/conversations/:id/messages/:messageId/react`** with `{ emoji, remove? }`, alongside the existing `/edit` and `/delete` routes.
- `validReactionEmoji(s)` — the same discipline as `sanitizeBodyRanges` ("it goes straight into Signal"): the value must be **exactly one emoji**, `/^(?:\p{RGI_Emoji}|\p{Extended_Pictographic})$/v`. That accepts ZWJ families, flags, keycaps and skin tones as one grapheme and bare pre-VS16 forms (`❤`), and rejects `''`, `'1'`, `'abc'`, `'👍👍'` and anything with whitespace. Bad input → 400 `invalid-emoji`.
- `/api/status` forwards `preferredReactions` from `ping`.

### [public/ui-logic.js](../public/ui-logic.js) (DOM-free, unit-tested)

- `canReactTo(msg)` — Signal's eligibility clause, needed in two places (the menu entry and the now-clickable pills): not `deletedForEveryone`, and for `direction === 'outgoing'` only once `status` is neither `'sending'` nor `'error'` (Signal requires the send to have reached someone). Incoming is always allowed.
- `menuActionsFor` gains **`'react'` first** (Signal puts it at the top), gated on `canReactTo`.
- `myReaction(msg)` → the emoji I have already reacted with, or `null`.
- `groupReactions(reactions)` → the pill list, moved out of `app.js` so it can be tested: groups by emoji, keeps deduped reactor names for the tooltip, drops emoji-less entries (defence in depth against the tombstone above), and flags the group as `mine` when one of its reactions is mine.
- `reactionChoices(preferred, mine)` → the picker's quick row: the preferred emoji, deduped, with my current reaction appended if it isn't already there (so it can always be toggled off), and a built-in default row when the server gave us nothing.

### [public/app.js](../public/app.js)

- `MENU_ACTIONS.react` → opens a **reaction picker** popup anchored on the "⋯" button.
- The popup (`.react-pop`): a row of quick-reaction buttons from `reactionChoices`, my current one marked `.on` (clicking it sends `remove: true`), plus a search input that reuses the composer's existing **`matchShortcodes` + `emojiFreq()`** ranking to reach any of the ~1900 shortcodes. Picking bumps the same `sb.emojiFreq` counts as the composer, so the two learn one set of favourites.
- The anchor-and-dismiss wiring in `openMessageMenu` (position under the button, flip above on overflow, close on outside-click / Escape / thread scroll) is factored into **`openAnchoredPopup(node, anchorEl)`** and used by both, so the two popups behave identically.
- `sendReaction(msg, emoji, remove)` POSTs, then `scheduleRefreshActive()` — the same repaint-from-server-truth pattern `doDelete` uses. Failure → `toast(...)`.
- **Reaction pills become buttons.** Signal allows exactly one reaction per person, so the two gestures fall out of that: clicking the pill that is already `.mine` **removes** your reaction (`remove: true`), and clicking any other pill **changes** yours to that emoji — the count moves rather than a second reaction appearing. `aria-pressed` carries the `mine` state; the existing `title` keeps listing who reacted. Gated on the same `canReactTo` rule as the menu entry, so a pill on a message you can't react to renders as the old inert span.
- Boot's `/api/status` probe stores `state.preferredReactions`.

### [public/style.css](../public/style.css)

`.react-pop` and its rows/search field, in the existing `.msg-menu` / `.emoji-pop` idiom; a `.reaction-pill.mine` accent.

### [CLAUDE.md](../CLAUDE.md)

A "**React to a message**" bullet in *How the core operations work* recording the probed contract: the composer thunk, the swallowed error + toast, the `fromId`-is-a-conversationId detail, the emoji-less pending-removal entry, and the SSE gap.

## Verification

- `npm test` — new cases for `menuActionsFor`'s react rules, `myReaction`, `groupReactions` (grouping, dedupe, `mine`, tombstone filtering) and `reactionChoices`; the existing `menuActionsFor` assertions get `'react'` threaded through.
- `node -e "import('./src/page-api.js').then(m=>new Function(m.INSTALL_SCRIPT))"` — the template-literal parse guard.
- Manual, against **Note to Self** only: react from the menu, confirm the pill appears and shows in Signal Desktop; pick a different emoji (replaces); click my own emoji again (removes); confirm no console errors.

## Out of scope

- **Live updates for reactions from other people** — the SSE subscriber only diffs `messagesByConversation`. Pre-existing; follow-up card.
- Clicking a reaction pill to toggle or to open a "who reacted" viewer.
- Editing the preferred-reaction row (that's a Signal setting).
- Reacting to stories.
