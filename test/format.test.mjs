// Tests for the composer's formatting parser (public/format.js).
//
// Zero-dep: node's built-in runner (`npm test`). format.js is DOM-free apart
// from renderFormatted(), which the linkification tests at the bottom reach
// through a ~30-line fake `document` — enough of the DOM to build a tree and
// serialize it, and nothing more.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFormatting, toMarkdown, expandShortcodes, shortcodeBefore,
  shortcodeQueryBefore, matchShortcodes, linkSpans, renderFormatted, STYLE,
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

  // The unguessable-name case this whole feature exists for. Asserted on the
  // emoji, not the name: 👍 answers to several ("+1", "thumbsup", "thumbs_up")
  // and the dedupe below picks one of them for the row.
  assert.ok(matchShortcodes('up', 100).some((m) => m.emoji === '👍'));
  assert.deepEqual(names('+1'), ['+1']);

  assert.deepEqual(matchShortcodes(''), []);
  assert.deepEqual(matchShortcodes('zzzznotathing'), []);
  assert.equal(matchShortcodes('a').length, 8);                     // the hard cap
  assert.equal(matchShortcodes('a', 3).length, 3);
  for (const m of matchShortcodes('shr')) assert.equal(typeof m.emoji, 'string');
});

test('pick weights break ties WITHIN a tier, never across one', () => {
  // Weights are keyed by the EMOJI, not the shortcode. A favourite outranks its
  // siblings...
  assert.deepEqual(matchShortcodes('shr', 8, { '🦐': 9 }).map((m) => m.name).slice(0, 2),
    ['shrimp', 'shrug']);

  // ...but never jumps a whole tier: a substring match stays below every prefix
  // match no matter how often it's been picked. This is the invariant that keeps
  // the list predictable.
  const heavy = matchShortcodes('shr', 8, { '🍄': 9999 }).map((m) => m.name);
  assert.deepEqual(heavy.slice(0, 2), ['shrug', 'shrimp']);
  assert.ok(heavy.indexOf('mushroom') > heavy.indexOf('shrimp'));
});

test('a weight follows the emoji, not the spelling that earned it', () => {
  // The card's bug: 👍 is listed as ":thumbsup:" for one query and ":thumbs_up:"
  // for another, so counting picks per shortcode split them. One score, keyed by
  // the glyph, lifts it under every spelling — and a shortcode key does nothing.
  // (Still only within its tier — ":up" reaches 👍 by substring, so it climbs
  // past the other substring hits and stops under the prefix ones.)
  const rank = (weights) => matchShortcodes('up', 100, weights).findIndex((m) => m.emoji === '👍');
  const flat = rank({});
  assert.ok(flat > 0, 'needs something above it to climb past');
  assert.ok(rank({ '👍': 9999 }) < flat, 'the emoji weight lifts it whatever name the row uses');
  assert.equal(rank({ thumbsup: 9999, thumbs_up: 9999, '+1': 9999 }), flat, 'name keys rank nothing');
});

test('synonyms find an emoji whose name shares no letters with the query', () => {
  const names = (q, ...rest) => matchShortcodes(q, ...rest).map((m) => m.name);

  // The card's case: Signal calls it "cook", people call it a chef.
  const chef = matchShortcodes('chef');
  assert.equal(chef[0].name, 'cook');
  assert.equal(chef[0].emoji, '🧑‍🍳');
  assert.equal(chef[0].tag, 'chef');            // the row can say why it's here
  assert.ok(chef.some((m) => m.name === 'hocho')); // 🔪 is tagged "chef" too

  // A tag hit never appears with a name it would have matched anyway.
  assert.ok(matchShortcodes('cook').every((m) => m.tag === undefined || !m.name.includes('cook')));

  // Signal's own alternate shortcodes come along as real shortcodes, so these
  // expand as well as autocomplete.
  assert.equal(expandShortcodes(':poop:'), '💩');
  assert.equal(expandShortcodes(':satisfied:'), '😆');
  assert.deepEqual(names('poop').slice(0, 1), ['poop']);
});

test('a synonym never outranks a real name match', () => {
  // "cook" is a name (tier 0-2) and also a tag on 🔪/👨‍🍳; every name hit sorts
  // above every tag hit, whatever the tag's own quality.
  const cook = matchShortcodes('cook', 100);
  const firstTag = cook.findIndex((m) => m.tag !== undefined);
  const lastName = cook.map((m) => m.tag === undefined).lastIndexOf(true);
  assert.ok(firstTag > lastName, 'tags must all sort below names');

  // Not even a heavily-picked favourite can lift a tag over a name.
  const weighted = matchShortcodes('cook', 100, { '🔪': 9999 });
  assert.ok(weighted.findIndex((m) => m.name === 'hocho') > weighted.map((m) => m.tag === undefined).lastIndexOf(true));

  // Within the tag tier the same exact -> prefix -> substring ladder applies.
  const bin = matchShortcodes('trash', 100).filter((m) => m.tag);
  assert.deepEqual(bin.map((m) => m.tag === 'trash').slice(0, 1), [true]);
});

test('one emoji, one row — however many names and tags reach it', () => {
  for (const q of ['thumb', 'poo', 'cook', 'a', 'face', 'chef']) {
    const emoji = matchShortcodes(q, 100).map((m) => m.emoji);
    assert.equal(new Set(emoji).size, emoji.length, `duplicate emoji for ":${q}"`);
  }
  // The cap counts rows, so a full list is 8 *different* emoji.
  assert.equal(new Set(matchShortcodes('a').map((m) => m.emoji)).size, 8);
});

test('hand-edited weights cannot poison the ranking', () => {
  // sb.emojiFreq is localStorage: a user can put anything in it.
  const clean = matchShortcodes('shr').map((m) => m.name);
  for (const junk of [
    { __proto__: 500 }, { constructor: 500 }, { '🤷': 'lots' },
    { '🤷': NaN }, { '🤷': null }, { toString: 500 },
  ]) {
    assert.deepEqual(matchShortcodes('shr', 8, junk).map((m) => m.name), clean);
  }
  // ...and no prototype key can smuggle a non-emoji into the results.
  for (const m of matchShortcodes('constructor')) assert.equal(typeof m.emoji, 'string');
});

// ---------- links ----------

test('linkSpans finds schemes, www and bare domains', () => {
  const spans = (t) => linkSpans(t).map((l) => [t.slice(l.start, l.start + l.length), l.href]);

  assert.deepEqual(spans('see https://example.com/a?b=1 ok'),
    [['https://example.com/a?b=1', 'https://example.com/a?b=1']]);
  // http is fine for clicking, unlike the https-only *preview* gate.
  assert.deepEqual(spans('http://example.com'), [['http://example.com', 'http://example.com']]);
  // A bare host gets https:// — nearly everything redirects there anyway.
  assert.deepEqual(spans('example.com'), [['example.com', 'https://example.com']]);
  assert.deepEqual(spans('www.example.co.uk/x'), [['www.example.co.uk/x', 'https://www.example.co.uk/x']]);
  assert.deepEqual(spans('t.me/somechannel'), [['t.me/somechannel', 'https://t.me/somechannel']]);
  // Every auto-TLDR posts one of these, defanged of its scheme (see tldr.js).
  assert.deepEqual(spans('youtu.be/k_tmCRzNbhk'), [['youtu.be/k_tmCRzNbhk', 'https://youtu.be/k_tmCRzNbhk']]);
  assert.deepEqual(spans('EXAMPLE.COM/A'), [['EXAMPLE.COM/A', 'https://EXAMPLE.COM/A']]);
  assert.deepEqual(spans('a.com and b.org'), [['a.com', 'https://a.com'], ['b.org', 'https://b.org']]);
  assert.deepEqual(spans('port example.com:8080/x'), [['example.com:8080/x', 'https://example.com:8080/x']]);
  assert.deepEqual(spans(''), []);
  assert.deepEqual(linkSpans(null), []);
});

test('linkSpans leaves the punctuation around a url alone', () => {
  const text = (t) => linkSpans(t).map((l) => t.slice(l.start, l.start + l.length));

  assert.deepEqual(text('go to https://example.com.'), ['https://example.com']);
  assert.deepEqual(text('really, example.com!'), ['example.com']);
  assert.deepEqual(text('"https://example.com"'), ['https://example.com']);
  assert.deepEqual(text('(see https://example.com)'), ['https://example.com']);
  // ...but a bracket the url opened itself is part of it.
  assert.deepEqual(text('https://en.wikipedia.org/wiki/Signal_(software)'),
    ['https://en.wikipedia.org/wiki/Signal_(software)']);
  assert.deepEqual(text('(https://en.wikipedia.org/wiki/Signal_(software))'),
    ['https://en.wikipedia.org/wiki/Signal_(software)']);
});

test('linkSpans does not linkify things that merely look like hosts', () => {
  for (const t of [
    'mail me at bob@example.com',        // email local part
    'mailto:bob@example.com',
    String.raw`C:\Users\bob\setup.com`, // Windows path
    'run reboot.sh please',              // file extensions that aren't TLDs
    'see README.md and app.js',
    'version v1.2.3 shipped',
    'javascript:alert(1)',
    'sure.it works',                     // English-word TLDs are off the list
    'wait.no really',
    'ping me.at home',
    'the store.shop was closed',
    'example.company is a word',
    'webpack.dev.js and index.co.jsx',   // a bare host can't be followed by another label
  ]) assert.deepEqual(linkSpans(t), [], `linkified ${JSON.stringify(t)}`);
});

test('linkSpans stays fast on a pathological body', () => {
  // Message bodies are attacker-shaped and this runs per row on every render:
  // an ambiguous host pattern attempted at every index of a long unbroken run
  // used to cost seconds.
  const started = process.hrtime.bigint();
  assert.deepEqual(linkSpans('a'.repeat(50_000)), []);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 500, `50k chars took ${ms.toFixed(0)}ms`);
});

// The smallest DOM that renderFormatted needs: it only ever calls
// createElement / createTextNode / createDocumentFragment and appendChild.
function makeEl(tag) {
  const node = {
    tag, nodeType: 1, className: '', children: [], attrs: {},
    appendChild(child) { node.children.push(child); return child; },
    setAttribute(k, v) { node.attrs[k] = String(v); },
    addEventListener() {},
    classList: { add(c) { node.className = node.className ? `${node.className} ${c}` : c; } },
  };
  return node;
}
globalThis.document = {
  createElement: makeEl,
  createTextNode: (text) => ({ nodeType: 3, text }),
  createDocumentFragment: () => makeEl('#fragment'),
};

function serialize(node) {
  if (node.nodeType === 3) return node.text;
  const kids = node.children.map(serialize).join('');
  if (node.tag === '#fragment') return kids;
  const attrs = [];
  if (node.className) attrs.push(`class="${node.className}"`);
  if (node.tag === 'a') attrs.push(`href="${node.href}"`, `target="${node.target}"`, `rel="${node.rel}"`);
  return `<${node.tag}${attrs.map((a) => ` ${a}`).join('')}>${kids}</${node.tag}>`;
}
const render = (text, ranges) => serialize(renderFormatted(text, ranges));
const A = (href, inner = href) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${inner}</a>`;

test('renderFormatted turns urls into new-tab anchors', () => {
  assert.equal(render('go to https://example.com now'),
    `go to ${A('https://example.com')} now`);
  assert.equal(render('example.com'), A('https://example.com', 'example.com'));
  // Nothing to link: the plain-text path is untouched.
  assert.equal(render('just words'), 'just words');
  assert.equal(render(''), '');
  assert.equal(render('🎉🎉'), '🎉🎉');  // the jumbomoji path has no links to find
});

test('a style range around a link nests inside it, not through it', () => {
  const url = 'https://example.com';
  // Bold covering the whole link.
  assert.equal(render(url, [{ start: 0, length: url.length, style: BOLD }]),
    `<strong>${A(url)}</strong>`);
  // Bold around a link plus surrounding words.
  assert.equal(render(`hi ${url} yo`, [{ start: 0, length: 25, style: BOLD }]),
    `<strong>hi ${A(url)} yo</strong>`);
});

test('a style range crossing a link boundary splits the style, never the anchor', () => {
  const text = `see https://example.com/page here`;
  // Bold starts before the url and stops halfway through it.
  const out = render(text, [{ start: 0, length: 18, style: BOLD }]);
  assert.equal(out.match(/<a /g).length, 1, 'anchor was split');
  assert.equal(out,
    `<strong>see </strong>${A('https://example.com/page', '<strong>https://exampl</strong>e.com/page')} here`);

  // ...and the mirror image: italic starting inside the url and running past it.
  const tail = render(text, [{ start: 18, length: 15, style: ITALIC }]);
  assert.equal(tail.match(/<a /g).length, 1, 'anchor was split');
  assert.equal(tail,
    `see ${A('https://example.com/page', 'https://exampl<em>e.com/page</em>')}<em> here</em>`);
});

test('spoilers decide whether a link is clickable', () => {
  const url = 'https://example.com';
  // A spoiler *around* the link keeps the anchor: .spoiler-body is hidden until
  // revealed, and a hidden subtree takes no clicks.
  assert.equal(render(url, [{ start: 0, length: url.length, style: SPOILER }]),
    `<span class="spoiler"><span class="spoiler-body">${A(url)}</span></span>`);

  // A spoiler over only part of the link drops the anchor entirely.
  const half = render(url, [{ start: 0, length: 11, style: SPOILER }]);
  assert.ok(!half.includes('<a '), 'half-blacked-out url stayed clickable');
  assert.equal(half, '<span class="spoiler"><span class="spoiler-body">https://exa</span></span>mple.com');

  // Same for a spoiler hiding a piece in the middle of one.
  const middle = render(url, [{ start: 8, length: 7, style: SPOILER }]);
  assert.ok(!middle.includes('<a '), 'url with a hidden middle stayed clickable');

  // A spoiler elsewhere in the message doesn't cost the link its anchor.
  const other = render(`secret ${url}`, [{ start: 0, length: 6, style: SPOILER }]);
  assert.ok(other.includes('<a '), 'unrelated spoiler suppressed the link');
});
