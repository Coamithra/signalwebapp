// Auto-TLDR for YouTube links.
//
// When the user posts a YouTube link in a chat they've enabled, this watches the
// bridge's realtime event stream, fetches the video transcript (src/youtube.js),
// asks Gemini for a very short summary, and sends it back into that chat — all
// server-side, so it works with no browser tab open. It reuses the bridge's
// existing getMessages + sendText, so there is no page-api.js / bridge.js change.
//
// Trigger policy (per the feature spec): only the user's OWN outgoing links fire
// a summary, never links other people post. Failures (no captions, YouTube
// blocked, Gemini error) are logged and swallowed — we never post an error into
// the chat.

import fs from 'node:fs';
import { findYouTubeUrl, fetchTranscript } from './youtube.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
// Don't feed a pathological transcript to the model. gemini-*-flash handles ~1M
// tokens, far more than even a multi-hour transcript, so this only guards
// against runaway input, not normal long videos.
const MAX_TRANSCRIPT_CHARS = 600_000;
const PROCESSED_CAP = 2000; // bound the dedup set
// Hard cap on the summary we actually post. The prompt asks for ~2 sentences,
// but this auto-sends to real contacts, so clamp defensively in case the model
// ignores that and rambles.
const MAX_TLDR_CHARS = 600;

function log(...args) { console.log('  [tldr]', ...args); }

// --- per-chat settings persistence (a gitignored JSON file at the repo root) ---
function loadEnabled(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const arr = Array.isArray(data) ? data : (Array.isArray(data?.enabled) ? data.enabled : []);
    return new Set(arr.map(String));
  } catch {
    return new Set(); // missing/corrupt -> start empty
  }
}
function saveEnabled(file, set) {
  try {
    fs.writeFileSync(file, JSON.stringify({ enabled: [...set] }, null, 2));
  } catch (e) {
    log('could not persist settings:', e.message);
  }
}

// Ask Gemini for a very short TLDR of the transcript. Throws on a non-OK
// response (surfacing the API's error message) so the caller can log and skip.
async function summarize({ apiKey, model, transcript, title }) {
  const body = transcript.length > MAX_TRANSCRIPT_CHARS
    ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) : transcript;
  const prompt =
    'Summarize this YouTube video for a friend who is not going to watch it. ' +
    'Reply with a VERY SHORT TLDR: at most two sentences (~50 words), plain text, ' +
    'no preamble, no markdown, and do not start with "TLDR".\n\n' +
    (title ? `Title: ${title}\n\n` : '') +
    `Transcript:\n${body}`;

  const generationConfig = { temperature: 0.3, maxOutputTokens: 2048 };
  // gemini-2.5-flash "thinks" by default, and thinking tokens count against the
  // output budget — disable it so the budget goes to the answer and the call
  // stays fast/cheap. Only 2.5-flash supports a 0 budget; leave other models on
  // their defaults (the 2048 ceiling above leaves room for any thinking).
  if (/2\.5-flash/i.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const res = await fetch(`${GEMINI_BASE}${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch { /* non-JSON body */ }
    throw new Error(`gemini ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const data = await res.json();
  const cand = data?.candidates?.[0];
  const parts = cand?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p) => p?.text || '').join('').trim() : '';
  if (!text) {
    const reason = cand?.finishReason || data?.promptFeedback?.blockReason || 'empty';
    throw new Error(`gemini-no-text:${reason}`);
  }
  return text;
}

// Wire up the feature. Returns the small surface the server needs: a configured()
// flag, per-chat isEnabled/setEnabled (persisted), and start() to attach the
// realtime watcher. Toggling works even without a key (the preference persists);
// summaries only happen once GEMINI_API_KEY is set.
export function createTldr({ bridge, settingsPath, apiKey, model, ytDlp = true }) {
  const enabled = loadEnabled(settingsPath);
  // Per-conversation timestamp floor: we only summarize links in messages newer
  // than this, so server boot / enabling a chat never re-summarizes old history.
  const since = new Map();
  const processed = new Set(); // `${convId}:${msgId}` we've already handled
  const bootTs = Date.now();

  function markProcessed(key) {
    processed.add(key);
    if (processed.size > PROCESSED_CAP) processed.delete(processed.values().next().value);
  }

  async function summarizeAndSend(convId, found) {
    let transcript;
    try {
      transcript = await fetchTranscript(found.videoId, { ytDlp });
    } catch (e) {
      log(`no transcript for ${found.url}: ${e.message}`);
      return; // stay silent in the chat
    }
    let tldr;
    try {
      tldr = await summarize({ apiKey, model, transcript: transcript.text, title: transcript.title });
    } catch (e) {
      log(`summary failed for ${found.url}: ${e.message}`);
      return;
    }
    const summary = tldr.length > MAX_TLDR_CHARS ? tldr.slice(0, MAX_TLDR_CHARS).trimEnd() + '…' : tldr;
    const r = await bridge.sendText(convId, `🤖 TLDR: ${summary}`);
    if (!r || !r.ok) log(`send failed for ${found.url}: ${r && r.error}`);
    else log(`sent TLDR for ${found.url}`);
  }

  async function handleConversation(convId) {
    const data = await bridge.getMessages(convId);
    if (!data || !Array.isArray(data.messages)) return;
    const floor = since.has(convId) ? since.get(convId) : bootTs;
    let maxTs = floor;
    for (const msg of data.messages) {
      const ts = msg.timestamp || 0;
      if (ts > maxTs) maxTs = ts;
      if (ts <= floor) continue;                  // pre-watch history
      if (msg.direction !== 'outgoing') continue; // only the user's own links
      const found = findYouTubeUrl(msg.text);
      if (!found) continue;
      const key = `${convId}:${msg.id}`;
      if (processed.has(key)) continue;
      markProcessed(key);
      summarizeAndSend(convId, found).catch((e) => log('unexpected:', e.message));
    }
    since.set(convId, maxTs); // advance the floor so we don't re-scan handled messages
  }

  return {
    configured: () => !!apiKey,
    isEnabled: (id) => enabled.has(String(id)),
    list: () => [...enabled],

    setEnabled(id, on) {
      id = String(id);
      if (on) {
        enabled.add(id);
        since.set(id, Date.now()); // only links posted from now on get summarized
      } else {
        enabled.delete(id);
      }
      saveEnabled(settingsPath, enabled);
      return enabled.has(id);
    },

    start() {
      if (!apiKey) {
        log('GEMINI_API_KEY not set — auto-TLDR is idle until it is (per-chat toggle still works).');
      }
      // Serialize processing per conversation. A single send produces a burst of
      // coalesced 'messages' events (the message + its sent/delivered updates);
      // running handleConversation concurrently for them could summarize the
      // same link twice before the dedup set is updated. Re-run once if more
      // events arrived while we were busy, so nothing is missed either.
      const busy = new Set();
      const dirty = new Set();
      const schedule = (convId) => {
        if (busy.has(convId)) { dirty.add(convId); return; }
        busy.add(convId);
        handleConversation(convId)
          .catch((err) => log('watch error:', err.message))
          .finally(() => {
            busy.delete(convId);
            if (dirty.delete(convId)) schedule(convId);
          });
      };
      bridge.on('event', (e) => {
        if (!apiKey) return;
        if (!e || e.type !== 'messages' || !e.conversationId) return;
        if (!enabled.has(e.conversationId)) return;
        schedule(e.conversationId);
      });
    },
  };
}
