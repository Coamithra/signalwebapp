// The DOM-free half of the frontend: decision logic lifted out of app.js so it
// can be unit-tested by `npm test` (node's runner, no jsdom, no dependency).
//
// Nothing here may touch a browser global — no `document`, no `window`, no
// `localStorage`, no `fetch`. Anything that needs one takes it as an argument
// (or, for storage, takes the raw string the caller read). app.js keeps the
// wiring; this file keeps the rules.

// ---------- avatars ----------
export const AVATAR_COLORS = [
  '#a84d4d', '#c46a2d', '#b89b2d', '#5e9e54', '#3f9c8f', '#3f7fae',
  '#4a6fd0', '#7059c4', '#9b53b8', '#b8527f', '#7a8a99', '#8a7250',
];

export function colorFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function initials(title) {
  const words = (title || '?').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

// ---------- conversation list ----------
export function previewText(conv) {
  if (conv.typing) return '…typing';
  if (conv.lastMessageDeleted) return 'This message was deleted';
  const t = conv.lastMessageText || '';
  return t || (conv.lastMessageStatus ? 'Attachment' : '');
}

// ---------- message menu ----------
// Which actions apply to a message. "Edit" is Signal's own edit path, so it's
// only for your own, still-live text messages; "Delete for everyone" only for
// your own (Signal's unsend); "Delete for me" (local) is always available.
// Tombstones/incoming get just the local delete. Returns action *names* —
// app.js maps them to labels and handlers, which is what keeps this testable.
//
// "Summarize in chat" leads, being the only non-destructive one, and is the one
// action that applies to messages you did NOT send — running the auto-TLDR
// pipeline over someone else's video is the whole reason it exists. It rides on
// `msg.youtube`, which the SERVER attaches (annotateYouTube in src/tldr.js), so
// the URL parser stays in one place instead of being shipped to the browser too.
// Once that video has a summary in this chat it becomes 'summarized', a disabled
// entry: an option that silently vanishes reads as a bug, where a greyed-out one
// answers the question the user was about to ask.
export function menuActionsFor(msg) {
  const actions = [];
  const isOut = msg.direction === 'outgoing';
  const hasText = !!(msg.text && msg.text.trim());
  // A tombstone has no body left to hold a link, so this is belt-and-braces —
  // but summarizing a message whose text is gone would be nonsense either way.
  if (msg.youtube && !msg.deletedForEveryone) {
    actions.push(msg.youtube.summarized ? 'summarized' : 'summarize');
  }
  if (isOut && hasText && !msg.deletedForEveryone && !msg.isViewOnce) actions.push('edit');
  if (isOut && !msg.deletedForEveryone) actions.push('deleteForEveryone');
  actions.push('deleteForMe');
  return actions;
}

// ---------- jumbomoji ----------
// A message that is *nothing but* emoji renders big and bubble-less, the way
// Signal Desktop (and Telegram) do it. The thresholds are Signal's own, read
// out of its bundle so the same message looks the same in both apps:
// getJumboEmojiCount() ignores whitespace, refuses any non-emoji character,
// and caps at 5 — beyond that it's an ordinary message.
export const JUMBO_MAX_EMOJI = 5;
const JUMBO_PX = { 1: 56, 2: 48, 3: 40, 4: 36, 5: 32 };

// Characters that are Extended_Pictographic but read as *typography*, not
// emoji, when written bare: © ® ™ ‼ ⁉. Without this, the message "™" would
// render at 56px. Their U+FE0F forms (™️) are real emoji and still match, via
// \p{RGI_Emoji} above them in the alternation.
const TEXT_SYMBOLS = '\\u00A9\\u00AE\\u2122\\u203C\\u2049';

// -> font-size in px for an emoji-only string, or null to render normally.
// `\p{RGI_Emoji}` (the `v` flag's set-of-strings property) is what makes this
// zero-dep and correct: it consumes a whole ZWJ family, flag, keycap or
// skin-toned emoji as ONE match, where a naive per-code-point scan would count
// 👨‍👩‍👧‍👦 as four. `\p{Extended_Pictographic}` is a second alternative only to
// catch the older bare forms RGI deliberately excludes (a `❤` with no U+FE0F,
// as some clients still send), minus the typographic ones above. A lone U+FE0F
// is skipped like whitespace: it survives copy-paste after RGI has already
// consumed the sequence it belonged to, and it isn't a glyph of its own.
export function jumbomojiSize(text) {
  if (typeof text !== 'string' || !text) return null;
  // Built per call: a /g/ regex carries `lastIndex` between calls.
  const token = new RegExp(`\\p{RGI_Emoji}|[\\p{Extended_Pictographic}--[${TEXT_SYMBOLS}]]|[\\s\\uFE0F]+`, 'gv');
  let pos = 0;
  let count = 0;
  let m;
  while ((m = token.exec(text))) {
    // A gap before this match is a character that is neither emoji nor space,
    // so the message is mixed text — bail rather than scan the rest.
    if (m.index !== pos) return null;
    pos = token.lastIndex;
    if (!/^[\s\uFE0F]/.test(m[0])) count++;
    if (count > JUMBO_MAX_EMOJI) return null;
  }
  if (pos !== text.length) return null; // trailing non-emoji
  return count ? JUMBO_PX[count] : null; // whitespace-only counts as nothing
}

// The veto, kept beside the sizing so both halves of the rule are testable and
// in one place. Signal refuses jumbomoji for a message carrying anything *other*
// than the emoji — media, a link preview, or formatting ranges (its own
// predicate also lists quotes, which this UI doesn't render into the bubble).
// bodyRanges matters most: a spoilered or monospaced emoji is an ordinary
// message in Signal, and blowing it up here would out-and-out break the spoiler.
export function jumboSizeFor(msg) {
  if (!msg) return null;
  if (msg.isViewOnce) return null;
  if ((msg.attachments || []).length) return null;
  if ((msg.preview || []).length) return null;
  if ((msg.bodyRanges || []).length) return null;
  return jumbomojiSize(msg.text);
}

// ---------- link preview cards ----------

// Cheap "is there anything here worth previewing" gate, so the composer only
// asks Signal to warm a preview when the text actually holds a link. Signal
// does the real link-finding itself; this only avoids pointless round-trips.
// **https only**, matching Signal's own shouldPreviewHref (see CLAUDE.md): it
// never previews an http:// link or a scheme-less one, so warming for either
// would fetch nothing and leave the send waiting out its poll for a preview
// that can't arrive.
export function hasLink(text) {
  return typeof text === 'string' && /https:\/\/\S/i.test(text);
}

// The card's href comes off a received message, i.e. is attacker-controlled.
// Anything that isn't plain http(s) — javascript:, data:, vbscript:, a
// protocol-relative //evil.com — returns null and the card renders unclickable.
// Returns the url unchanged when it's safe, so the caller can use it directly.
export function safeHttpUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null; // not absolute / not parseable -> never linkify
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null;
}

// Domain line at the top of the card. Stored previews carry no 'domain' field
// (only freshly-grabbed ones do), so it always comes from the url. Lowercased
// with 'www.' dropped, the way every other client shows it.
export function previewDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

// ---------- composer: pending attachments ----------
export function kindForType(ct) {
  if (/^image\//.test(ct)) return 'image';
  if (/^video\//.test(ct)) return 'video';
  if (/^audio\//.test(ct)) return 'audio';
  return 'file';
}

export function iconForKind(kind) {
  return kind === 'image' ? '🖼️' : kind === 'video' ? '🎬' : kind === 'audio' ? '🎵' : '📎';
}

// ---------- autoplaying short clips ----------
// Short motion in a thread should just play, the way it does in Signal itself.
// Over this many seconds it's a video you chose to watch, not a clip you glanced
// at, and it keeps its ordinary controls.
export const AUTOPLAY_MAX_SECONDS = 15;

// Should this attachment loop silently while it's on screen?
//
// Only a <video> can be driven: an animated image/gif is an <img> that the
// browser animates by itself with no API to start or stop it, so it is already
// "autoplaying" and there is nothing here to decide — hence the kind check
// before anything else. (Everything the /gif picker sends is video/mp4, so it
// lands on this path, not that one.)
//
// `duration` only exists once 'loadedmetadata' has fired, and even then it can
// be NaN or Infinity for a length the browser can't work out. Both fall through
// to false — an unreadable duration degrades to today's play button, never to a
// clip that turns out to be twenty minutes long and loops forever.
export function shouldAutoplayClip(att, duration, reducedMotion) {
  if (reducedMotion) return false;              // the OS asked for less motion; honour it
  if (!att || att.kind !== 'video') return false;
  return Number.isFinite(duration) && duration > 0 && duration <= AUTOPLAY_MAX_SECONDS;
}

// The corner sound toggle on a playing clip. Autoplay is always muted, so this
// is the only way to hear a short video that does carry audio.
export function clipSoundIcon(muted) {
  return muted
    ? { glyph: '🔇', label: 'Unmute' }
    : { glyph: '🔊', label: 'Mute' };
}

// ---------- emoji pick frequency ----------
// Picks are counted so a hard-capped list of 8 stays useful: substring matching
// means ":up" has ~40 candidates, and the ones you actually use should be in
// them. Per-browser and best-effort — localStorage can be full, disabled, or
// hand-edited, so every read is defensive and every write can fail silently.
//
// Counts are keyed by the EMOJI, not by the shortcode that produced it: one
// glyph answers to several names (:hankey:/:poop:/:shit:) plus its synonyms,
// and the row a match is listed under changes with the query, so name-keyed
// picks would split across spellings and never accumulate.
//
// Counts DECAY: every EMOJI_FREQ_HALFLIFE picks, every score is halved. A
// phase you go through fades out on its own over the next couple of hundred
// picks instead of ranking forever, while something you still use keeps
// re-earning its place. Scores are fractional after a decay — that's fine,
// they're only ever compared to each other.
export const EMOJI_FREQ_MAX = 200;       // bounded: this is a ranking hint, not a history
export const EMOJI_FREQ_HALFLIFE = 60;   // picks between halvings
export const EMOJI_FREQ_FLOOR = 0.05;    // decayed below this -> forgotten entirely

// Raw stored JSON (or null/'' when there's nothing stored) -> the frequency
// state. Takes the string rather than reading storage itself, so this stays
// browser-free; anything malformed — bad JSON, an array, a hand-edited value —
// degrades to the empty state rather than throwing at the caller.
//
// `emojiForName` (optional) migrates counts written before the switch to
// emoji keys: any key it resolves is re-keyed to that emoji, summing the ones
// that collide (:hankey: 3 + :poop: 2 -> 💩 5). It needs no version flag and is
// safe to re-run — no emoji is itself a shortcode, so a migrated key never
// resolves a second time. Keys it can't resolve (already-emoji ones, and any
// stale hand-edited name) are left alone; they rank nothing and age out through
// the usual decay. `migrated` says whether anything actually moved, so the
// caller can write the converted state back once instead of every load.
// -> { counts: {emoji: score}, picks: number-since-last-decay, migrated }
export function parseEmojiFreq(rawJson, emojiForName) {
  try {
    const raw = JSON.parse(rawJson || '{}');
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.counts : null;
    const counts = Object.create(null);
    let migrated = false;
    if (src && typeof src === 'object' && !Array.isArray(src)) {
      for (const [k, v] of Object.entries(src)) {
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue;
        const resolved = emojiForName ? emojiForName(k) : undefined;
        // A non-string means the lookup walked its prototype chain rather than
        // resolving a shortcode ("toString" -> a function); key on the original.
        const emoji = typeof resolved === 'string' && resolved ? resolved : undefined;
        const key = emoji || k;
        if (emoji) migrated = true;
        counts[key] = (counts[key] || 0) + v;
      }
    }
    const picks = Number.isFinite(raw?.picks) && raw.picks >= 0 ? raw.picks : 0;
    return { counts, picks, migrated };
  } catch { return { counts: Object.create(null), picks: 0, migrated: false }; }
}

// Record a pick: bump the emoji, decay everything on the halflife boundary, and
// return the snapshot to persist (capped to the top EMOJI_FREQ_MAX).
//
// Split responsibility, so read this before adding a caller: `freq.counts` IS
// mutated in place — it's the live ranking the popup reads, so a new score has
// to show up without a reload — but `freq.picks` is NOT. The new pick count
// comes back on the snapshot only, and a caller that wants the decay to keep
// advancing within a session has to write it back itself.
export function nextEmojiFreq(freq, emoji) {
  const counts = freq.counts;
  counts[emoji] = (counts[emoji] || 0) + 1;

  let picks = freq.picks + 1;
  if (picks >= EMOJI_FREQ_HALFLIFE) {
    picks = 0;
    for (const k of Object.keys(counts)) {
      const decayed = counts[k] / 2;
      if (decayed < EMOJI_FREQ_FLOOR) delete counts[k]; else counts[k] = decayed;
    }
  }

  const kept = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, EMOJI_FREQ_MAX);
  // Null-prototype like parseEmojiFreq's, so the two halves of this state agree:
  // a stored "toString" key stays an inert score either way.
  return { picks, counts: Object.assign(Object.create(null), Object.fromEntries(kept)) };
}

// ---------- GIF picker ----------
// "/gif [query]" in the composer opens the picker instead of sending.
// -> the (possibly empty) query, or null when the text isn't the command.
export function parseGifCommand(value) {
  const m = /^\s*\/gif\b[ \t]*(.*)$/i.exec(value);
  return m ? m[1].trim() : null;
}

// ---------- auto-TLDR status map ----------
// Bound the per-conversation status Map. Entries normally clear on
// 'done'/dismiss, but a 'failed' left in a background chat lingers until it's
// reopened and dismissed, so cap defensively: FIFO-evict the oldest entry that
// isn't the chat currently on screen.
export function evictOldestTldr(map, cap, keepKey) {
  if (map.size <= cap) return;
  for (const oldest of map.keys()) {
    if (oldest === keepKey) continue;
    map.delete(oldest);
    break;
  }
}

// Friendly text for the error tokens the retry / summarize / choose endpoints
// can return, so the bubble never shows a raw enum like "not-configured".
// `already-summarized` and `in-progress` are only reachable from the message
// menu's "Summarize in chat", the one entry point gated on a video having been
// summarized already; `no-pending` only from the multi-link picker.
export function retryErrorReason(msg) {
  if (msg === 'not-configured') return 'auto-TLDR is not configured';
  if (msg === 'bad-url') return 'not a recognized YouTube link';
  if (msg === 'already-summarized') return 'that video already has a TLDR in this chat';
  if (msg === 'in-progress') return 'that video is already being summarized';
  // The picker's question was already answered, or aged out of the server's
  // memory.
  if (msg === 'no-pending') return 'that question has already been answered';
  return msg || 'retry failed';
}

// What the thread menu says under the auto-TLDR toggle.
//
// Returns either `{ note }` (all well) or a `{ before, code, after }` hint, the
// one `<code>` span being the binary name. The server only ever reports the two
// tokens it derived from its own error tags, so an unusable CLI it has not yet
// diagnosed -- the boot state, before any run has happened -- falls back to
// naming both requirements rather than guessing which one is missing.
export function tldrHint(data) {
  if (data && data.configured) {
    return { note: 'YouTube links you post here get a short auto-summary.' };
  }
  const reason = data && data.reason;
  if (reason === 'auth') {
    // The one failure the user can fix from here: `login` tells app.js to put a
    // Log in button under the hint. Not offered for 'not-found' — no browser
    // flow installs a missing binary, and a button that cannot work is worse
    // than the sentence explaining what to do.
    return { before: 'The ', code: 'claude', after: ' CLI on the server is not logged in.', login: true };
  }
  if (reason === 'not-found') {
    return { before: 'The ', code: 'claude', after: ' CLI was not found on the server’s PATH.' };
  }
  return { before: 'Needs the ', code: 'claude', after: ' CLI on the server’s PATH, logged in.' };
}

// What the status bubble shows for a pipeline stage: the label, a tone, and
// which buttons it gets. app.js only paints this -- `tone` alone drives both
// the glyph and the bubble class there ('work' = spinner, 'warn' = the danger
// look with an icon, 'info' = the quieter no-glyph notice), so adding a stage
// means touching this function, not the renderer.
//
// 'done' only reaches this with a reason attached -- it means the TLDR was SENT
// but its "For context" block was lost to a failure (a clean done clears the
// bubble before anything is rendered). It gets dismiss but never Retry: the
// summary is already in the chat, and a retry would send a whole duplicate.
// The last four stages are LOCAL ones -- the in-app `claude auth login` never
// touches the server-side pipeline, so no SSE event ever carries them; app.js
// sets them on the same per-conversation status it uses for the real stages, so
// the login lives in the bubble that reported the problem.
//
// `kind` is the server's fixed classification of a failure ('auth' /
// 'not-found'), and only 'auth' earns the Log in button: a missing binary is
// not something a browser flow can install, so offering one would be a button
// that cannot work.
//
// `extra` carries the stage's own payload: `links`/`skipped` for the picker, and
// `progress` ({index,total}) for a link the user picked out of a multi-link
// message. The progress suffix is appended to every label rather than handled
// per stage -- with one bubble per conversation, "(2 of 3)" is the only thing
// distinguishing the second link's failure from the first one's.
export function tldrBubble(stage, reason, kind, extra = {}) {
  const b = bubbleFor(stage, reason, kind, extra);
  const p = extra && extra.progress;
  if (p && p.total > 1) b.label = `${b.label} (${p.index} of ${p.total})`;
  return b;
}

function bubbleFor(stage, reason, kind, extra) {
  if (stage === 'choose') {
    // The only stage that asks a question rather than reporting. No Retry (there
    // is no single link in flight yet) and no spinner: nothing is running, and
    // nothing will until the user answers.
    return {
      label: pickerLabel(extra.links, extra.skipped),
      tone: 'info', retry: false, dismiss: true, picker: true,
    };
  }
  if (stage === 'done') {
    return {
      label: `Sent without its "For context" block: ${reason || 'research failed'}`,
      tone: 'info', retry: false, dismiss: true, login: kind === 'auth',
    };
  }
  if (stage === 'failed') {
    return {
      label: `Auto-TLDR failed${reason ? `: ${reason}` : ''}`,
      tone: 'warn', retry: true, dismiss: true, login: kind === 'auth',
    };
  }
  if (stage === 'refused') {
    // The server declined to start a run at all — that video already has a TLDR
    // here, or one is in flight. NOT 'failed': that stage always offers Retry,
    // and Retry posts to the deliberately ungated /tldr/retry, so one more click
    // would send the very duplicate the refusal just prevented.
    return {
      label: `Not summarized: ${reason || 'already done'}`,
      tone: 'info', retry: false, dismiss: true,
    };
  }
  if (stage === 'login') {
    // ⚠️ The browser normally finishes this by itself — the sign-in page calls
    // back, the CLI exits logged in, and the user is never shown a code. So the
    // label waits rather than instructing, and the code field is offered as the
    // fallback for the flow that does prompt ("paste code here *if prompted*").
    // Demanding a code up front produced a bubble asking for something that does
    // not exist in the common path.
    return {
      label: 'Waiting for you to finish signing in…',
      tone: 'work', retry: false, dismiss: false, codeInput: true, cancelLogin: true,
    };
  }
  if (stage === 'logging-in') {
    return { label: 'Signing in…', tone: 'work', retry: false, dismiss: false };
  }
  if (stage === 'login-failed') {
    return {
      label: `Sign-in failed${reason ? `: ${reason}` : ''}`,
      tone: 'warn', retry: false, dismiss: true, login: true,
    };
  }
  if (stage === 'logged-in') {
    // Asks for Retry so the link that triggered all this can be re-run in one
    // click. Reached from the thread menu instead there is no link in flight,
    // and the renderer drops a Retry it has no url for (see renderTldrStatus).
    return {
      label: 'Signed in. Auto-TLDR is live again.',
      tone: 'info', retry: true, dismiss: true,
    };
  }
  const label =
    stage === 'fetching' ? 'Fetching transcript…'
    : stage === 'summarizing' ? 'Summarizing…'
    : stage === 'researching' ? 'Researching the channel…'
    : stage === 'retrying' ? `Retrying${reason ? ` (${reason})` : ''}…`
    : 'Working…';
  return { label, tone: 'work', retry: false, dismiss: false };
}

// The picker's question line. `links` are the candidates listed and `skipped`
// the ones past the server's cap -- said out loud, because a link dropped in
// silence is the whole bug this feature exists to fix.
export function pickerLabel(links, skipped) {
  const n = Array.isArray(links) ? links.length : 0;
  const extra = skipped > 0 ? skipped : 0;
  // The count is the REAL total, not the listed subset: "8 links (2 more were
  // not listed)" reads as a contradiction, and the whole point of saying
  // anything is that the reader learns nothing was quietly dropped.
  const head = `Which of these ${n + extra} YouTube links should I summarize?`;
  return extra ? `${head} Only the first ${n} are listed.` : head;
}
