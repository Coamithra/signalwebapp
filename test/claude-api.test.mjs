// Tests for the Messages API transport (src/claude-api.js).
//
// Zero-dep: node's built-in runner (`npm test`). Every call goes to a fake
// fetch, so nothing here touches the network or spends anything; the live API
// is exercised by hand (send a YouTube link to Note to Self).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessage, errorTag, replyText } from '../src/claude-api.js';

const BODY = { model: 'claude-opus-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] };

// A fetch that answers each call with the next scripted response and records
// what it was sent.
function fakeFetch(...responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    const headers = new Map(Object.entries(r.headers || {}));
    return { ok: r.status < 300, status: r.status, headers, json: async () => r.json };
  };
  fn.calls = calls;
  return fn;
}
const message = (content, stop_reason = 'end_turn') => ({ status: 200, json: { content, stop_reason, usage: {} } });
const text = (t) => ({ type: 'text', text: t });

test('a finished reply resolves its text', async () => {
  const f = fakeFetch(message([text('{"summary":"S","quote":""}')]));
  const r = await createMessage({ apiKey: 'k', body: BODY, timeoutMs: 1000, fetchImpl: f });
  assert.equal(r.text, '{"summary":"S","quote":""}');
  assert.equal(r.message.stop_reason, 'end_turn');
});

test('the request carries the key, the version and the fallback opt-in', async () => {
  const f = fakeFetch(message([text('ok')]));
  await createMessage({ apiKey: 'sk-test', body: BODY, timeoutMs: 1000, fetchImpl: f });
  const { url, init, body } = f.calls[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-api-key'], 'sk-test');
  assert.equal(init.headers['anthropic-version'], '2026-10-21');
  assert.equal(init.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(body.fallbacks, 'default');
  assert.equal(body.model, 'claude-opus-5-5');
});

test('no key fails before any request is made', async () => {
  const f = fakeFetch();
  await assert.rejects(createMessage({ apiKey: '', body: BODY, timeoutMs: 1000, fetchImpl: f }), /^Error: claude-no-key$/);
  assert.equal(f.calls.length, 0);
});

test('a paused server-tool turn is resumed with the paused content appended', async () => {
  const paused = [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } }];
  const f = fakeFetch(message(paused, 'pause_turn'), message([text('{"channel":"C","claims":""}')]));
  const r = await createMessage({ apiKey: 'k', body: BODY, timeoutMs: 1000, fetchImpl: f });
  assert.equal(r.text, '{"channel":"C","claims":""}');
  assert.equal(f.calls.length, 2);
  // No "continue" user turn: the trailing server_tool_use block is the signal.
  assert.deepEqual(f.calls[1].body.messages, [...BODY.messages, { role: 'assistant', content: paused }]);
});

test('a research pass that never stops pausing is cut off', async () => {
  const paused = message([{ type: 'server_tool_use', id: 's', name: 'web_search', input: {} }], 'pause_turn');
  const f = fakeFetch(paused, paused, paused, paused, paused, paused);
  await assert.rejects(createMessage({ apiKey: 'k', body: BODY, timeoutMs: 1000, fetchImpl: f }), /claude-paused/);
  assert.equal(f.calls.length, 5);
});

test('a refusal, a truncation, an empty reply and a malformed body are distinct tags', async () => {
  const run = (...r) => createMessage({ apiKey: 'k', body: BODY, timeoutMs: 1000, fetchImpl: fakeFetch(...r) });
  await assert.rejects(run(message([text('no')], 'refusal')), /claude-refusal/);
  // Cut off by max_tokens -- with or without partial text -- is one tag, so a
  // half-written JSON object is never mistaken for a schema miss and retried.
  await assert.rejects(run(message([], 'max_tokens')), /claude-truncated/);
  await assert.rejects(run(message([text('{"summary": "half')], 'max_tokens')), /claude-truncated/);
  await assert.rejects(run(message([], 'end_turn')), /claude-no-text:end_turn/);
  await assert.rejects(run({ status: 200, json: { nope: true } }), /claude-bad-output/);
});

test('a 429 carries its retry-after, in milliseconds', async () => {
  const limited = { status: 429, headers: { 'retry-after': '7' }, json: { type: 'error', error: { type: 'rate_limit_error' } } };
  await assert.rejects(
    createMessage({ apiKey: 'k', body: BODY, timeoutMs: 1000, fetchImpl: fakeFetch(limited) }),
    (e) => e.message === 'claude-limit' && e.retryAfterMs === 7000,
  );
  const bare = { status: 429, json: { type: 'error', error: { type: 'rate_limit_error' } } };
  await assert.rejects(
    createMessage({ apiKey: 'k', body: BODY, timeoutMs: 1000, fetchImpl: fakeFetch(bare) }),
    (e) => e.message === 'claude-limit' && e.retryAfterMs === undefined,
  );
});

test('a network failure and a timeout are told apart', async () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  await assert.rejects(
    createMessage({ apiKey: 'k', body: BODY, timeoutMs: 1000, fetchImpl: fakeFetch(timeout) }), /claude-timeout/);
  await assert.rejects(
    createMessage({ apiKey: 'k', body: BODY, timeoutMs: 1000, fetchImpl: fakeFetch(new TypeError('fetch failed')) }),
    /claude-network/);
});

test('HTTP errors map to fixed tags, never to the API\'s message text', () => {
  const err = (type, message = 'x') => ({ type: 'error', error: { type, message } });
  assert.equal(errorTag(401, err('authentication_error')), 'claude-auth');
  assert.equal(errorTag(403, err('permission_error')), 'claude-auth');
  assert.equal(errorTag(429, err('rate_limit_error')), 'claude-limit');
  assert.equal(errorTag(400, err('invalid_request_error', 'Your credit balance is too low to access the API.')), 'claude-credits');
  assert.equal(errorTag(529, err('overloaded_error')), 'claude-overloaded');
  assert.equal(errorTag(500, err('api_error')), 'claude-overloaded');
  assert.equal(errorTag(404, err('not_found_error', 'model: nope')), 'claude-http 404 not_found_error');
  assert.equal(errorTag(400, err('invalid_request_error', 'some secret request text')), 'claude-http 400 invalid_request_error');
  // An error body that isn't JSON at all still gets a tag.
  assert.equal(errorTag(502, null), 'claude-overloaded');
  assert.equal(errorTag(418, null), 'claude-http 418');
});

test('a reply split around citations is joined back into one text', () => {
  assert.equal(replyText({
    content: [
      { type: 'server_tool_use' },
      text('{"channel": "A physicist'), text(' who'), { type: 'web_search_tool_result' }, text(' teaches.", "claims": ""}'),
    ],
  }), '{"channel": "A physicist who teaches.", "claims": ""}');
  assert.equal(replyText(null), '');
  assert.equal(replyText({ content: 'nope' }), '');
});
