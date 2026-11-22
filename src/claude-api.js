// The Claude Messages API, over Node's built-in fetch.
//
// This is the whole transport for auto-TLDR's two model calls. It is raw HTTP
// rather than @anthropic-ai/sdk on purpose: the app is zero-dependency, and one
// endpoint does not justify the first runtime package. What the SDK would have
// given us, done by hand here: the version header, typed errors (as `claude-*`
// tags the callers already map to retry decisions and UI text), and resuming a
// server-tool loop that stopped on `pause_turn`.
//
// Every failure is thrown as an Error whose message is a fixed tag. Nothing from
// the response body reaches a message: the request carries third-party caption
// text, and the tags are what tldr.js turns into the phrases the browser sees.

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2026-10-21';
// Server-side refusal fallback: on a policy decline the API re-runs the request
// on a fallback model it picks by refusal category, inside the same call. The
// summary auto-sends with nobody watching, so a false-positive decline is
// better rescued than reported.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
// A server-tool loop (web search/fetch) that runs long comes back as
// `pause_turn` and is resumed by re-sending it. Bounded so a runaway research
// pass cannot loop for ever; the caller's deadline bounds it in time as well.
const MAX_CONTINUATIONS = 5;

// Map a non-2xx response to a tag. `type` is the API's own error type, which is
// a fixed enum and safe to branch on; its `message` is never used for that,
// with one exception -- an exhausted credit balance arrives as a plain 400
// invalid_request_error, and only its wording tells it apart from a bad request.
export function errorTag(status, body) {
  const type = body && body.error && body.error.type;
  const message = String((body && body.error && body.error.message) || '');
  if (status === 401 || status === 403 || type === 'authentication_error' || type === 'permission_error') {
    return 'claude-auth';
  }
  if (status === 429 || type === 'rate_limit_error') return 'claude-limit';
  if (status === 400 && /credit balance/i.test(message)) return 'claude-credits';
  if (status === 529 || status >= 500 || type === 'overloaded_error' || type === 'api_error') {
    return 'claude-overloaded';
  }
  return `claude-http ${status}${type ? ` ${type}` : ''}`;
}

// The reply text of a finished message: every text block, in order. A research
// reply with citations is split into several text blocks around them, so taking
// only the first would cut the JSON object in half.
export function replyText(message) {
  const blocks = Array.isArray(message && message.content) ? message.content : [];
  return blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('').trim();
}

// One Messages API call, resumed across `pause_turn` until it finishes.
//
// `body` is the request body minus nothing: model, max_tokens, system, messages,
// tools, output_config. Resolves `{ text, message }` where `message` is the final
// response (for its usage) and `text` its reply; throws a `claude-*` tag.
// `timeoutMs` is ONE deadline across every continuation, not per request.
export async function createMessage({ apiKey, body, timeoutMs, fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new Error('claude-no-key');
  const signal = AbortSignal.timeout(timeoutMs);
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
    'anthropic-beta': FALLBACK_BETA,
  };
  let messages = body.messages;
  for (let turn = 0; ; turn++) {
    let res;
    try {
      res = await fetchImpl(API_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, fallbacks: 'default', messages }),
        signal,
      });
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error('claude-timeout');
      throw new Error('claude-network');
    }
    let data = null;
    try { data = await res.json(); } catch {
      if (signal.aborted) throw new Error('claude-timeout');
      /* not JSON: handled below */
    }
    if (!res.ok) {
      const err = new Error(errorTag(res.status, data));
      // A 429 says how long to back off; the caller decides whether that fits
      // its own budget. Seconds on the wire, milliseconds on the error.
      const after = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
      if (Number.isFinite(after) && after > 0) err.retryAfterMs = after * 1000;
      throw err;
    }
    if (!data || !Array.isArray(data.content)) throw new Error('claude-bad-output');
    if (data.stop_reason === 'refusal') throw new Error('claude-refusal');
    // Out of output budget (thinking counts against it). Whatever text came out
    // is cut off mid-reply, and re-sending the identical request -- up to a
    // 600k-char transcript -- would most likely be cut off again, so this is
    // its own tag and callers do not retry it.
    if (data.stop_reason === 'max_tokens') throw new Error('claude-truncated');
    if (data.stop_reason === 'pause_turn') {
      if (turn + 1 >= MAX_CONTINUATIONS) throw new Error('claude-paused');
      // Resume: the same request with the paused assistant turn appended. No
      // "continue" user message -- the trailing server_tool_use block is what
      // tells the API to pick up where it stopped.
      messages = [...messages, { role: 'assistant', content: data.content }];
      continue;
    }
    const text = replyText(data);
    if (!text) throw new Error(`claude-no-text:${data.stop_reason || 'empty'}`);
    return { text, message: data };
  }
}
