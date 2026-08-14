# Clickable links in message bodies

Card: `69d79f50` — "Make links in message bodies clickable".

## Context

URLs in a received or sent message render as plain text: `renderFormatted` in [public/format.js](../public/format.js) turns Signal's `{ text, bodyRanges }` into DOM and builds no anchors at all. `safeHttpUrl` (in [public/ui-logic.js](../public/ui-logic.js)) already exists as the scheme gate, but only the link-*preview* card in `app.js` uses it. Reading a link out of a thread means selecting and copying it by hand.

## Design

All of it lands in `public/format.js`, in the rendering half. `app.js` is untouched.

### 1. Detection — `linkSpans(text)` (new export)

Returns `[{ start, length, href }]` over the plain body, in order, non-overlapping. Named `linkSpans` rather than `findLinks` so it can't be confused with Signal's own linkify `findLinks` (quoted in CLAUDE.md), and it is deliberately **not** `hasLink` from `ui-logic.js` — that one is the *preview* gate and is https-only on purpose (Signal's `shouldPreviewHref`). Clickability has no such constraint.

One regex, three alternatives:

- `https?://…` — an explicit scheme, http included.
- `www.…` — enough on its own, no TLD check.
- a bare host `example.com/path` — only when the last label is in a **curated TLD list**. Without a TLD list every `reboot.sh`, `README.md` and `v1.2.3` would become a link, and we have no dependency budget for the full IANA table. The list is the common generic TLDs plus the big ccTLDs, minus anything that reads as an English word after a dot (`.it`, `.in`, `.at`, `.be`, `.no`, `.us`), because chat is full of missing-space typos like "sure.it works". An exotic TLD needs an explicit scheme.

Then, per match:

- **preceding-character guard** — a match preceded by a word char, `@`, `.`, `-`, `/`, `:` or `\` is dropped, so `foo@example.com` (email), `mailto:example.com` and `C:\Users\thing.com` produce nothing.
- **trailing punctuation trim** — `.,;:!?…"'` is stripped, and a trailing `)`/`]`/`}` only when it doesn't balance an opener inside the match (so a Wikipedia `…_(disambiguation)` URL survives but `(see https://x.com)` doesn't eat the paren).
- **href** — the match verbatim when it carries a scheme, else `https://` + match (Signal's own linkify defaults to `http://`; https is the better default now and nearly everything redirects). Every href goes through **`safeHttpUrl`**, so `javascript:` and friends can never produce an anchor.

### 2. Composition with `bodyRanges` — no second pass

Linkification joins the **existing range walk** rather than post-processing finished text, so formatting is never lost and an anchor is never split in half:

- Any style range that **crosses** a link boundary (starts outside and ends inside, or vice versa) is **split at that boundary** first. Ranges that contain a link, sit inside one, or are disjoint are left alone.
- Link spans are then merged into the same sorted array (`start` asc, `length` desc) and `buildNodes` nests them like any other range.

After the split, every style is either disjoint from a link, inside it, or around it — so containment always holds and `buildNodes` never has to clip an anchor. A half-bolded URL renders as one `<a>` with two `<strong>` inside it.

`styleEl` grows an anchor branch: `target="_blank"`, `rel="noopener noreferrer"` (matching the preview card in `app.js`), so a click never navigates the app tab away from the thread.

### 3. Spoilers — decided deliberately

- **Spoiler contains the link:** linkify it. The anchor lands inside `.spoiler-body`, which is `visibility: hidden` until revealed — and a `visibility: hidden` subtree takes no clicks and no focus. So the link is genuinely not clickable until revealed, and fully clickable after, with no extra code.
- **Spoiler only partly overlaps the link (or sits inside it):** **no anchor at all.** A link whose visible text is partly blacked out is a deception vector and there is no honest way to render it.

### 4. Styling

`.msg-text a { color: inherit; text-decoration: underline }` — inheriting keeps it readable on both the incoming and outgoing bubble backgrounds without a second colour token.

### Untouched

- **Jumbomoji**: link spans are computed inside `renderFormatted` and never enter `msg.bodyRanges`, so `jumboSizeFor`'s veto list is unaffected — and an emoji-only message has no links anyway. Covered by a test.
- The composer/parse half of `format.js`, `app.js`, the server, `page-api.js`.

## Tests / verification

`npm test`. `public/format.js` is DOM-free apart from `renderFormatted`, which had no tests, so [test/format.test.mjs](../test/format.test.mjs) gains a ~30-line fake `document` (createElement / createTextNode / createDocumentFragment + appendChild) and an HTML serializer, installed on `globalThis`.

- `linkSpans` unit tests: scheme'd, `www.`, bare domain, path/query, uppercase, trailing period, balanced parens, email, `mailto:`, Windows path, `reboot.sh` / `README.md` / `v1.2.3`, `javascript:`.
- `renderFormatted` structure tests: anchor attributes; link inside bold; bold crossing a link boundary (one anchor, two `<strong>`); spoiler containing a link; spoiler partly overlapping a link (no anchor); an unformatted, link-free body unchanged.

Hands-on against **Note to Self**: send a plain link, a link inside bold, a link inside a spoiler, and a bare domain; confirm each opens in a **new** tab and the app tab stays on the thread.

## Out of scope

- `mailto:` / `tel:` links, and @mention or phone-number linkification.
- IDN / unicode domains (they need an explicit scheme).
- Any change to the link-*preview* pipeline (`hasLink`, warming, `sendText`).
