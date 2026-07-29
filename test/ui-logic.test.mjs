// Tests for the DOM-free half of the frontend (public/ui-logic.js) — the logic
// lifted out of public/app.js so it can run under node's built-in runner
// (`npm test`) with no jsdom and no dependency.
//
// The popup's own state machine (open/dismiss stickiness, key guards) still
// lives in app.js and is still browser-verified only; it needs a DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AVATAR_COLORS, colorFor, initials, previewText, menuActionsFor,
  kindForType, iconForKind, parseEmojiFreq, nextEmojiFreq,
  EMOJI_FREQ_MAX, EMOJI_FREQ_HALFLIFE, EMOJI_FREQ_FLOOR,
  parseGifCommand, evictOldestTldr, retryErrorReason,
} from '../public/ui-logic.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------- avatars ----------

test('colorFor is deterministic and always lands in the palette', () => {
  const ids = ['', 'a', 'conv-1', 'conv-2', '☃️', 'x'.repeat(500)];
  for (const id of ids) {
    const c = colorFor(id);
    assert.ok(AVATAR_COLORS.includes(c), `${JSON.stringify(id)} -> ${c}`);
    assert.equal(colorFor(id), c, 'same id must give the same colour');
  }
  // Different ids should not all collapse onto one bucket.
  const seen = new Set(Array.from({ length: 60 }, (_, i) => colorFor(`conv-${i}`)));
  assert.ok(seen.size > 1, 'hash spreads across the palette');
});

test('initials', () => {
  assert.equal(initials('Alice Bobson'), 'AB');
  assert.equal(initials('alice middle bobson'), 'AB'); // first + last, not middle
  assert.equal(initials('cher'), 'CH');               // one word -> first two chars
  assert.equal(initials('X'), 'X');                   // shorter than two chars
  assert.equal(initials('  spaced   out  '), 'SO');   // collapses whitespace
  assert.equal(initials(''), '?');
  assert.equal(initials('   '), '?');
  assert.equal(initials(null), '?');
  assert.equal(initials(undefined), '?');
});

// ---------- conversation list ----------

test('previewText precedence: typing > deleted > text > attachment', () => {
  assert.equal(previewText({ typing: true, lastMessageText: 'hi', lastMessageDeleted: true }), '…typing');
  assert.equal(previewText({ lastMessageDeleted: true, lastMessageText: 'hi' }), 'This message was deleted');
  assert.equal(previewText({ lastMessageText: 'hi', lastMessageStatus: 'sent' }), 'hi');
  assert.equal(previewText({ lastMessageStatus: 'sent' }), 'Attachment');
  assert.equal(previewText({ lastMessageText: '', lastMessageStatus: 'sent' }), 'Attachment');
  assert.equal(previewText({}), '');
  assert.equal(previewText({ lastMessageText: '' }), '');
});

// ---------- message menu ----------

test('menuActionsFor: local delete is always offered', () => {
  const cases = [
    {}, { direction: 'incoming' }, { direction: 'outgoing' },
    { direction: 'outgoing', deletedForEveryone: true },
  ];
  for (const msg of cases) assert.ok(menuActionsFor(msg).includes('deleteForMe'), JSON.stringify(msg));
});

test('menuActionsFor: edit needs your own live text message', () => {
  const base = { direction: 'outgoing', text: 'hi' };
  assert.deepEqual(menuActionsFor(base), ['edit', 'deleteForEveryone', 'deleteForMe']);
  // Incoming: no edit, no unsend.
  assert.deepEqual(menuActionsFor({ ...base, direction: 'incoming' }), ['deleteForMe']);
  // Attachment-only (no text): unsend still applies, edit does not.
  assert.deepEqual(menuActionsFor({ direction: 'outgoing' }), ['deleteForEveryone', 'deleteForMe']);
  assert.deepEqual(menuActionsFor({ ...base, text: '   ' }), ['deleteForEveryone', 'deleteForMe']);
  // View-once: not editable, but still unsendable.
  assert.deepEqual(menuActionsFor({ ...base, isViewOnce: true }), ['deleteForEveryone', 'deleteForMe']);
  // Already a tombstone: nothing left to edit or retract.
  assert.deepEqual(menuActionsFor({ ...base, deletedForEveryone: true }), ['deleteForMe']);
});

// ---------- attachments ----------

test('kindForType / iconForKind', () => {
  assert.equal(kindForType('image/png'), 'image');
  assert.equal(kindForType('video/mp4'), 'video');
  assert.equal(kindForType('audio/ogg'), 'audio');
  assert.equal(kindForType('application/pdf'), 'file');
  assert.equal(kindForType(''), 'file');
  // Only a leading match counts — no "x-image/..." false positive.
  assert.equal(kindForType('text/image-notes'), 'file');

  assert.equal(iconForKind('image'), '🖼️');
  assert.equal(iconForKind('video'), '🎬');
  assert.equal(iconForKind('audio'), '🎵');
  assert.equal(iconForKind('file'), '📎');
  assert.equal(iconForKind('nonsense'), '📎');
});

// ---------- emoji frequency: parsing ----------

const empty = (freq) => {
  assert.deepEqual({ ...freq.counts }, {});
  assert.equal(freq.picks, 0);
};

test('parseEmojiFreq: nothing stored', () => {
  empty(parseEmojiFreq(null));
  empty(parseEmojiFreq(undefined));
  empty(parseEmojiFreq(''));
  empty(parseEmojiFreq('{}'));
});

test('parseEmojiFreq: junk degrades to the empty state instead of throwing', () => {
  empty(parseEmojiFreq('not json'));
  empty(parseEmojiFreq('[1,2,3]'));           // top level array
  empty(parseEmojiFreq('null'));
  empty(parseEmojiFreq('42'));
  empty(parseEmojiFreq('"a string"'));
  empty(parseEmojiFreq('{"counts":[1,2]}'));  // counts as an array
  empty(parseEmojiFreq('{"counts":"nope"}'));
  empty(parseEmojiFreq('{"counts":null}'));
});

test('parseEmojiFreq: only finite positive numeric scores survive', () => {
  const raw = JSON.stringify({
    counts: {
      good: 3, half: 0.5,
      zero: 0, negative: -2, str: '5', nan: null, obj: {}, arr: [],
    },
    picks: 7,
  });
  const { counts, picks } = parseEmojiFreq(raw);
  assert.deepEqual({ ...counts }, { good: 3, half: 0.5 });
  assert.equal(picks, 7);
});

test('parseEmojiFreq: picks is sanitized', () => {
  assert.equal(parseEmojiFreq('{"picks":-1}').picks, 0);
  assert.equal(parseEmojiFreq('{"picks":"12"}').picks, 0);
  assert.equal(parseEmojiFreq('{"picks":null}').picks, 0);
  assert.equal(parseEmojiFreq('{}').picks, 0);
  assert.equal(parseEmojiFreq('{"picks":0}').picks, 0);
  assert.equal(parseEmojiFreq('{"picks":12}').picks, 12);
});

test('parseEmojiFreq: counts has no prototype, so a stored "__proto__" key is inert', () => {
  const { counts } = parseEmojiFreq('{"counts":{"toString":3}}');
  assert.equal(Object.getPrototypeOf(counts), null);
  assert.equal(counts.toString, 3);
});

// ---------- emoji frequency: bump / decay / cap ----------

const freqOf = (counts, picks = 0) => ({ counts: Object.assign(Object.create(null), counts), picks });

test('nextEmojiFreq: bumps the picked name and advances picks', () => {
  const freq = freqOf({ smile: 2 }, 3);
  const snap = nextEmojiFreq(freq, 'smile');
  assert.equal(snap.picks, 4);
  assert.deepEqual({ ...snap.counts }, { smile: 3 });
  // counts is mutated in place: the live ranking must see the new score without
  // a reload. picks deliberately is NOT — the caller writes that back.
  assert.equal(freq.counts.smile, 3);
  assert.equal(freq.picks, 3);
});

test('nextEmojiFreq: a new name starts at 1', () => {
  const snap = nextEmojiFreq(freqOf({}), 'thumbs_up');
  assert.deepEqual({ ...snap.counts }, { thumbs_up: 1 });
  assert.equal(snap.picks, 1);
});

test('nextEmojiFreq: the snapshot counts are null-prototype, like parseEmojiFreq\'s', () => {
  const snap = nextEmojiFreq(freqOf({}), 'toString');
  assert.equal(Object.getPrototypeOf(snap.counts), null);
  assert.equal(snap.counts.toString, 1);
});

test('nextEmojiFreq: decays exactly on the halflife boundary, not before', () => {
  // One short of the boundary: no halving.
  const just = nextEmojiFreq(freqOf({ a: 8 }, EMOJI_FREQ_HALFLIFE - 2), 'a');
  assert.equal(just.picks, EMOJI_FREQ_HALFLIFE - 1);
  assert.deepEqual({ ...just.counts }, { a: 9 });

  // On the boundary: everything halves (including the name just bumped) and
  // the counter resets.
  const hit = nextEmojiFreq(freqOf({ a: 8, b: 4 }, EMOJI_FREQ_HALFLIFE - 1), 'a');
  assert.equal(hit.picks, 0);
  assert.deepEqual({ ...hit.counts }, { a: 4.5, b: 2 });
});

test('nextEmojiFreq: decay prunes anything that falls under the floor', () => {
  const faint = EMOJI_FREQ_FLOOR * 1.5;      // halves to below the floor -> dropped
  const sturdy = EMOJI_FREQ_FLOOR * 2;       // halves to exactly the floor -> kept
  const freq = freqOf({ faint, sturdy }, EMOJI_FREQ_HALFLIFE - 1);
  const snap = nextEmojiFreq(freq, 'fresh');
  assert.deepEqual(Object.keys(snap.counts).sort(), ['fresh', 'sturdy']);
  assert.equal(snap.counts.sturdy, EMOJI_FREQ_FLOOR);
  assert.equal(snap.counts.fresh, 0.5);
  assert.ok(!('faint' in freq.counts), 'pruned from the live object too');
});

test('nextEmojiFreq: the stored snapshot keeps only the top EMOJI_FREQ_MAX, highest first', () => {
  const counts = {};
  for (let i = 0; i < EMOJI_FREQ_MAX + 25; i++) counts[`e${i}`] = i + 1; // e0 weakest
  const freq = freqOf(counts);
  const snap = nextEmojiFreq(freq, 'e0');
  const names = Object.keys(snap.counts);
  assert.equal(names.length, EMOJI_FREQ_MAX);
  assert.equal(names[0], `e${EMOJI_FREQ_MAX + 24}`, 'strongest first');
  assert.ok(!names.includes('e0'), 'the weakest is dropped from the snapshot');
  // The cap applies to what gets persisted, not to the in-memory ranking, which
  // keeps everything it had (plus nothing new — 'e0' was already present).
  assert.equal(Object.keys(freq.counts).length, EMOJI_FREQ_MAX + 25);
});

test('nextEmojiFreq: the snapshot survives a JSON round-trip back through parseEmojiFreq', () => {
  const snap = nextEmojiFreq(freqOf({ smile: 2 }, 5), 'wave');
  const back = parseEmojiFreq(JSON.stringify(snap));
  assert.deepEqual({ ...back.counts }, { smile: 2, wave: 1 });
  assert.equal(back.picks, 6);
});

// ---------- /gif ----------

test('parseGifCommand', () => {
  assert.equal(parseGifCommand('/gif'), '');
  assert.equal(parseGifCommand('/gif cat'), 'cat');
  assert.equal(parseGifCommand('/GIF Cat Party'), 'Cat Party');
  assert.equal(parseGifCommand('   /gif   cat  '), 'cat');
  assert.equal(parseGifCommand('/gif\tcat'), 'cat');
  // Not the command.
  assert.equal(parseGifCommand(''), null);
  assert.equal(parseGifCommand('gif cat'), null);
  assert.equal(parseGifCommand('a /gif cat'), null);   // must start the message
  assert.equal(parseGifCommand('/gifted a thing'), null); // word boundary
  assert.equal(parseGifCommand('/giphy cat'), null);
});

// ---------- auto-TLDR status map ----------

const mapOf = (n) => new Map(Array.from({ length: n }, (_, i) => [`c${i}`, i]));

test('evictOldestTldr: no-op at or under the cap', () => {
  const m = mapOf(3);
  evictOldestTldr(m, 3, null);
  assert.equal(m.size, 3);
  evictOldestTldr(m, 5, null);
  assert.equal(m.size, 3);
});

test('evictOldestTldr: drops the oldest, one per call', () => {
  const m = mapOf(6);
  evictOldestTldr(m, 4, null);
  assert.equal(m.size, 5);
  assert.ok(!m.has('c0'));
  assert.ok(m.has('c1'));
});

test('evictOldestTldr: skips the conversation on screen', () => {
  const m = mapOf(4);
  evictOldestTldr(m, 3, 'c0');
  assert.ok(m.has('c0'), 'the open chat is never the one evicted');
  assert.ok(!m.has('c1'));
  assert.equal(m.size, 3);
});

test('evictOldestTldr: an over-cap map holding only the active chat is left alone', () => {
  const m = new Map([['c0', 1]]);
  evictOldestTldr(m, 0, 'c0');
  assert.equal(m.size, 1);
});

// ---------- auto-TLDR error text ----------

test('retryErrorReason', () => {
  assert.equal(retryErrorReason('not-configured'), 'auto-TLDR is not configured');
  assert.equal(retryErrorReason('bad-url'), 'not a recognized YouTube link');
  assert.equal(retryErrorReason('Gemini timed out'), 'Gemini timed out');
  assert.equal(retryErrorReason(''), 'retry failed');
  assert.equal(retryErrorReason(undefined), 'retry failed');
});

// ---------- import guard ----------

const PUBLIC_DIR = path.join(here, '..', 'public');
const readPublic = (file) => readFile(path.join(PUBLIC_DIR, file), 'utf8');
// Comments are stripped before looking for a name, so prose about a function
// doesn't count as using it.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// app.js can't be imported here (it calls init(), which needs a DOM), so a
// mistyped import path would break the browser while `npm test` stayed green.
// Cheapest possible guard: every relative specifier in public/ must resolve.
test('every relative import in public/ resolves to a real file', async () => {
  const files = (await readdir(PUBLIC_DIR)).filter((f) => f.endsWith('.js'));
  assert.ok(files.includes('app.js'), 'sanity: found the frontend modules');
  for (const file of files) {
    const src = await readPublic(file);
    const specs = [...src.matchAll(/^\s*(?:import|export)[^'"]*from\s*['"](\.[^'"]+)['"]/gm)].map((m) => m[1]);
    for (const spec of specs) {
      const target = path.resolve(PUBLIC_DIR, spec);
      await assert.doesNotReject(readFile(target, 'utf8'), `${file} imports missing ${spec}`);
    }
  }
});

test('every name app.js imports from ui-logic.js is exported and referenced', async () => {
  const app = await readPublic('app.js');
  const block = /import\s*\{([^}]*)\}\s*from\s*['"]\.\/ui-logic\.js['"]/.exec(app);
  assert.ok(block, 'app.js must import from ./ui-logic.js');
  const imported = block[1].split(',').map((s) => s.trim()).filter(Boolean);
  assert.ok(imported.length > 0);
  const body = stripComments(app.slice(block.index + block[0].length));
  const mod = await import('../public/ui-logic.js');
  for (const name of imported) {
    assert.ok(Object.hasOwn(mod, name), `ui-logic.js does not export ${name}`);
    assert.match(body, new RegExp(`\\b${name}\\b`), `app.js imports ${name} but never references it`);
  }
});

// menuActionsFor emits action names that app.js looks up in its MENU_ACTIONS
// table. Nothing at runtime connects the two, so drift shows up as a missing
// menu entry in the browser — catch it here instead.
test('every action menuActionsFor can emit has a handler in app.js', async () => {
  const app = await readPublic('app.js');
  const table = /const MENU_ACTIONS = \{([\s\S]*?)\n\};/.exec(app);
  assert.ok(table, 'app.js must define MENU_ACTIONS');
  const handled = new Set([...table[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]));

  const emitted = new Set();
  for (const direction of ['outgoing', 'incoming', 'system', undefined]) {
    for (const text of ['hi', '', '   ', undefined]) {
      for (const deletedForEveryone of [true, false]) {
        for (const isViewOnce of [true, false]) {
          for (const a of menuActionsFor({ direction, text, deletedForEveryone, isViewOnce })) emitted.add(a);
        }
      }
    }
  }
  assert.ok(emitted.size > 0);
  for (const action of emitted) assert.ok(handled.has(action), `MENU_ACTIONS has no entry for '${action}'`);
});
