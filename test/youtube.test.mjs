// Pure-function coverage for src/youtube.js. The fetch paths need the network
// (and yt-dlp) so they're verified by hand; what's testable here is the argument
// building that caused the bug this file was added for.

import test from 'node:test';
import assert from 'node:assert/strict';

import { subLangsFor, pickSubFile, parseVideoId, findYouTubeUrl } from '../src/youtube.js';

test('subLangsFor: the narrow attempt is literal, never a regex', () => {
  // The whole bug: yt-dlp treats each entry as a case-insensitive full-match
  // regex, so a single `.` or `*` here fans out to ~55 auto-translated tracks
  // and earns a 429. Keep the narrow attempt free of metacharacters, whatever
  // language it's built for.
  for (const lang of ['en', 'de', 'pt']) {
    for (const entry of subLangsFor(lang, false).split(',')) {
      assert.match(entry, /^[a-z]{2}(-[A-Za-z]+)?$/, `"${entry}" is not a plain language code`);
    }
  }
});

test('subLangsFor: the narrow attempt covers the plain code and the ASR original', () => {
  assert.ok(subLangsFor('en', false).split(',').includes('en'));
  assert.ok(subLangsFor('en', false).split(',').includes('en-orig'));
  assert.ok(subLangsFor('de', false).split(',').includes('de-orig'));
});

test('subLangsFor: regional variants are per-language, never guessed', () => {
  // `en-GB` is real; `de-GB` is not. Asking for a code the video lacks is free,
  // but inventing dialects for a language we know nothing about is noise.
  assert.ok(subLangsFor('en', false).split(',').includes('en-GB'));
  assert.deepEqual(subLangsFor('de', false).split(','), ['de', 'de-orig']);
});

test('subLangsFor: the fallback attempt widens to the regex form', () => {
  assert.equal(subLangsFor('en', true), 'en.*,en');
  assert.equal(subLangsFor('de', true), 'de.*,de');
});

test('pickSubFile: prefers the exact language, then the ASR original', () => {
  const all = ['v.en-sq.json3', 'v.en-orig.json3', 'v.en.json3'];
  assert.equal(pickSubFile(all, 'en'), 'v.en.json3');
  assert.equal(pickSubFile(['v.en-sq.json3', 'v.en-orig.json3'], 'en'), 'v.en-orig.json3');
  // Last resort: a machine-translated track beats no transcript at all.
  assert.equal(pickSubFile(['v.en-sq.json3'], 'en'), 'v.en-sq.json3');
});

test('pickSubFile: ignores non-json3 files and reports nothing usable', () => {
  assert.equal(pickSubFile(['v.en.vtt', 'v.info.json'], 'en'), null);
  assert.equal(pickSubFile([], 'en'), null);
});

test('parseVideoId: accepts the common URL shapes', () => {
  const id = 'Ks-_Mh1QhMc';
  assert.equal(parseVideoId(`https://www.youtube.com/watch?v=${id}`), id);
  assert.equal(parseVideoId(`https://youtu.be/${id}`), id);
  assert.equal(parseVideoId(`https://www.youtube.com/shorts/${id}`), id);
  assert.equal(parseVideoId('https://example.com/watch?v=' + id), null);
  assert.equal(parseVideoId('not a url'), null);
});

test('findYouTubeUrl: picks the link out of surrounding prose', () => {
  const found = findYouTubeUrl('look at this https://youtu.be/Ks-_Mh1QhMc, it is great');
  assert.equal(found.videoId, 'Ks-_Mh1QhMc');
  assert.equal(found.url, 'https://youtu.be/Ks-_Mh1QhMc');
  assert.equal(findYouTubeUrl('no links here'), null);
});
