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
export function menuActionsFor(msg) {
  const actions = [];
  const isOut = msg.direction === 'outgoing';
  const hasText = !!(msg.text && msg.text.trim());
  if (isOut && hasText && !msg.deletedForEveryone && !msg.isViewOnce) actions.push('edit');
  if (isOut && !msg.deletedForEveryone) actions.push('deleteForEveryone');
  actions.push('deleteForMe');
  return actions;
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

// ---------- emoji pick frequency ----------
// Picks are counted so a hard-capped list of 8 stays useful: substring matching
// means ":up" has ~40 candidates, and the ones you actually use should be in
// them. Per-browser and best-effort — localStorage can be full, disabled, or
// hand-edited, so every read is defensive and every write can fail silently.
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
// -> { counts: {name: score}, picks: number-since-last-decay }
export function parseEmojiFreq(rawJson) {
  try {
    const raw = JSON.parse(rawJson || '{}');
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.counts : null;
    const counts = Object.create(null);
    if (src && typeof src === 'object' && !Array.isArray(src)) {
      for (const [k, v] of Object.entries(src)) {
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) counts[k] = v;
      }
    }
    const picks = Number.isFinite(raw?.picks) && raw.picks >= 0 ? raw.picks : 0;
    return { counts, picks };
  } catch { return { counts: Object.create(null), picks: 0 }; }
}

// Record a pick: bump the name, decay everything on the halflife boundary, and
// return the snapshot to persist (capped to the top EMOJI_FREQ_MAX).
// `freq.counts` is mutated in place — it's the live ranking the popup reads, so
// the new score has to show up without a reload.
export function nextEmojiFreq(freq, name) {
  const counts = freq.counts;
  counts[name] = (counts[name] || 0) + 1;

  let picks = freq.picks + 1;
  if (picks >= EMOJI_FREQ_HALFLIFE) {
    picks = 0;
    for (const k of Object.keys(counts)) {
      const decayed = counts[k] / 2;
      if (decayed < EMOJI_FREQ_FLOOR) delete counts[k]; else counts[k] = decayed;
    }
  }

  const kept = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, EMOJI_FREQ_MAX);
  return { picks, counts: Object.fromEntries(kept) };
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

// Friendly text for the error tokens the retry endpoint can return, so the
// bubble never shows a raw enum like "not-configured".
export function retryErrorReason(msg) {
  if (msg === 'not-configured') return 'auto-TLDR is not configured';
  if (msg === 'bad-url') return 'not a recognized YouTube link';
  return msg || 'retry failed';
}
