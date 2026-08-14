# Autoplay short videos and GIFs while on screen

Trello card `e81b2267` — "Autoplay short videos and GIFs while on screen".

## Context

A 3-second clip in a thread currently renders as a paused `<video controls>` with a poster. Clicking play on something that lasts less time than the click takes is friction — Signal itself, and every other chat client, just loops short motion. The card asks for: autoplay muted+looping while the clip is on screen, pause when it scrolls off, leave longer videos alone.

## What the attachment actually is

Two distinct cases, and only one of them is ours to drive (the card flags this):

- **`kind: 'video'`** (`video/mp4` — including everything the `/gif` picker sends, since Giphy media goes out as mp4 through `sendMedia`) → a real `<video>` element. This is the whole feature.
- **`kind: 'image'` with `contentType: 'image/gif'`** → an `<img>`. A browser animates an animated GIF on its own and offers no API to pause it. Nothing to start, nothing to stop; it is already "autoplaying". Out of scope by physics, not by choice.

`describeAttachment` in [src/page-api.js](../src/page-api.js) already sends `kind` and `contentType` to the frontend, so no server/bridge/page-api change is needed anywhere in this card.

## Design

### `public/ui-logic.js` — the decision

```js
export const AUTOPLAY_MAX_SECONDS = 15;
export function shouldAutoplayClip(att, duration, reducedMotion)
```

True only when: not `reducedMotion`, `att.kind === 'video'`, and `duration` is a finite number `> 0` and `<= AUTOPLAY_MAX_SECONDS`. `NaN` (metadata not in yet) and `Infinity` (unknown/streamed length) both fall through to `false` — the ordinary controls path — so an unreadable duration degrades to today's behaviour rather than to a clip that loops forever.

Pure and DOM-free, so `npm test` reaches it; the threshold constant lives with it.

### `public/app.js` — the plumbing

1. **`attachmentEl`'s video branch** gains `playsinline` and a one-shot `loadedmetadata` listener. Duration is not known when the row is built, so the decision cannot happen there.
2. **`maybeAutoplayClip(v, att)`** — on `loadedmetadata`, ask `shouldAutoplayClip(att, v.duration, reducedMotion.matches)`. If yes: `v.muted = true` (property, not attribute — the attribute alone is unreliable for Chrome's autoplay gate), `v.loop = true`, drop `controls`, add an `.att-clip` class, and hand the element to the observer. If no, the element is exactly what it is today.
3. **One shared `IntersectionObserver`** at module scope, created lazily, threshold `0.4`. Intersecting → `v.play().catch(() => {})` (the promise rejects when a pause interrupts it; that is not an error). Not intersecting → `v.pause()`. `renderMessages` rebuilds every row on each refresh, so the first thing the callback does is `if (!entry.target.isConnected) unobserve(...)` — removal from the DOM fires the callback with ratio 0, which is what keeps the observer from pinning detached `<video>` nodes forever.
4. **Click releases the clip to manual control** — one click: unobserve, pause, restore `controls`, drop the sound button. From there it behaves like any other video. One-shot, no toggling state machine.
5. **A sound toggle in the corner of the clip** — the Twitter/Instagram affordance. Autoplay is *always* muted (browsers block it otherwise, and it would be obnoxious); a small round 🔇/🔊 button sits bottom-right, fades in on hover (and is permanently visible once sound is on, so you can see that it is), and toggles `v.muted` in place without disturbing playback. Shown for every autoplaying clip: whether a video carries an audio track cannot be answered reliably before it plays (`webkitAudioDecodedByteCount` reads 0 while muted), and hiding the control on a clip that *does* have sound is a far worse failure than offering it on a silent one. If the observer's `play()` is later rejected because the clip is unmuted (Chrome's autoplay policy), it re-mutes, syncs the button, and retries once — sound is never the reason a clip stops looping.
6. **`prefers-reduced-motion`** is read via `matchMedia` at decision time, so the answer is current for every newly rendered row without a reload. Clips already playing when the OS setting changes are not retroactively stopped (they stop on the next thread refresh) — noted, not handled.

`clipSoundIcon(muted)` (glyph + label) joins the pure half in `ui-logic.js`; `app.js` only paints it.

### `public/style.css`

`.att-clip` gets `cursor: pointer`, its wrap gets `position: relative; width: fit-content` (so the overlay hugs the video rather than the bubble), and `.att-clip-sound` is the round button — hidden at `opacity: 0` until hover/focus, forced visible when unmuted and on touch devices, which have no hover. We never swap the element, only enable playback on the `<video>` that was already there, so the poster hands off to the first decoded frame with no flash and no layout shift; `mediaBox()` has already reserved the pixel box.

## Tests / verification

- `npm test` — new cases for `shouldAutoplayClip`: under/at/over the threshold, `NaN`, `Infinity`, `0`, negative, non-video kinds (`image`/`audio`/`voice`/`file`), and `reducedMotion` vetoing an otherwise-eligible clip; plus `clipSoundIcon` both ways.
- Hands-on against **Note to Self**: send a short clip (< 15s) and a long one; confirm the short one loops silently on screen, pauses when scrolled out of view, resumes on the way back, that the sound button appears on hover and actually unmutes, and that a click on the clip itself gives it controls back; confirm the long one still renders exactly as before with its poster and controls. Confirm an `image/gif` attachment is untouched. Console clean throughout.

## Out of scope

- Pausing real `image/gif` attachments (no browser API for it) — including under reduced motion.
- Autoplay in the GIF picker grid or the composer's pending-attachment tray.
- Any "GIF" badge / duration overlay on the clip.
- Persisting per-clip play state across a thread refresh (rows are rebuilt wholesale).
