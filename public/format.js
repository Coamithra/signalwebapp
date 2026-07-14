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

// ":shrug:" -> 🤷, using Signal's own shortcode table. A backslash escapes it
// (`\:shrug:` sends the literal text). Runs before the markdown pass so ranges
// are measured against the final text.
export function expandShortcodes(text) {
  return text.replace(/(\\?):([a-z0-9_+-]+):/gi, (all, esc, name) => {
    if (esc) return all.slice(1); // "\:name:" -> literal ":name:"
    const emoji = EMOJI_SHORTCODES[name.toLowerCase()];
    return emoji || all;
  });
}

// The one shortcode the composer expands while you type: the one you just
// closed. Returns the emoji for ":name:" ending at `caret`, or null.
export function shortcodeBefore(text, caret) {
  const m = /:([a-z0-9_+-]+):$/i.exec(text.slice(0, caret));
  if (!m || text[m.index - 1] === '\\') return null;
  const emoji = EMOJI_SHORTCODES[m[1].toLowerCase()];
  return emoji ? { emoji, start: m.index, end: caret } : null;
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

    const m = ctx.ranges.length < MAX_RANGES ? openerAt(src, i, src[i - 1]) : null;
    const close = m ? findCloser(src, i + m.marker.length, m) : -1;
    if (m && close !== -1) {
      flush();
      const inner = src.slice(i + m.marker.length, close);
      const start = ctx.out.length;
      // Monospace is literal: `*not bold*` inside backticks stays as typed.
      if (m.style === STYLE.MONOSPACE) ctx.out += inner;
      else parseInto(inner, ctx);
      if (ctx.out.length > start) {
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
export function toMarkdown(text, bodyRanges) {
  const ranges = (bodyRanges || []).filter((r) => MARKER_FOR[r.style] && r.length > 0);
  // Escaping every marker char is always *safe*, but it's noise in the composer:
  // most text ("snake_case_ok", "C:\Users") re-parses to itself untouched. So
  // emit the clean version, and only fall back to the escaped one if a re-parse
  // wouldn't give the message back exactly.
  const clean = buildMarkdown(text, ranges, false);
  const reparsed = parseFormatting(clean);
  if (reparsed.text === text && sameRanges(reparsed.bodyRanges, ranges)) return clean;
  return buildMarkdown(text, ranges, true);
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
  (all, name) => (EMOJI_SHORTCODES[name.toLowerCase()] ? '\\' + all : all));

// ---------- rendering ----------

const TAG_FOR = {
  [STYLE.BOLD]: 'strong', [STYLE.ITALIC]: 'em', [STYLE.STRIKETHROUGH]: 's',
  [STYLE.MONOSPACE]: 'code', [STYLE.SPOILER]: 'span',
};

function styleEl(style) {
  const node = document.createElement(TAG_FOR[style] || 'span');
  if (style === STYLE.SPOILER) {
    node.className = 'spoiler';
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    node.title = 'Click to reveal';
    const reveal = () => node.classList.add('revealed');
    node.addEventListener('click', reveal);
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); reveal(); } });
  }
  return node;
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

    const node = styleEl(r.style);
    for (const child of buildNodes(text, inner, start, end)) node.appendChild(child);
    nodes.push(node);
    at = end;
  }
  if (at < to) nodes.push(document.createTextNode(text.slice(at, to)));
  return nodes;
}

// Message text -> DOM. Built with createElement/createTextNode only: message
// bodies are attacker-influenced, so no innerHTML anywhere on this path.
export function renderFormatted(text, bodyRanges) {
  const frag = document.createDocumentFragment();
  const body = text || '';
  const ranges = (bodyRanges || [])
    .filter((r) => r && TAG_FOR[r.style] && r.start >= 0 && r.length > 0 && r.start + r.length <= body.length)
    .sort((a, b) => a.start - b.start || b.length - a.length);
  for (const node of buildNodes(body, ranges, 0, body.length)) frag.appendChild(node);
  return frag;
}
