// Tests for the pure half of the `claude` CLI plumbing (src/claude-cli.js).
//
// Zero-dep: node's built-in runner (`npm test`). Only the parsers and the
// validator are covered — spawning a real login is a hands-on step by nature
// (it needs a browser and a human), so createClaudeLogin's state machine is
// exercised by running the app.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAuthStatus, parseAuthUrl, validCode } from '../src/claude-cli.js';

// ---------- auth status ----------

test('parseAuthStatus reads the CLI’s JSON both ways', () => {
  assert.equal(parseAuthStatus('{"loggedIn": false, "authMethod": "none"}'), false);
  assert.equal(parseAuthStatus('{"loggedIn": true, "authMethod": "oauth"}'), true);
  // The real thing is pretty-printed across several lines.
  assert.equal(parseAuthStatus('{\n  "loggedIn": false,\n  "apiProvider": "firstParty"\n}'), false);
});

test('parseAuthStatus answers null — never "logged out" — for output it cannot read', () => {
  // A definite false latches the feature off, so unreadable output must not
  // masquerade as one: a CLI that changed its output shape should degrade to
  // finding out on the first real run, not to the feature switching itself off.
  for (const bad of ['', 'not json at all', '{}', '{"loggedIn": "yes"}', '{oops', null, undefined]) {
    assert.equal(parseAuthStatus(bad), null, JSON.stringify(bad));
  }
});

// ---------- the sign-in URL ----------

const REAL_OUTPUT = `Opening browser to sign in…
If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&scope=user%3Aprofile
Paste code here if prompted > `;

test('parseAuthUrl pulls the sign-in URL out of the CLI’s real output', () => {
  const url = parseAuthUrl(REAL_OUTPUT);
  assert.equal(new URL(url).hostname, 'claude.com');
  assert.match(url, /oauth\/authorize/);
  assert.ok(!/\s/.test(url));
});

test('parseAuthUrl accepts only https on an Anthropic host', () => {
  // This URL is rendered as a link the user is told to click, so anything that
  // got through here would be a phishing link the app vouched for.
  assert.equal(parseAuthUrl('visit: http://claude.com/cai/oauth/authorize'), null); // not https
  assert.equal(parseAuthUrl('visit: https://claude.com.evil.test/oauth'), null);    // lookalike host
  assert.equal(parseAuthUrl('visit: https://evil.test/https://claude.com'), null);  // host is what counts
  assert.equal(parseAuthUrl('javascript:alert(1)'), null);
  assert.equal(parseAuthUrl('nothing here'), null);
  assert.ok(parseAuthUrl('go to https://platform.claude.com/oauth/code/callback'));
});

test('parseAuthUrl drops sentence punctuation that is not part of the URL', () => {
  assert.equal(parseAuthUrl('visit https://claude.com/cai/oauth/authorize.'),
    'https://claude.com/cai/oauth/authorize');
});

// ---------- the pasted code ----------

test('validCode accepts a real-looking code and trims it', () => {
  assert.equal(validCode('  ac_01H9xKp-Q7  '), 'ac_01H9xKp-Q7');
  assert.equal(validCode('abc#123.xyz/=='), 'abc#123.xyz/==');
});

test('validCode rejects anything that could become a second stdin answer', () => {
  // A newline is the one character that would turn one write into two answers
  // to the CLI's prompt.
  for (const bad of ['', '   ', 'has space', 'two\nlines', 'tab\there', 'x'.repeat(513), null, undefined]) {
    assert.equal(validCode(bad), null, JSON.stringify(bad));
  }
  assert.equal(validCode('x'.repeat(512)), 'x'.repeat(512)); // the bound itself is fine
});
