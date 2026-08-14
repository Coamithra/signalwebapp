// Message text formatting: the composer's markdown-ish syntax and ":shortcode:"
// emoji on the way OUT, and Signal's style bodyRanges on the way IN.
//
// Signal carries formatting out-of-band: the body is plain text and a parallel
// list of bodyRanges says "chars 6..10 are italic". Signal Desktop's own
// composer only produces those from its toolbar/keyboard shortcuts — it has no
// markdown input — so the `_italics_` syntax here is ours. It exists because
// that's what people actually type. Mentions ride in the same bodyRanges array,
// but the bridge inlines those into the text (see page-api.js formatBody), so
// everything here is styles-only.
//
// Style ids are Signal's own (probed from its bundle: proto BodyRange.Style).

import { EMOJI_SHORTCODES } from './emoji-shortcodes.js';
import { EMOJI_TAGS } from './emoji-tags.js';
import { safeHttpUrl } from './ui-logic.js';

export const STYLE = Object.freeze({
  BOLD: 1, ITALIC: 2, SPOILER: 3, STRIKETHROUGH: 4, MONOSPACE: 5,
});

// Longest markers first — "**" must win over "*".
const MARKERS = [
  { marker: '||', style: STYLE.SPOILER },
  { marker: '**', style: STYLE.BOLD },
  { marker: '__', style: STYLE.ITALIC },
  { marker: '~~', style: STYLE.STRIKETHROUGH },
  { marker: '*', style: STYLE.BOLD },
  { marker: '_', style: STYLE.ITALIC },
  { marker: '~', style: STYLE.STRIKETHROUGH },
  { marker: '`', style: STYLE.MONOSPACE },
];
const ESCAPABLE = new Set(['*', '_', '~', '`', '|', '\\', ':']);
const MAX_RANGES = 250; // pathological input shouldn't hand Signal a huge array

const isWordChar = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

// Every lookup goes through here: a bare EMOJI_SHORTCODES[name] would walk the
// prototype chain, so ":constructor:" or ":__proto__:" would splice a function
// source string / "[object Object]" into the outgoing message.
const emojiFor = (name) => {
  const key = name.toLowerCase();
  return Object.hasOwn(EMOJI_SHORTCODES, key) ? EMOJI_SHORTCODES[key] : undefined;
};

// The same lookup for app.js, which needs it to migrate the old name-keyed
// pick counts (see parseEmojiFreq) — never a bare EMOJI_SHORTCODES[name].
export { emojiFor as emojiForShortcode };

// ":shrug:" -> 🤷, using Signal's own shortcode table. A backslash escapes it
// (`\:shrug:` sends the literal text). Runs before the markdown pass so ranges
// are measured against the final text.
export function expandShortcodes(text) {
  return text.replace(/(\\?):([a-z0-9_+-]+):/gi, (all, esc, name) => {
    if (esc) return all.slice(1); // "\:name:" -> literal ":name:"
    return emojiFor(name) || all;
  });
}

// The one shortcode the composer expands while you type: the one you just
// closed. Returns the emoji for ":name:" ending at `caret`, or null.
export function shortcodeBefore(text, caret) {
  const m = /:([a-z0-9_+-]+):$/i.exec(text.slice(0, caret));
  if (!m || text[m.index - 1] === '\\') return null;
  const emoji = emojiFor(m[1]);
  return emoji ? { emoji, start: m.index, end: caret } : null;
}

// The open half of the same idea: an unclosed ":na" run ending at `caret`, which
// is what the composer's autocomplete popup completes. It keeps the backslash
// guard from above and adds two the closed path doesn't need: the ":" must not
// follow a word char or another ":", so "http://x" and "12:30" never open a
// suggestion list. Two chars minimum — ":a" matches a third of the table and
// suggests nothing useful.
export function shortcodeQueryBefore(text, caret) {
  const m = /:([a-z0-9_+-]{2,})$/i.exec(text.slice(0, caret));
  if (!m) return null;
  const prev = text[m.index - 1];
  if (prev === '\\' || prev === ':' || isWordChar(prev)) return null;
  return { query: m[1].toLowerCase(), start: m.index };
}

// The synonyms Signal's own picker searches, so ":chef" can find :cook:. Same
// prototype-chain hazard as emojiFor, same guard.
const tagsFor = (name) => (Object.hasOwn(EMOJI_TAGS, name) ? EMOJI_TAGS[name] : undefined);

// Sorted once: re-keying a ~1900-entry object on every keystroke is wasteful, and
// the sort is what makes ties below alphabetical for free.
let sortedNames = null;
let sortedTagNames = null;

// How often the user has picked an emoji. Keyed by the EMOJI rather than the
// shortcode, because one glyph answers to several names (and to its synonyms)
// and results are deduped by emoji, so name-keyed picks would split across
// spellings. `weights` comes out of localStorage, so it can carry anything a
// user has hand-edited in — including "__proto__". hasOwn keeps a junk value
// from ranking, and a non-number would poison the sort.
function weightOf(weights, emoji) {
  const w = Object.hasOwn(weights, emoji) ? weights[emoji] : 0;
  return typeof w === 'number' && Number.isFinite(w) ? w : 0;
}

// Length last, as a stand-in for "how much of the match the query covered". For a
// tag hit that's the tag's length, not the shortcode's — the shortcode isn't what
// matched. Name hits carry no tag, so the term is a no-op for them.
const byRank = (a, b) => a.tier - b.tier || b.weight - a.weight
  || (a.tag?.length || 0) - (b.tag?.length || 0) || a.name.length - b.name.length;

// Shortcode names matching `query`, best first, for the autocomplete popup.
// Tiers (exact -> prefix -> substring) are primary and `weights` (how often the
// user has picked each name) only orders *within* a tier: a prefix match must
// never end up below a substring one just because the latter is a favourite.
// Substring matching is the whole point — Signal's own names are often
// unguessable, so ":up" has to be able to find "thumbs_up".
//
// Where even a substring can't reach — a *different word* for the same thing —
// synonyms take over: ":chef" has nothing in common with "cook". Those come
// from Signal's own search index (see EMOJI_TAGS) and rank strictly *below*
// every name match, so a synonym can never bury a real shortcode and nothing
// that matched before this existed has moved.
//
// Results are deduped by emoji rather than by name, since one emoji now answers
// to several names (:hankey:/:poop:/:shit:) plus its synonyms, and eight rows of
// the same glyph would be a worse list than eight different ones.
export function matchShortcodes(query, limit = 8, weights = {}) {
  const q = String(query || '').toLowerCase();
  if (!q) return [];
  if (!sortedNames) sortedNames = Object.keys(EMOJI_SHORTCODES).sort();

  const byName = [];
  for (const name of sortedNames) {
    const at = name.indexOf(q);
    if (at < 0) continue;
    // Resolved here rather than in take(), because the weight is keyed by it.
    const emoji = emojiFor(name);
    if (emoji === undefined) continue;
    byName.push({ name, emoji, tier: name === q ? 0 : at === 0 ? 1 : 2, weight: weightOf(weights, emoji) });
  }
  byName.sort(byRank);

  const out = [];
  const seen = new Set();
  const take = (scored) => {
    for (const { name, emoji, tag } of scored) {
      if (out.length >= limit) return;
      if (seen.has(emoji)) continue;
      seen.add(emoji);
      out.push(tag ? { name, emoji, tag } : { name, emoji });
    }
  };
  // Hard cap, no scrolling: past this, typing another character narrows better
  // than paging through a list ever would.
  take(byName);
  // Tags rank below every name, so once the cap is full they cannot change the
  // list — which makes scanning ~7800 of them per keystroke skippable outright.
  if (out.length >= limit) return out;

  if (!sortedTagNames) sortedTagNames = Object.keys(EMOJI_TAGS).sort();
  const byTag = [];
  for (const name of sortedTagNames) {
    let best = null;
    for (const tag of tagsFor(name) || []) {
      const at = tag.indexOf(q);
      if (at < 0) continue;
      const tier = tag === q ? 0 : at === 0 ? 1 : 2;
      // Best tier wins; the shortest tag breaks a tie, as the one whose match
      // covers most of it — "chef" over "chef_hat" for the query "chef".
      if (!best || tier < best.tier || (tier === best.tier && tag.length < best.tag.length)) best = { tier, tag };
    }
    if (!best) continue;
    const emoji = emojiFor(name);
    if (emoji === undefined) continue;
    byTag.push({ name, emoji, tier: best.tier, tag: best.tag, weight: weightOf(weights, emoji) });
  }
  byTag.sort(byRank);
  take(byTag);
  return out;
}

// A marker only opens a span if it isn't glued to a word on its left ("snake_case"
// stays snake_case) and the span doesn't start with a space ("2 * 3 * 4" stays maths).
function openerAt(src, i, prevSrcChar) {
  if (isWordChar(prevSrcChar)) return null;
  for (const m of MARKERS) {
    if (!src.startsWith(m.marker, i)) continue;
    const next = src[i + m.marker.length];
    if (next === undefined || /\s/.test(next)) continue;
    return m;
  }
  return null;
}

// ...and only closes where it isn't glued to a word on its right, and the span
// doesn't end with a space.
function findCloser(src, from, m) {
  for (let j = from; j <= src.length - m.marker.length; j++) {
    if (src[j] === '\\') { j++; continue; } // escaped -> not a marker
    if (!src.startsWith(m.marker, j)) continue;
    if (j === from) continue;                       // empty span
    if (/\s/.test(src[j - 1])) continue;            // "_foo _" isn't a close
    if (isWordChar(src[j + m.marker.length])) continue;
    return j;
  }
  return -1;
}

function parseInto(src, ctx) {
  let literal = '';
  const flush = () => {
    if (!literal) return;
    ctx.out += literal;
    literal = '';
  };

  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '\\' && ESCAPABLE.has(src[i + 1])) { literal += src[i + 1]; i += 2; continue; }

    const m = openerAt(src, i, src[i - 1]);
    const close = m ? findCloser(src, i + m.marker.length, m) : -1;
    if (m && close !== -1) {
      flush();
      const inner = src.slice(i + m.marker.length, close);
      const start = ctx.out.length;
      // Monospace is literal: `*not bold*` inside backticks stays as typed.
      if (m.style === STYLE.MONOSPACE) ctx.out += inner;
      else parseInto(inner, ctx);
      // Past the cap, markers are still *consumed* — dropping the styling is one
      // thing, leaving stray asterisks in what the message says is another.
      if (ctx.out.length > start && ctx.ranges.length < MAX_RANGES) {
        ctx.ranges.push({ start, length: ctx.out.length - start, style: m.style });
      }
      i = close + m.marker.length;
      continue;
    }
    literal += c;
    i++;
  }
  flush();
}

// Composer text -> what Signal actually stores: plain text + style bodyRanges.
export function parseFormatting(raw) {
  const ctx = { out: '', ranges: [] };
  parseInto(expandShortcodes(raw), ctx);
  ctx.ranges.sort((a, b) => a.start - b.start || b.length - a.length);
  return { text: ctx.out, bodyRanges: ctx.ranges };
}

// The inverse, for prefilling the composer when editing a formatted message.
// Markers are inserted at range boundaries (closers before openers at the same
// offset, so nested spans stay balanced) and any literal marker char in the
// text is escaped so a re-parse round-trips.
// Signal's own composer can produce ranges ours never would — crossing spans
// (bold 0-3 + italic 2-5), or a span padded with spaces — and there is no
// marker placement that survives a re-parse for those. Saving such an edit must
// not rewrite what the message *says*, so each candidate is checked by
// re-parsing it, cheapest first, and the last resort keeps the text exactly and
// gives up only the styling.
export function toMarkdown(text, bodyRanges) {
  const ranges = (bodyRanges || []).filter((r) => MARKER_FOR[r.style] && r.length > 0);
  const faithful = (candidate) => {
    const re = parseFormatting(candidate);
    return re.text === text && sameRanges(re.bodyRanges, ranges);
  };

  // Escaping every marker char is always safe, but it's noise in the composer:
  // most text ("snake_case_ok", "C:\Users") re-parses to itself untouched.
  const clean = buildMarkdown(text, ranges, false);
  if (faithful(clean)) return clean;

  const escaped = buildMarkdown(text, ranges, true);
  if (faithful(escaped)) return escaped;

  return buildMarkdown(text, [], true); // text intact, formatting dropped
}

function buildMarkdown(text, ranges, escape) {
  // Chars inside a monospace span are re-parsed literally, so escaping them
  // there would show up as backslashes in the message.
  const literal = new Set();
  const opens = new Map();
  const closes = new Map();
  const at = (map, i) => { if (!map.has(i)) map.set(i, []); return map.get(i); };
  for (const r of ranges) {
    const marker = MARKER_FOR[r.style];
    at(opens, r.start).push(marker);
    at(closes, r.start + r.length).unshift(marker);
    if (r.style !== STYLE.MONOSPACE) continue;
    for (let i = r.start; i < r.start + r.length; i++) literal.add(i);
  }

  let out = '';
  for (let i = 0; i <= text.length; i++) {
    for (const m of closes.get(i) || []) out += m;
    for (const m of opens.get(i) || []) out += m;
    if (i < text.length) out += escape && !literal.has(i) ? escapeMarkers(text[i]) : text[i];
  }
  return escape ? escapeShortcodes(out) : out;
}

const sameRanges = (a, b) => {
  const key = (rs) => rs.map((r) => `${r.start}:${r.length}:${r.style}`).sort().join('|');
  return key(a) === key(b);
};

const MARKER_FOR = {
  [STYLE.BOLD]: '*', [STYLE.ITALIC]: '_', [STYLE.STRIKETHROUGH]: '~',
  [STYLE.MONOSPACE]: '`', [STYLE.SPOILER]: '||',
};

const escapeMarkers = (s) => s.replace(/[*_~`|\\]/g, '\\$&');

// A body that literally reads ":shrug:" (someone typed it escaped, or a client
// that doesn't expand shortcodes sent it) must not silently become 🤷 when the
// composer text is re-parsed. Safe inside monospace too: expandShortcodes strips
// the backslash before the markdown pass ever sees the span.
const escapeShortcodes = (s) => s.replace(/:([a-z0-9_+-]+):/gi,
  (all, name) => (emojiFor(name) ? '\\' + all : all));

// ---------- links ----------

// Bare domains are worth linking — people type "example.com" constantly — but
// without a TLD list every "reboot.sh", "README.md" and "v1.2.3" turns into a
// link, and the full IANA table is ~1500 entries we have no dependency budget
// for. So a bare host is only linkified when its last label is one of these:
// the common generic TLDs plus the big ccTLDs, minus anything that reads as an
// English word after a dot (.it, .in, .at, .be, .no, .us), because chat is full
// of missing-space typos like "sure.it works". An exotic TLD needs a scheme.
const TLDS = [
  'com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'info', 'biz',
  'io', 'ai', 'app', 'dev', 'co', 'me', 'tv', 'fm', 'gg', 'xyz',
  'online', 'site', 'tech', 'blog', 'news', 'shop', 'store', 'wiki',
  'uk', 'de', 'fr', 'nl', 'es', 'se', 'dk', 'fi', 'pl', 'cz', 'pt', 'ie', 'ch',
  'ru', 'ua', 'jp', 'cn', 'kr', 'br', 'mx', 'ca', 'au', 'nz', 'za', 'tr', 'il', 'eu',
];

// A host label: alphanumerics and inner hyphens. Reused for the leading label
// and every dotted one after it.
const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const LINK_RE = new RegExp(
  // An explicit scheme (http included — unlike the *preview* gate, which is
  // https-only because that's what Signal will fetch), or a bare "www.".
  `(?:https?://|www\\.)[^\\s<>]+`
  + '|'
  // ...or a bare host on a known TLD, with an optional path/query/port.
  + `${LABEL}(?:\\.${LABEL})*\\.(?:${TLDS.join('|')})\\b(?:[:/?#][^\\s<>]*)?`,
  'gi',
);

// A match glued to one of these on its left isn't a link: an email local part
// ("foo@example.com"), another scheme ("mailto:example.com"), a Windows path
// ("C:\\Users\\thing.com"), or the tail of a longer token.
const GLUED_LEFT = /[\p{L}\p{N}_@.\-/:\\]/u;

const CLOSER_FOR = { ')': '(', ']': '[', '}': '{' };
const occurrences = (s, ch) => s.split(ch).length - 1;

// URLs sit in prose, so the sentence punctuation after one isn't part of it.
// A closing bracket is only trailing when it doesn't balance an opener inside
// the match — Wikipedia's "…_(disambiguation)" keeps its paren, "(see x.com)"
// doesn't steal one.
function trimTail(s) {
  while (s) {
    const last = s[s.length - 1];
    if ('.,;:!?…"\''.includes(last)) { s = s.slice(0, -1); continue; }
    const opener = CLOSER_FOR[last];
    if (opener && occurrences(s, last) > occurrences(s, opener)) { s = s.slice(0, -1); continue; }
    break;
  }
  return s;
}

// The links in a plain message body, in order and non-overlapping, as ranges
// the renderer can walk alongside Signal's style ranges.
// Not to be confused with `hasLink` in ui-logic.js: that is the link-*preview*
// gate and is https-only on purpose (Signal's own shouldPreviewHref decides
// what it will fetch). Clickability has no such constraint.
export function linkSpans(text) {
  const body = typeof text === 'string' ? text : '';
  const out = [];
  LINK_RE.lastIndex = 0;
  for (let m; (m = LINK_RE.exec(body));) {
    const prev = body[m.index - 1];
    if (prev !== undefined && GLUED_LEFT.test(prev)) continue;
    const raw = trimTail(m[0]);
    if (!raw) continue;
    // Message bodies are attacker-influenced, so the scheme gate is the same
    // one the preview card uses: anything that isn't plain http(s) — including
    // a "javascript:" that slipped through the regex — never becomes an anchor.
    const href = safeHttpUrl(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (href) out.push({ start: m.index, length: raw.length, href });
  }
  return out;
}

// ---------- rendering ----------

const TAG_FOR = {
  [STYLE.BOLD]: 'strong', [STYLE.ITALIC]: 'em', [STYLE.STRIKETHROUGH]: 's',
  [STYLE.MONOSPACE]: 'code', [STYLE.SPOILER]: 'span',
};

// Returns the element to place in the tree plus the `host` its content goes
// into — the same node for every style but SPOILER, whose content is wrapped
// in an inner span. CSS can't hide a bare text node (`.spoiler *` only reaches
// elements) and colour-font emoji ignore `color: transparent`, so the wrapper
// is what gives the blackout something to put `visibility: hidden` on — which
// also keeps the unrevealed text out of the accessibility tree.
// A link span (carrying `href` instead of `style`) travels the same walk, so
// formatting inside a URL nests in the anchor like anything else.
function styleEl(r) {
  if (r.href) {
    const a = document.createElement('a');
    a.href = r.href;
    // New tab, always: clicking a link in a thread must never navigate the app
    // tab away from what you were reading.
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return { node: a, host: a };
  }
  const style = r.style;
  const node = document.createElement(TAG_FOR[style] || 'span');
  if (style !== STYLE.SPOILER) return { node, host: node };

  node.className = 'spoiler';
  node.tabIndex = 0;
  node.setAttribute('role', 'button');
  node.title = 'Click to reveal';
  const reveal = () => node.classList.add('revealed');
  node.addEventListener('click', reveal);
  node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); reveal(); } });

  const host = document.createElement('span');
  host.className = 'spoiler-body';
  node.appendChild(host);
  return { node, host };
}

// Nest ranges into elements over [from, to). Ranges that only partially overlap
// (Signal allows it; our parser doesn't produce it) are clipped to the parent
// span and their remainder handled by the caller's loop — so the DOM stays a
// tree without dropping any styling.
function buildNodes(text, ranges, from, to) {
  const nodes = [];
  let at = from;
  const pending = ranges.slice();

  while (pending.length) {
    const r = pending.shift();
    const start = Math.max(r.start, at);
    const end = Math.min(r.start + r.length, to);
    if (end <= start) continue;

    if (start > at) nodes.push(document.createTextNode(text.slice(at, start)));

    const inner = [];
    for (let k = 0; k < pending.length;) {
      const o = pending[k];
      const oEnd = o.start + o.length;
      if (o.start >= end) break;                       // starts after this span
      if (oEnd <= end) { inner.push(o); pending.splice(k, 1); continue; }
      inner.push({ ...o, length: end - o.start });     // clip the overlapping head...
      pending[k] = { ...o, start: end, length: oEnd - end }; // ...keep the tail for the outer loop
      k++;
    }

    const { node, host } = styleEl(r);
    for (const child of buildNodes(text, inner, start, end)) host.appendChild(child);
    nodes.push(node);
    at = end;
  }
  if (at < to) nodes.push(document.createTextNode(text.slice(at, to)));
  return nodes;
}

const overlaps = (a, b) => a.start < b.start + b.length && b.start < a.start + a.length;
const contains = (a, b) => a.start <= b.start && a.start + a.length >= b.start + b.length;

// Split any style range that *crosses* a link boundary — starts outside the
// link and ends inside it, or the reverse — at that boundary. Ranges that are
// disjoint from every link, contain one, or sit inside one are left as they
// are. Afterwards containment always holds between a style and a link, which is
// what lets buildNodes nest them without ever having to clip an anchor in half.
function splitAcrossLinks(styles, links) {
  let out = styles;
  for (const l of links) {
    const lEnd = l.start + l.length;
    const next = [];
    for (const r of out) {
      const rEnd = r.start + r.length;
      const crossesStart = r.start < l.start && rEnd > l.start && rEnd < lEnd;
      const crossesEnd = r.start > l.start && r.start < lEnd && rEnd > lEnd;
      if (!crossesStart && !crossesEnd) { next.push(r); continue; }
      const cut = crossesStart ? l.start : lEnd;
      next.push({ ...r, length: cut - r.start }, { ...r, start: cut, length: rEnd - cut });
    }
    out = next;
  }
  return out;
}

// Message text -> DOM. Built with createElement/createTextNode only: message
// bodies are attacker-influenced, so no innerHTML anywhere on this path.
//
// Links are detected here and walked as ranges beside Signal's style ranges,
// rather than as a second pass over the finished text: a style range can cover
// part of a URL, and only one walk can nest both without either splitting the
// anchor or dropping the styling.
export function renderFormatted(text, bodyRanges) {
  const frag = document.createDocumentFragment();
  const body = text || '';
  const styles = (bodyRanges || [])
    .filter((r) => r && TAG_FOR[r.style] && r.start >= 0 && r.length > 0 && r.start + r.length <= body.length);
  // A spoiler *around* a link keeps its anchor: `.spoiler-body` is
  // `visibility: hidden` until revealed, and a hidden subtree takes no clicks
  // and no focus — so the link is genuinely unclickable until then, and
  // clickable after, for free. A spoiler that only partly covers a link (or
  // hides a piece in the middle of one) drops the anchor altogether: a URL
  // whose visible text is partly blacked out is a deception vector, and there
  // is no honest way to render it.
  const links = linkSpans(body).filter(
    (l) => !styles.some((r) => r.style === STYLE.SPOILER && overlaps(r, l) && !contains(r, l)),
  );
  const ranges = splitAcrossLinks(styles, links).concat(links)
    .sort((a, b) => a.start - b.start || b.length - a.length);
  for (const node of buildNodes(body, ranges, 0, body.length)) frag.appendChild(node);
  return frag;
}
