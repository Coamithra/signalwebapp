// YouTube link detection + transcript fetching, zero-dep (Node global fetch).
//
// There is no public transcript API, so this scrapes the watch page the same way
// the official player bootstraps: pull the `ytInitialPlayerResponse` JSON out of
// the HTML, find the caption tracks it lists, then fetch the chosen track's
// timedtext URL as `json3` and concatenate the segments.
//
// This is inherently fragile — YouTube can change the page shape or gate
// timedtext behind a token at any time. When the auto-TLDR feature stops
// producing summaries, this file is the thing to re-probe; nothing else in the
// app depends on YouTube's internals.
//
// YouTube has tightened this: on many networks the timedtext endpoint now
// returns an empty body to direct fetches (bot-gating). So if the HTTP path
// fails, fetchTranscript falls back to `yt-dlp` when it's installed — it keeps
// up with those changes and stays cheap (a transcript, not video frames). The
// fallback is optional: with no yt-dlp on PATH, the HTTP path is all there is.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A desktop-Chrome UA + an accepted-consent cookie. Without the cookie, EU
// requests get the consent interstitial instead of the watch page; without a
// browser-ish UA, YouTube is more likely to serve a stripped/blocked variant.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Extract the 11-char video id from any common YouTube URL shape
// (watch?v=, youtu.be/, shorts/, embed/, live/, music./m./-nocookie). Returns
// null for anything that isn't a YouTube video URL.
export function parseVideoId(input) {
  if (!input) return null;
  let u;
  try { u = new URL(input); } catch { return null; }
  const host = u.hostname.replace(/^www\./i, '').toLowerCase();
  let id = null;
  if (host === 'youtu.be') {
    id = u.pathname.slice(1).split('/')[0];
  } else if (host === 'youtube.com' || host.endsWith('.youtube.com') ||
             host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) {
    if (u.pathname === '/watch') {
      id = u.searchParams.get('v');
    } else {
      const m = u.pathname.match(/^\/(?:shorts|embed|v|live)\/([^/?#]+)/);
      if (m) id = m[1];
    }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

// Find the first YouTube video link anywhere in a free-text message. Returns
// { url, videoId } or null. Scans every http(s) token so surrounding words,
// punctuation, and non-YouTube links don't get in the way.
export function findYouTubeUrl(text) {
  if (typeof text !== 'string' || !text) return null;
  const re = /https?:\/\/[^\s<>"')]+/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const url = m[0].replace(/[.,);!?]+$/, ''); // drop trailing sentence punctuation
    const videoId = parseVideoId(url);
    if (videoId) return { url, videoId };
  }
  return null;
}

// Walk an embedded JSON object literal starting at `marker` (e.g.
// "ytInitialPlayerResponse"), returning the raw `{...}` text. Brace-counts with
// string/escape awareness so braces inside string values don't end it early —
// far more robust than a greedy regex against minified page HTML.
function extractJsonObject(html, marker) {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  return null;
}

// Flatten a YouTube `json3` timedtext document into flowing prose. Caption cues
// carry their own line breaks; collapsing whitespace gives the model clean input
// and doesn't waste tokens on layout. Shared by both fetch paths below.
function flattenJson3(tt) {
  let text = '';
  for (const ev of (Array.isArray(tt && tt.events) ? tt.events : [])) {
    if (!Array.isArray(ev.segs)) continue;
    for (const seg of ev.segs) if (seg && typeof seg.utf8 === 'string') text += seg.utf8;
  }
  return text.replace(/\s+/g, ' ').trim();
}

// Zero-dep path: scrape the watch page for caption tracks, then fetch the chosen
// track as json3. Throws a short Error on any failure. opts.lang is the
// preferred caption language prefix (default 'en'); manual captions are
// preferred over auto-generated (ASR) ones in that language.
async function fetchTranscriptHttp(videoId, opts) {
  const timeoutMs = opts.timeoutMs || 15000;
  const lang = opts.lang || 'en';

  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`;
  const res = await fetch(watchUrl, {
    headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', cookie: 'CONSENT=YES+1' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`watch-page ${res.status}`);
  const html = await res.text();

  const raw = extractJsonObject(html, 'ytInitialPlayerResponse');
  if (!raw) throw new Error('no-player-response');
  let pr;
  try { pr = JSON.parse(raw); } catch { throw new Error('player-response-parse'); }

  // A video can be private/removed/region-blocked — surface that rather than
  // silently reporting "no captions".
  const playable = pr?.playabilityStatus?.status;
  if (playable && playable !== 'OK') throw new Error(`not-playable:${playable}`);

  const title = pr?.videoDetails?.title || null;
  const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || !tracks.length) throw new Error('no-captions');

  const inLang = (t) => (t.languageCode || '').toLowerCase().startsWith(lang);
  const track =
    tracks.find((t) => inLang(t) && t.kind !== 'asr') || // manual captions in the language
    tracks.find((t) => inLang(t)) ||                     // auto-generated in the language
    tracks.find((t) => t.kind !== 'asr') ||              // any manual captions
    tracks[0];                                           // anything
  if (!track || !track.baseUrl) throw new Error('no-track-url');

  const ttUrl = track.baseUrl + (track.baseUrl.includes('?') ? '&' : '?') + 'fmt=json3';
  const ttRes = await fetch(ttUrl, {
    headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!ttRes.ok) throw new Error(`timedtext ${ttRes.status}`);
  // YouTube now often answers 200 with an EMPTY body to bot-flagged requests;
  // treat that as a failure so the yt-dlp fallback gets a turn.
  const body = await ttRes.text();
  if (!body.trim()) throw new Error('timedtext-empty');
  let tt;
  try { tt = JSON.parse(body); } catch { throw new Error('timedtext-parse'); }

  const text = flattenJson3(tt);
  if (!text) throw new Error('empty-transcript');
  return { text, title, lang: track.languageCode || null, generated: track.kind === 'asr', source: 'http' };
}

// Robust fallback: shell out to yt-dlp (if installed) to write subtitles as
// json3, then reuse flattenJson3. yt-dlp keeps up with YouTube's anti-scraping
// changes (PO tokens, client rotation) so it succeeds where the direct HTTP
// path is bot-gated — at the cost of a process spawn. No shell, so cmd.exe never
// mangles the % in the output template on Windows; videoId is already validated
// to 11 safe chars upstream, so it's a safe argv element regardless.
function fetchViaYtDlp(videoId, opts) {
  const timeoutMs = opts.ytDlpTimeoutMs || 45000;
  const lang = opts.lang || 'en';
  return new Promise((resolve, reject) => {
    let dir;
    try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tldr-')); }
    catch { return reject(new Error('tmp-failed')); }
    const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
    const args = [
      '-q', '--no-warnings', '--skip-download',
      '--write-subs', '--write-auto-subs',
      '--sub-langs', `${lang}.*,${lang}`,
      '--sub-format', 'json3',
      '-o', `${path.join(dir, 'v')}.%(ext)s`,
      `https://www.youtube.com/watch?v=${videoId}`,
    ];
    // No title here: --write-info-json is unreliable alongside the sub flags, and
    // the title is optional (the HTTP path supplies it, and the model gets the
    // full transcript anyway).
    execFile('yt-dlp', args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err) => {
      if (err && err.code === 'ENOENT') { cleanup(); return reject(new Error('yt-dlp-not-found')); }
      // A non-zero exit can still leave a usable sub file, so check for output
      // before treating `err` as fatal. yt-dlp may emit several variants
      // (v.en.json3 = manual, v.en-orig.json3 = ASR, v.en-en.json3 = translated);
      // prefer the exact-language (manual) track, then any json3.
      let files = [];
      try { files = fs.readdirSync(dir); } catch {}
      const json3s = files.filter((f) => f.endsWith('.json3'));
      const subFile = json3s.find((f) => f.endsWith(`.${lang}.json3`)) || json3s[0];
      let text = '';
      if (subFile) {
        try { text = flattenJson3(JSON.parse(fs.readFileSync(path.join(dir, subFile), 'utf8'))); } catch {}
      }
      cleanup();
      if (!text) return reject(new Error(err ? `yt-dlp ${err.code || 'error'}` : 'yt-dlp-no-subs'));
      resolve({ text, title: null, lang: null, generated: null, source: 'yt-dlp' });
    });
  });
}

// Fetch a video's transcript. Tries the zero-dep HTTP path first (fast, but
// increasingly bot-gated), then falls back to yt-dlp if it's installed. Resolves
// to { text, title, lang, generated, source } or throws a short Error the caller
// logs and treats as "no summary available". Pass opts.ytDlp = false to disable
// the external-binary fallback entirely (HTTP path only).
export async function fetchTranscript(videoId, opts = {}) {
  try {
    return await fetchTranscriptHttp(videoId, opts);
  } catch (httpErr) {
    if (opts.ytDlp === false) throw httpErr; // fallback disabled -> HTTP error is the result
    try {
      return await fetchViaYtDlp(videoId, opts);
    } catch (ytErr) {
      // Surface both causes. If yt-dlp simply isn't installed, the HTTP error is
      // the meaningful one; otherwise show both.
      throw new Error(ytErr.message === 'yt-dlp-not-found'
        ? `${httpErr.message} (yt-dlp not installed for fallback)`
        : `http:${httpErr.message}; ytdlp:${ytErr.message}`);
    }
  }
}
