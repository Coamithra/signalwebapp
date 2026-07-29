// Pure-function coverage for src/youtube.js. The fetch paths need the network
// (and yt-dlp) so they're verified by hand; what's testable here is the argument
// building that caused the bug this file was added for.

import test from 'node:test';
import assert from 'node:assert/strict';

import { subLangsFor, parseVideoId, findYouTubeUrl } from '../src/youtube.js';

test('subLangsFor: the first attempt is literal, never a regex', () => {
  const stage0 = subLangsFor('en', 0);
  // The whole bug: yt-dlp treats each entry as a case-insensitive full-match
  // regex, so a single `.` or `*` here fans out to ~55 auto-translated tracks
  // and earns a 429. Keep the first attempt free of metacharacters.
  for (const entry of stage0.split(',')) {
    assert.match(entry, /^[a-z]{2}(-[A-Za-z]+)?$/, `"${entry}" is not a plain language code`);
  }
  assert.deepEqual(stage0.split(','), ['en', 'en-orig', 'en-US', 'en-GB']);
});

test('subLangsFor: the fallback attempt widens to the regex form', () => {
  assert.equal(subLangsFor('en', 1), 'en.*,en');
});

test('subLangsFor: honours a non-default language', () => {
  assert.equal(subLangsFor('de', 0), 'de,de-orig,de-US,de-GB');
  assert.equal(subLangsFor('de', 1), 'de.*,de');
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
