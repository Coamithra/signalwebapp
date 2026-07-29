# Emoji shortcode autocomplete popup (card 00aca03d)

## Context

Today `:shrug:` only becomes 🤷 once you type the closing colon (`expandShortcodeAtCaret`
in [public/app.js](../public/app.js), backed by `shortcodeBefore` in
[public/format.js](../public/format.js)). While you're typing `:shr` there's no
suggestion list, so you must already know Signal's exact name — and some are
unguessable (`:+1:` for 👍, `:thumbsup:`, `:hand_with_index_finger_and_thumb_crossed:`).

Add a small autocomplete popup above the composer that lists matching shortcodes as
you type.

## Design

All frontend, no server/bridge/Signal-internals change. The map
(`EMOJI_SHORTCODES`, 1916 entries) is already loaded by `format.js`.

### `public/format.js` — one new export

`matchShortcodes(prefix, limit = 8, weights)` → `[{ name, emoji }]`.

- Lazily builds a sorted `Object.keys(EMOJI_SHORTCODES)` array on first call (module-level
  cache) so typing doesn't re-key a 1916-entry object every keystroke.
- Ranking tiers: exact match, then prefix matches, then substring matches. Substring
  matters — `:up` has to find `thumbs_up`.
- **Within a tier**, higher `weights[name]` (your own usage count) wins, then shorter
  name, then alphabetical. Tier stays primary so a prefix match is never buried under a
  frequently-used substring match — the list stays predictable.
- **Hard cap of 8** (no scrolling): type another char to narrow.
- Case-insensitive; goes through the existing `emojiFor` (`Object.hasOwn`) guard so
  `__proto__`/`constructor` can never leak a function source into the list.

### Frequency cache

`public/app.js` keeps a `{ name: count }` map in `localStorage` under `sb.emojiFreq`,
incremented every time you pick from the popup (not on plain `:shrug:` typing — the popup
is what needs the ordering help). Pruned to the top 200 names on write so it can't grow
unbounded, and every read is defensively parsed (corrupt/absent JSON → `{}`), since
localStorage is user-editable. Passed straight into `matchShortcodes` as `weights`.

Also a `shortcodeQueryBefore(text, caret)` helper (sibling of the existing
`shortcodeBefore`): returns `{ query, start }` for an **open** `:foo` run ending at the
caret, or `null`. Guards, mirroring the existing ones:

- 2+ chars of `[a-z0-9_+-]` after the `:` (card's rule).
- The `:` must not be preceded by a word char or a `\` — kills `http://x`, `12:30`,
  `\:shrug`.
- No whitespace/`:` inside the run (the regex charset already enforces that).

### `public/app.js` — the popup

A single module-level controller near the existing shortcode code:

- **Element**: `#emojiPop`, created lazily and appended to `.composer` (which gets
  `position: relative`), positioned above the input like `.thread-menu-pop` does for
  the header menu. Built with `el()`/`createElement` per the repo's no-`innerHTML` rule.
- **Rows**: `<button class="emoji-pop-item">` with the emoji, `:name:`, and an
  `aria-selected` state; the active row scrolls into view.
- **Update** on the existing composer `input` listener (after `expandShortcodeAtCaret`,
  so a just-closed `:shrug:` expands and the popup hides rather than showing) plus on
  `click`/`keyup` caret moves — if `shortcodeQueryBefore` returns null or there are no
  matches, hide.
- **Keys**, handled at the *top* of the existing composer `keydown` listener so they win
  over Enter→send and ↑→quick-edit, and only while the popup is open:
  `ArrowDown`/`ArrowUp` move (wrapping), `Enter`/`Tab` pick, `Escape` dismiss (and
  `preventDefault` so it doesn't also cancel edit mode). Enter picking while the popup is
  open matches Slack/Discord/GitHub; Escape first if you meant the text literally.
- **Pick** inserts `emoji` over `[start, caret)` with `setRangeText(..., 'end')` — same
  in-place edit `expandShortcodeAtCaret` uses, so Ctrl+Z still steps back.
- **Hide** on blur (via `mousedown` on a row being prevented so the click lands first),
  on send, on `cancelEdit`/`startEdit`, and when the GIF picker opens.
- Never fires mid-IME composition (`e.isComposing`), same as the existing expansion.

### `public/style.css`

`.composer { position: relative }` + `.emoji-pop` / `.emoji-pop-item` styles cloned from
the `.thread-menu-pop` / `.menu-item` look (same border, radius, shadow, hover), capped
at ~8 rows with `overflow-y: auto`.

### `CLAUDE.md`

Extend the "Text formatting … + emoji shortcodes" bullet with one sentence on the
autocomplete and the two new `format.js` exports.

## Verification

`npm start` with Signal running; browser check (no console errors):

1. Type `:shr` → popup lists `shrimp`, `shrug`. `↓`/`↑` move, `Enter` inserts 🤷.
2. `:up` → `thumbs_up` etc. appear (substring path).
3. `Tab` picks; `Escape` dismisses and Enter then sends normally.
4. Click a row with the mouse → inserts.
5. Negative: `http://x`, `12:30`, `\:shrug`, `:x` (1 char) → no popup.
6. Typing the full `:shrug:` still expands via the old path and the popup is gone.
7. `↑` on an empty composer still quick-edits (popup closed → old handler wins).
8. Pick `:shrug:` a few times, then type `:shr` again — it should now outrank `shrimp`
   (and survive a page reload, since the weights are in localStorage).
9. Send one `:shrug:`-picked message to **Note to Self**.

## Out of scope

- An emoji *picker* button / grid (this is keyboard shortcode completion only).
- Skin-tone variants, fuzzy matching.
- Syncing the frequency cache across browsers/devices (it's per-browser localStorage).
- Autocomplete in the message-edit box beyond what it gets for free (it's the same
  composer textarea, so it works there too — just not separately designed for).
