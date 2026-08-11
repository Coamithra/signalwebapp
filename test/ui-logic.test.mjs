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
  parseGifCommand, evictOldestTldr, retryErrorReason, tldrBubble, tldrHint,
  jumbomojiSize, jumboSizeFor, JUMBO_MAX_EMOJI,
  hasLink, safeHttpUrl, previewDomain,
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

// Counts are keyed by emoji, not by the shortcode picked to get there.
const empty = (freq) => {
  assert.deepEqual({ ...freq.counts }, {});
  assert.equal(freq.picks, 0);
  assert.equal(freq.migrated, false);
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
      '😀': 3, '👍': 0.5,
      zero: 0, negative: -2, str: '5', nan: null, obj: {}, arr: [],
    },
    picks: 7,
  });
  const { counts, picks } = parseEmojiFreq(raw);
  assert.deepEqual({ ...counts }, { '😀': 3, '👍': 0.5 });
  assert.equal(picks, 7);
});

// ---------- emoji frequency: migrating the old name-keyed counts ----------

// Stands in for format.js's emojiForShortcode: resolves a shortcode, and
// returns undefined for anything else (including an emoji, which is never a
// shortcode — that invariant is what makes the migration idempotent).
const NAMES = { hankey: '💩', poop: '💩', thumbsup: '👍' };
const lookup = (name) => (Object.hasOwn(NAMES, name) ? NAMES[name] : undefined);

// A deliberately sloppy one, to prove the parse doesn't trust what it's handed:
// a bare lookup walks the prototype chain and answers "toString" with a function.
const sloppyLookup = (name) => NAMES[name];

test('parseEmojiFreq: old name-keyed counts are re-keyed to the emoji', () => {
  const freq = parseEmojiFreq('{"counts":{"thumbsup":4},"picks":9}', lookup);
  assert.deepEqual({ ...freq.counts }, { '👍': 4 });
  assert.equal(freq.picks, 9, 'the decay counter is not disturbed');
  assert.ok(freq.migrated);
});

test('parseEmojiFreq: names that share an emoji have their scores summed', () => {
  // The whole point of the card: picks split across :hankey:/:poop: are one
  // emoji's worth of favouritism, not two half-hearted ones.
  const { counts } = parseEmojiFreq('{"counts":{"hankey":3,"poop":2}}', lookup);
  assert.deepEqual({ ...counts }, { '💩': 5 });
});

test('parseEmojiFreq: migration is idempotent — a second pass changes nothing', () => {
  const once = parseEmojiFreq('{"counts":{"hankey":3,"poop":2},"picks":9}', lookup);
  const twice = parseEmojiFreq(JSON.stringify(once), lookup);
  assert.deepEqual({ ...twice.counts }, { ...once.counts });
  assert.equal(twice.picks, 9);
  assert.equal(twice.migrated, false, 'nothing left to convert -> no re-write');
});

test('parseEmojiFreq: keys the lookup cannot resolve are left alone', () => {
  // Already-emoji keys and a stale/hand-edited name both fall here: neither is
  // dropped, and neither counts as a migration.
  const freq = parseEmojiFreq('{"counts":{"👍":2,"no_such_shortcode":1}}', lookup);
  assert.deepEqual({ ...freq.counts }, { '👍': 2, no_such_shortcode: 1 });
  assert.equal(freq.migrated, false);
});

test('parseEmojiFreq: without a lookup nothing is migrated', () => {
  const freq = parseEmojiFreq('{"counts":{"hankey":3}}');
  assert.deepEqual({ ...freq.counts }, { hankey: 3 });
  assert.equal(freq.migrated, false);
});

test('parseEmojiFreq: migration keeps the junk filter and the null prototype', () => {
  const freq = parseEmojiFreq('{"counts":{"poop":"lots","hankey":2,"toString":3}}', lookup);
  assert.equal(Object.getPrototypeOf(freq.counts), null);
  assert.deepEqual({ ...freq.counts }, { '💩': 2, toString: 3 });
});

test('parseEmojiFreq: only a string from the lookup is used as a key', () => {
  const freq = parseEmojiFreq('{"counts":{"hankey":2,"toString":3}}', sloppyLookup);
  assert.deepEqual({ ...freq.counts }, { '💩': 2, toString: 3 });
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

test('nextEmojiFreq: bumps the picked emoji and advances picks', () => {
  const freq = freqOf({ '😀': 2 }, 3);
  const snap = nextEmojiFreq(freq, '😀');
  assert.equal(snap.picks, 4);
  assert.deepEqual({ ...snap.counts }, { '😀': 3 });
  // counts is mutated in place: the live ranking must see the new score without
  // a reload. picks deliberately is NOT — the caller writes that back.
  assert.equal(freq.counts['😀'], 3);
  assert.equal(freq.picks, 3);
});

test('nextEmojiFreq: a new emoji starts at 1', () => {
  const snap = nextEmojiFreq(freqOf({}), '👍');
  assert.deepEqual({ ...snap.counts }, { '👍': 1 });
  assert.equal(snap.picks, 1);
});

test('nextEmojiFreq: every shortcode for one emoji feeds the same score', () => {
  // :hankey: then :poop: is two picks of 💩, not one each of two spellings —
  // app.js passes the row's emoji, whichever name it happened to be listed under.
  const freq = freqOf({});
  nextEmojiFreq(freq, '💩');
  const snap = nextEmojiFreq(freq, '💩');
  assert.deepEqual({ ...snap.counts }, { '💩': 2 });
});

test('nextEmojiFreq: the snapshot counts are null-prototype, like parseEmojiFreq\'s', () => {
  const snap = nextEmojiFreq(freqOf({}), 'toString');
  assert.equal(Object.getPrototypeOf(snap.counts), null);
  assert.equal(snap.counts.toString, 1);
});

test('nextEmojiFreq: decays exactly on the halflife boundary, not before', () => {
  // One short of the boundary: no halving.
  const just = nextEmojiFreq(freqOf({ '😀': 8 }, EMOJI_FREQ_HALFLIFE - 2), '😀');
  assert.equal(just.picks, EMOJI_FREQ_HALFLIFE - 1);
  assert.deepEqual({ ...just.counts }, { '😀': 9 });

  // On the boundary: everything halves (including the emoji just bumped) and
  // the counter resets.
  const hit = nextEmojiFreq(freqOf({ '😀': 8, '👍': 4 }, EMOJI_FREQ_HALFLIFE - 1), '😀');
  assert.equal(hit.picks, 0);
  assert.deepEqual({ ...hit.counts }, { '😀': 4.5, '👍': 2 });
});

test('nextEmojiFreq: decay prunes anything that falls under the floor', () => {
  const faint = EMOJI_FREQ_FLOOR * 1.5;      // halves to below the floor -> dropped
  const sturdy = EMOJI_FREQ_FLOOR * 2;       // halves to exactly the floor -> kept
  const freq = freqOf({ '😀': faint, '👍': sturdy }, EMOJI_FREQ_HALFLIFE - 1);
  const snap = nextEmojiFreq(freq, '🎉');
  assert.deepEqual(Object.keys(snap.counts).sort(), ['🎉', '👍'].sort());
  assert.equal(snap.counts['👍'], EMOJI_FREQ_FLOOR);
  assert.equal(snap.counts['🎉'], 0.5);
  assert.ok(!('😀' in freq.counts), 'pruned from the live object too');
});

test('nextEmojiFreq: the stored snapshot keeps only the top EMOJI_FREQ_MAX, highest first', () => {
  const counts = {};
  // Synthetic keys: the cap doesn't care what a key is, only how many there are.
  for (let i = 0; i < EMOJI_FREQ_MAX + 25; i++) counts[`e${i}`] = i + 1; // e0 weakest
  const freq = freqOf(counts);
  const snap = nextEmojiFreq(freq, 'e0');
  const keys = Object.keys(snap.counts);
  assert.equal(keys.length, EMOJI_FREQ_MAX);
  assert.equal(keys[0], `e${EMOJI_FREQ_MAX + 24}`, 'strongest first');
  assert.ok(!keys.includes('e0'), 'the weakest is dropped from the snapshot');
  // The cap applies to what gets persisted, not to the in-memory ranking, which
  // keeps everything it had (plus nothing new — 'e0' was already present).
  assert.equal(Object.keys(freq.counts).length, EMOJI_FREQ_MAX + 25);
});

test('nextEmojiFreq: the snapshot survives a JSON round-trip back through parseEmojiFreq', () => {
  const snap = nextEmojiFreq(freqOf({ '😀': 2 }, 5), '👋');
  const back = parseEmojiFreq(JSON.stringify(snap), lookup);
  assert.deepEqual({ ...back.counts }, { '😀': 2, '👋': 1 });
  assert.equal(back.picks, 6);
  assert.equal(back.migrated, false, 'a freshly written snapshot needs no conversion');
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
  assert.equal(retryErrorReason('Claude usage limit reached'), 'Claude usage limit reached');
  assert.equal(retryErrorReason(''), 'retry failed');
  assert.equal(retryErrorReason(undefined), 'retry failed');
});

// ---------- auto-TLDR status bubble model ----------

test('tldrBubble: working stages are work-toned, with no buttons', () => {
  for (const stage of ['fetching', 'summarizing', 'researching']) {
    const b = tldrBubble(stage, undefined);
    assert.equal(b.tone, 'work', stage);
    assert.equal(b.retry, false, stage);
    assert.equal(b.dismiss, false, stage);
    assert.ok(b.label.length > 0, stage);
  }
  // An unknown stage (a newer server) still renders as generic work, not a crash.
  assert.equal(tldrBubble('someday-a-new-stage', undefined).tone, 'work');
});

test('tldrBubble: retrying folds the reason into the label', () => {
  assert.ok(tldrBubble('retrying', 'timed out').label.includes('timed out'));
  assert.ok(!tldrBubble('retrying', undefined).label.includes('undefined'));
});

test('tldrBubble: failed warns and offers Retry + dismiss', () => {
  const b = tldrBubble('failed', 'no transcript available');
  assert.equal(b.tone, 'warn');
  assert.equal(b.retry, true);
  assert.equal(b.dismiss, true);
  assert.ok(b.label.includes('no transcript available'));
});

test('tldrBubble: done-with-reason is the quiet sent-without-context notice', () => {
  const b = tldrBubble('done', 'research timed out');
  assert.equal(b.tone, 'info'); // quieter than failed: the TLDR itself made it out
  assert.equal(b.dismiss, true);
  // Never a Retry: the summary is already in the chat, a retry would duplicate it.
  assert.equal(b.retry, false);
  assert.ok(b.label.includes('research timed out'));
  assert.ok(b.label.includes('For context'));
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

// ---------- jumbomoji ----------
// Emoji-only messages render big and bubble-less. The sizes are Signal
// Desktop's own ladder, so a message looks the same in both apps.

test('jumbomojiSize follows Signal\'s size ladder by emoji count', () => {
  assert.equal(jumbomojiSize('\u{1F600}'), 56);
  assert.equal(jumbomojiSize('\u{1F600}\u{1F600}'), 48);
  assert.equal(jumbomojiSize('\u{1F600}\u{1F600}\u{1F600}'), 40);
  assert.equal(jumbomojiSize('\u{1F600}\u{1F600}\u{1F600}\u{1F600}'), 36);
  assert.equal(jumbomojiSize('\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}'), 32);
});

test('jumbomojiSize gives up past the cap', () => {
  const over = '\u{1F600}'.repeat(JUMBO_MAX_EMOJI + 1);
  assert.equal(jumbomojiSize(over), null);
  assert.equal(jumbomojiSize('\u{1F600}'.repeat(50)), null);
});

test('jumbomojiSize ignores whitespace but not other text', () => {
  assert.equal(jumbomojiSize('  \u{1F44D}\n '), 56);       // padding doesn't count
  assert.equal(jumbomojiSize('\u{1F44D} \u{1F44D}'), 48);  // separator doesn't count
  assert.equal(jumbomojiSize('ok \u{1F44D}'), null);       // mixed text
  assert.equal(jumbomojiSize('\u{1F44D}!'), null);         // trailing punctuation
  assert.equal(jumbomojiSize('\u{1F44D}.'), null);
});

// The whole reason for the `v` flag: these are multi-code-point sequences that
// a naive per-character scan would miscount (a ZWJ family as four people, a
// flag as two letters), which would push them over the cap and lose the jumbo.
test('jumbomojiSize counts multi-code-point emoji as one', () => {
  assert.equal(jumbomojiSize('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'), 56); // ZWJ family
  assert.equal(jumbomojiSize('\u{1F1F3}\u{1F1F1}'), 56);        // flag
  assert.equal(jumbomojiSize('1\uFE0F\u20E3'), 56);             // keycap
  assert.equal(jumbomojiSize('\u{1F44D}\u{1F3FD}'), 56);        // skin tone modifier
  assert.equal(jumbomojiSize('\u{1F44D}\u{1F3FD}\u{1F44D}\u{1F3FF}'), 48);
});

// RGI excludes emoji written without U+FE0F, but clients still send them, so
// the bare pictographic forms have to jumbo too — without dragging in digits
// or '#'/'*', which carry Emoji=Yes but are plainly text.
test('jumbomojiSize accepts bare pictographic emoji, not digits or symbols', () => {
  assert.equal(jumbomojiSize('\u2764\uFE0F'), 56); // heart with VS16
  assert.equal(jumbomojiSize('\u2764'), 56);       // heart without
  assert.equal(jumbomojiSize('\u263A'), 56);
  assert.equal(jumbomojiSize('1'), null);
  assert.equal(jumbomojiSize('#'), null);
  assert.equal(jumbomojiSize('*'), null);
  assert.equal(jumbomojiSize('123'), null);
});

test('jumbomojiSize returns null for anything without emoji', () => {
  for (const v of ['', '   ', '\n', 'hello', null, undefined, 42, {}]) {
    assert.equal(jumbomojiSize(v), null, `expected null for ${JSON.stringify(v)}`);
  }
});

// Regex state bug insurance: the matcher is /g/, so a shared instance would
// carry lastIndex between calls and make results depend on call order.
test('jumbomojiSize is not order-dependent', () => {
  assert.equal(jumbomojiSize('\u{1F600}\u{1F600}\u{1F600}'), 40);
  assert.equal(jumbomojiSize('\u{1F600}'), 56);
  assert.equal(jumbomojiSize('\u{1F600}'), 56);
  assert.equal(jumbomojiSize('\u{1F600}\u{1F600}\u{1F600}'), 40);
});

// The typographic pictographs: Extended_Pictographic, but plainly text when
// written bare. Their U+FE0F forms are genuine emoji and must still jumbo.
test('jumbomojiSize treats bare (c)/(R)/TM/!!/!? as text, not emoji', () => {
  for (const ch of ['\u00A9', '\u00AE', '\u2122', '\u203C', '\u2049']) {
    assert.equal(jumbomojiSize(ch), null, `bare ${JSON.stringify(ch)} must not jumbo`);
    assert.equal(jumbomojiSize(ch + '\uFE0F'), 56, `${JSON.stringify(ch)} + VS16 is a real emoji`);
  }
});

// A lone U+FE0F outrides the sequence it belonged to on copy-paste. It is not
// a glyph, so it must not disqualify the message or count as an emoji.
test('jumbomojiSize skips a stray variation selector', () => {
  assert.equal(jumbomojiSize('\u{1F600}\uFE0F'), 56);
  assert.equal(jumbomojiSize('\uFE0F'), null); // nothing but the selector
});

// ---------- jumbomoji: the veto ----------
// Signal refuses jumbomoji when the message carries anything besides the emoji.

test('jumboSizeFor passes plain emoji-only messages through', () => {
  assert.equal(jumboSizeFor({ text: '\u{1F44D}' }), 56);
  assert.equal(jumboSizeFor({ text: '\u{1F44D}', attachments: [], bodyRanges: [] }), 56);
  assert.equal(jumboSizeFor({ text: 'hello' }), null);
});

test('jumboSizeFor vetoes media, view-once and formatted messages', () => {
  const emoji = '\u{1F44D}';
  assert.equal(jumboSizeFor({ text: emoji, attachments: [{ contentType: 'image/png' }] }), null);
  assert.equal(jumboSizeFor({ text: emoji, isViewOnce: true }), null);
  // bodyRanges is the one that matters most: a spoilered emoji blown up to 56px
  // would defeat the spoiler, and Signal keeps it an ordinary message too.
  assert.equal(jumboSizeFor({ text: emoji, bodyRanges: [{ start: 0, length: 2, style: 3 }] }), null);
  assert.equal(jumboSizeFor({ text: emoji, bodyRanges: [{ start: 0, length: 2, style: 1 }] }), null);
});

test('jumboSizeFor vetoes a message carrying a link preview card', () => {
  // A card under the emoji makes it an ordinary message, same as media does —
  // and Signal's own predicate vetoes on link previews too.
  const emoji = '\u{1F44D}';
  assert.equal(jumboSizeFor({ text: emoji, preview: [{ url: 'https://example.com', title: 'Hi' }] }), null);
  assert.equal(jumboSizeFor({ text: emoji, preview: [] }), 56);
});

test('jumboSizeFor survives a missing or empty message', () => {
  assert.equal(jumboSizeFor(null), null);
  assert.equal(jumboSizeFor(undefined), null);
  assert.equal(jumboSizeFor({}), null);
});

// ---------- link preview cards ----------

test('hasLink spots a URL worth warming a preview for', () => {
  assert.equal(hasLink('look at https://example.com/x'), true);
  assert.equal(hasLink('HTTPS://EXAMPLE.COM'), true);
  assert.equal(hasLink('https://a'), true);
  assert.equal(hasLink('no link here'), false);
  // https only: Signal's shouldPreviewHref rejects everything else, so warming
  // for one of these would wait out the send's poll for nothing.
  assert.equal(hasLink('http://a'), false);
  assert.equal(hasLink('go to http://neverssl.com now'), false);
  assert.equal(hasLink('example.com'), false);
  assert.equal(hasLink('https://'), false);         // scheme with nothing after it
  // The false-positive class a bare-domain gate would have reintroduced.
  assert.equal(hasLink('config.js'), false);
  assert.equal(hasLink('e.g. node.js'), false);
  assert.equal(hasLink('the file README.md is fine'), false);
  assert.equal(hasLink('just some ordinary prose, nothing to fetch'), false);
  assert.equal(hasLink(''), false);
  assert.equal(hasLink(null), false);
  assert.equal(hasLink(undefined), false);
});

test('safeHttpUrl passes http(s) through and rejects everything else', () => {
  assert.equal(safeHttpUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeHttpUrl('http://example.com'), 'http://example.com');
  // The href comes off a received message, so these are the ones that matter.
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpUrl('JavaScript:alert(1)'), null);
  assert.equal(safeHttpUrl('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(safeHttpUrl('vbscript:msgbox'), null);
  assert.equal(safeHttpUrl('file:///C:/windows'), null);
  assert.equal(safeHttpUrl('//evil.com'), null);    // protocol-relative: not absolute, not parseable
  assert.equal(safeHttpUrl('not a url'), null);
  assert.equal(safeHttpUrl(''), null);
  assert.equal(safeHttpUrl(null), null);
});

test('previewDomain reduces a url to the domain line on the card', () => {
  assert.equal(previewDomain('https://www.bbc.co.uk/news'), 'bbc.co.uk');
  assert.equal(previewDomain('https://youtube.com/watch?v=x'), 'youtube.com');
  assert.equal(previewDomain('https://WWW.Example.COM/a'), 'example.com');
  assert.equal(previewDomain('http://sub.www.example.com'), 'sub.www.example.com'); // only a LEADING www. goes
  assert.equal(previewDomain('garbage'), null);
  assert.equal(previewDomain(null), null);
});

// ---------- auto-TLDR thread-menu hint ----------
//
// The hint used to promise "on the server's PATH, logged in" unconditionally,
// which was unverified: --version cannot prove login. It now names whichever of
// the two the server actually observed failing.

test('tldrHint: a working CLI gets the note, not a hint', () => {
  const h = tldrHint({ enabled: true, configured: true });
  assert.equal(h.note, 'YouTube links you post here get a short auto-summary.');
  assert.equal(h.before, undefined);
  // configured wins even if a stale reason rides along
  assert.ok(tldrHint({ configured: true, reason: 'auth' }).note);
});

test('tldrHint: names the specific failure when the server diagnosed one', () => {
  const auth = tldrHint({ configured: false, reason: 'auth' });
  assert.equal(auth.code, 'claude');
  assert.match(auth.after, /not logged in/);
  assert.equal(auth.note, undefined);
  const missing = tldrHint({ configured: false, reason: 'not-found' });
  assert.equal(missing.code, 'claude');
  assert.match(missing.after, /not found/);
});

test('tldrHint: undiagnosed falls back to naming both requirements', () => {
  // The boot state (probe failed before any run) and the fetch-failed fallback
  // in app.js both land here, so neither may guess at a specific cause.
  for (const data of [{ configured: false }, { configured: false, reason: null }, {}, undefined]) {
    const h = tldrHint(data);
    assert.equal(h.code, 'claude');
    assert.match(h.after, /PATH, logged in/);
  }
});
