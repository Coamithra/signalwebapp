// Tests for the composer's formatting parser (public/format.js).
//
// Zero-dep: node's built-in runner (`npm test`). format.js is DOM-free apart
// from renderFormatted(), which isn't exercised here — the parse/serialize half
// is where the sharp edges are.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFormatting, toMarkdown, expandShortcodes, shortcodeBefore,
  shortcodeQueryBefore, matchShortcodes, STYLE,
} from '../public/format.js';

const { BOLD, ITALIC, SPOILER, STRIKETHROUGH, MONOSPACE } = STYLE;
const key = (ranges) => [...ranges].map((r) => `${r.start}:${r.length}:${r.style}`).sort();

function check(raw, expectedText, expectedRanges = []) {
  const got = parseFormatting(raw);
  assert.equal(got.text, expectedText, `text for ${JSON.stringify(raw)}`);
  assert.deepEqual(key(got.bodyRanges), key(expectedRanges), `ranges for ${JSON.stringify(raw)}`);
}

test('markers become style ranges and leave the text plain', () => {
  check('_pretty available_', 'pretty available', [{ start: 0, length: 16, style: ITALIC }]);
  check('*bold*', 'bold', [{ start: 0, length: 4, style: BOLD }]);
  check('~strike~', 'strike', [{ start: 0, length: 6, style: STRIKETHROUGH }]);
  check('`code()`', 'code()', [{ start: 0, length: 6, style: MONOSPACE }]);
  check('||secret||', 'secret', [{ start: 0, length: 6, style: SPOILER }]);
  check('**double** __double__', 'double double', [
    { start: 0, length: 6, style: BOLD },
    { start: 7, length: 6, style: ITALIC },
  ]);
});

test('styles nest', () => {
  check('*_both_*', 'both', [
    { start: 0, length: 4, style: BOLD },
    { start: 0, length: 4, style: ITALIC },
  ]);
  check('||a *bold* spoiler||', 'a bold spoiler', [
    { start: 0, length: 14, style: SPOILER },
    { start: 2, length: 4, style: BOLD },
  ]);
});

test('markers glued to words, or wrapping whitespace, are literal text', () => {
  check('snake_case_name stays plain', 'snake_case_name stays plain');
  check('2 * 3 * 4 = 24', '2 * 3 * 4 = 24');
  check('https://x.com/a_b_c', 'https://x.com/a_b_c');
  check('no closer _foo bar', 'no closer _foo bar');
  check('trailing _ underscore _ alone', 'trailing _ underscore _ alone');
});

test('monospace content is literal', () => {
  check('a `*not bold*` b', 'a *not bold* b', [{ start: 2, length: 10, style: MONOSPACE }]);
});

test('backslash escapes a marker or a shortcode', () => {
  check('escaped \\*literal\\* and \\:shrug:', 'escaped *literal* and :shrug:');
  check('C:\\Users\\me', 'C:\\Users\\me'); // a backslash before a non-marker stays put
});

test('shortcodes expand, including in pasted text', () => {
  check('so :shrug:', 'so 🤷');
  check(':not_a_code: :fire:', ':not_a_code: 🔥');
  assert.equal(expandShortcodes('a :+1: b'), 'a 👍 b');
});

test('shortcode lookups do not walk the prototype chain', () => {
  // A bare map[name] would splice in Object's constructor source / "[object Object]".
  assert.equal(expandShortcodes('a :constructor: b'), 'a :constructor: b');
  assert.equal(expandShortcodes('a :__proto__: b'), 'a :__proto__: b');
  assert.equal(expandShortcodes('a :toString: b'), 'a :toString: b');
  assert.equal(shortcodeBefore('x :constructor:', 15), null);
});

test('shortcodeBefore fires only on the just-closed shortcode', () => {
  assert.deepEqual(shortcodeBefore('so :shrug:', 10), { emoji: '🤷', start: 3, end: 10 });
  assert.equal(shortcodeBefore('so :shrug', 9), null);       // not closed yet
  assert.equal(shortcodeBefore('so :shrug: more', 15), null); // caret has moved on
  assert.equal(shortcodeBefore('so \\:shrug:', 11), null);    // escaped
  assert.equal(shortcodeBefore('so :nosuchemoji:', 16), null);
});

test('toMarkdown round-trips, and stays clean when escaping is unnecessary', () => {
  const roundTrips = [
    '_pretty available_', '*bold* and _italic_', '*_both_*', 'a `*not bold*` b',
    '||a *bold* spoiler||', 'plain text', 'so :shrug:', 'escaped \\*literal\\*',
  ];
  for (const raw of roundTrips) {
    const { text, bodyRanges } = parseFormatting(raw);
    const back = toMarkdown(text, bodyRanges);
    const re = parseFormatting(back);
    assert.equal(re.text, text, `text round-trip for ${JSON.stringify(raw)}`);
    assert.deepEqual(key(re.bodyRanges), key(bodyRanges), `range round-trip for ${JSON.stringify(raw)}`);
  }
  // Text that can't be misread doesn't get escape noise in the edit box.
  assert.equal(toMarkdown('snake_case_ok', []), 'snake_case_ok');
  assert.equal(toMarkdown('bold', [{ start: 0, length: 4, style: BOLD }]), '*bold*');
});

test('toMarkdown never rewrites the text, even for ranges our syntax cannot express', () => {
  // Signal's own composer can produce these; there's no marker placement that
  // survives a re-parse. Losing the styling is acceptable; corrupting what the
  // message SAYS is not.
  const crossing = { text: 'a b c', ranges: [
    { start: 0, length: 3, style: BOLD },
    { start: 2, length: 3, style: ITALIC },
  ] };
  const padded = { text: '  padded  ', ranges: [{ start: 0, length: 10, style: BOLD }] };

  for (const { text, ranges } of [crossing, padded]) {
    assert.equal(parseFormatting(toMarkdown(text, ranges)).text, text);
  }
});

test('a pathological pile of markers still sends the right text', () => {
  const raw = '*x* '.repeat(300);
  const { text, bodyRanges } = parseFormatting(raw);
  assert.equal(text, 'x '.repeat(300));       // markers consumed, never left in the body
  assert.ok(bodyRanges.length <= 250);        // ...but the range list stays bounded
});

// ---------- composer autocomplete (shortcodeQueryBefore / matchShortcodes) ----------

const BS = String.fromCharCode(92); // a literal backslash, unambiguously

test('shortcodeQueryBefore finds an OPEN run, and only where one belongs', () => {
  assert.deepEqual(shortcodeQueryBefore(':shr', 4), { query: 'shr', start: 0 });
  assert.deepEqual(shortcodeQueryBefore('hi :shr', 7), { query: 'shr', start: 3 });
  assert.deepEqual(shortcodeQueryBefore('(:shr', 5), { query: 'shr', start: 1 });
  assert.deepEqual(shortcodeQueryBefore(':SHR', 4), { query: 'shr', start: 0 }); // folded to lower case
  assert.deepEqual(shortcodeQueryBefore(':+1', 3), { query: '+1', start: 0 });   // "+" and "-" are shortcode chars

  // The caret is a position, not "the end of the string".
  assert.deepEqual(shortcodeQueryBefore(':shrug: x', 3), { query: 'sh', start: 0 });
  assert.equal(shortcodeQueryBefore('hi :shr', 3), null); // caret sits ON the ":"

  assert.equal(shortcodeQueryBefore(BS + ':shr', 5), null);   // escaped -> the user meant it literally
  assert.equal(shortcodeQueryBefore('http://xy', 9), null);   // ":" glued to a word
  assert.equal(shortcodeQueryBefore('at 12:30', 8), null);    // ...digits count as word chars
  assert.equal(shortcodeQueryBefore('::shr', 5), null);       // ":" after ":"
  assert.equal(shortcodeQueryBefore(':s', 2), null);          // one char is not a query
  assert.equal(shortcodeQueryBefore(':sh rug', 7), null);     // whitespace ends the run
  assert.equal(shortcodeQueryBefore('', 0), null);
});

test('matchShortcodes ranks exact, then prefix, then substring', () => {
  const names = (q, ...rest) => matchShortcodes(q, ...rest).map((m) => m.name);

  assert.deepEqual(names('shrug').slice(0, 1), ['shrug']);          // exact wins outright
  const shr = names('shr');
  assert.deepEqual(shr.slice(0, 2), ['shrug', 'shrimp']);           // prefix, shorter first
  assert.ok(shr.indexOf('mushroom') > shr.indexOf('shrimp'));       // substring ranks below prefix

  // The unguessable-name case this whole feature exists for.
  assert.ok(names('up', 100).includes('thumbs_up'));
  assert.deepEqual(names('+1'), ['+1']);

  assert.deepEqual(matchShortcodes(''), []);
  assert.deepEqual(matchShortcodes('zzzznotathing'), []);
  assert.equal(matchShortcodes('a').length, 8);                     // the hard cap
  assert.equal(matchShortcodes('a', 3).length, 3);
  for (const m of matchShortcodes('shr')) assert.equal(typeof m.emoji, 'string');
});

test('pick weights break ties WITHIN a tier, never across one', () => {
  // A favourite outranks its siblings...
  assert.deepEqual(matchShortcodes('shr', 8, { shrimp: 9 }).map((m) => m.name).slice(0, 2),
    ['shrimp', 'shrug']);

  // ...but never jumps a whole tier: a substring match stays below every prefix
  // match no matter how often it's been picked. This is the invariant that keeps
  // the list predictable.
  const heavy = matchShortcodes('shr', 8, { mushroom: 9999 }).map((m) => m.name);
  assert.deepEqual(heavy.slice(0, 2), ['shrug', 'shrimp']);
  assert.ok(heavy.indexOf('mushroom') > heavy.indexOf('shrimp'));
});

test('hand-edited weights cannot poison the ranking', () => {
  // sb.emojiFreq is localStorage: a user can put anything in it.
  const clean = matchShortcodes('shr').map((m) => m.name);
  for (const junk of [
    { __proto__: 500 }, { constructor: 500 }, { shrug: 'lots' },
    { shrug: NaN }, { shrug: null }, { toString: 500 },
  ]) {
    assert.deepEqual(matchShortcodes('shr', 8, junk).map((m) => m.name), clean);
  }
  // ...and no prototype key can smuggle a non-emoji into the results.
  for (const m of matchShortcodes('constructor')) assert.equal(typeof m.emoji, 'string');
});
