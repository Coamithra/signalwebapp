// Local web server: serves the UI, exposes a small REST API over the Signal
// bridge, and streams realtime events to the browser via SSE.
//
// Binds to 127.0.0.1 ONLY. This server can read and send your Signal messages,
// so it must never be exposed on a public interface.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignalBridge } from './bridge.js';
import { createTldr } from './tldr.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Load a gitignored .env at the repo root (if present) before reading any config
// below, so secrets like GIPHY_API_KEY can live in a file instead of the shell
// environment. Absolute path so it works regardless of the launch cwd; a missing
// .env is a no-op. Uses Node's built-in parser (>=20.12 / 21.7) -- no dependency.
try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch { /* no .env present (or unreadable) -- fall back to the real environment */ }

const PORT = Number(process.env.PORT || 7700);
const HOST = '127.0.0.1';
const CDP_PORT = Number(process.env.SIGNAL_CDP_PORT || 9222);
// Chromium's remote-debugging endpoint binds IPv4 loopback. When unset, the CDP
// client auto-probes 127.0.0.1 then ::1 and accepts whichever actually exposes
// Signal's background.html — so a `localhost` that resolves IPv6-first, or an
// unrelated debug target on ::1, no longer misses Signal. SIGNAL_CDP_HOST pins a
// single host as an escape hatch.
const CDP_HOST = process.env.SIGNAL_CDP_HOST || undefined;

const bridge = new SignalBridge({ host: CDP_HOST, port: CDP_PORT });

// ---- SSE clients ----
/** @type {Set<http.ServerResponse>} */
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

bridge.on('event', (e) => broadcast('signal', e));
bridge.on('status', (s) => broadcast('status', { status: s }));

// ---- Auto-TLDR for YouTube links (per-chat, server-side) ----
// Watches the realtime event stream; when the user posts a YouTube link in a
// chat they've enabled, it fetches the transcript and posts a Gemini-generated
// TLDR back into that chat (see src/tldr.js). Per-chat on/off persists in a
// gitignored JSON file at the repo root. Without a key it stays idle but the
// toggle still works. TLDR_YTDLP=0 disables the (optional) yt-dlp transcript
// fallback, leaving only the zero-dep HTTP fetch.
// GEMINI_API_KEY is the documented name; GOOGLE_API_KEY is also accepted since
// that's the name Google's own GenAI SDK/tooling uses, so an existing .env works.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const TLDR_YTDLP = !/^(0|false|no)$/i.test(process.env.TLDR_YTDLP || '');
const tldr = createTldr({
  bridge,
  settingsPath: path.join(__dirname, '..', '.tldr-settings.json'),
  apiKey: GEMINI_API_KEY,
  model: GEMINI_MODEL,
  ytDlp: TLDR_YTDLP,
});
tldr.start();

// ---- helpers ----
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ---- attachment byte cache ----
// Attachment bytes are immutable for a given (messageId, index), so we cache the
// decoded Buffers and serve repeats (thumbnail -> lightbox, <video> seek/range)
// without re-hitting the renderer over CDP. Bounded by total bytes; LRU-evicted.
const ATTACH_CACHE = new Map(); // key -> { buf: Buffer, contentType: string }
let attachCacheBytes = 0;
const ATTACH_CACHE_MAX = 64 * 1024 * 1024;

// Outbound (send) limits. base64-in-JSON keeps the server zero-dep (no multipart
// parser); base64 inflates raw bytes by ~33%, so the request-body cap is larger
// than the per-file raw ceiling. The whole body also rides inside a CDP evaluate
// expression downstream, so these stay conservative for a first version.
const SEND_BODY_MAX = 48 * 1024 * 1024; // total JSON request body for a send
const SEND_FILE_MAX = 25 * 1024 * 1024; // per-file raw bytes (matches inline view cap)
const SEND_MAX_FILES = 10;
// In-flight fetches, keyed identically to the cache. A <video> fires several
// Range requests at once; without this each would do its own CDP round-trip and
// base64 decode of the whole file. Concurrent misses share one promise instead.
const ATTACH_INFLIGHT = new Map(); // key -> Promise<{ entry } | { error }>

// Resolve an attachment to a cache entry, deduping concurrent identical misses.
function loadAttachment(key, messageId, index, thumb) {
  const cached = attachCacheGet(key);
  if (cached) return Promise.resolve({ entry: cached });
  let pending = ATTACH_INFLIGHT.get(key);
  if (!pending) {
    pending = bridge.getAttachment(messageId, index, { thumbnail: thumb })
      .then((r) => {
        if (!r || !r.ok) return { error: (r && r.error) || 'attachment-error' };
        const buf = Buffer.from(r.base64, 'base64');
        const entry = { buf, contentType: r.contentType || 'application/octet-stream' };
        attachCachePut(key, buf, entry.contentType);
        return { entry };
      })
      .finally(() => ATTACH_INFLIGHT.delete(key));
    ATTACH_INFLIGHT.set(key, pending);
  }
  return pending;
}

function attachCacheGet(key) {
  const v = ATTACH_CACHE.get(key);
  if (v) { ATTACH_CACHE.delete(key); ATTACH_CACHE.set(key, v); } // bump recency
  return v;
}

function attachCachePut(key, buf, contentType) {
  if (buf.length > ATTACH_CACHE_MAX) return; // never cache larger than the whole budget
  const old = ATTACH_CACHE.get(key);
  if (old) attachCacheBytes -= old.buf.length; // overwriting: drop the stale size first
  ATTACH_CACHE.set(key, { buf, contentType });
  attachCacheBytes += buf.length;
  while (attachCacheBytes > ATTACH_CACHE_MAX && ATTACH_CACHE.size > 1) {
    const oldest = ATTACH_CACHE.keys().next().value;
    attachCacheBytes -= ATTACH_CACHE.get(oldest).buf.length;
    ATTACH_CACHE.delete(oldest);
  }
}

// Serve a Buffer with content-type, long immutable caching, and Range support
// (so <video>/<audio> can seek). etagSeed identifies the immutable resource.
function serveBuffer(req, res, buf, contentType, etagSeed) {
  const etag = '"' + etagSeed.replace(/[^\w.:-]/g, '_') + '-' + buf.length + '"';
  const headers = {
    'content-type': contentType,
    'cache-control': 'private, max-age=31536000, immutable',
    etag,
    'accept-ranges': 'bytes',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const mm = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (mm) {
    let start = mm[1] === '' ? null : Number(mm[1]);
    let end = mm[2] === '' ? null : Number(mm[2]);
    if (start === null) { // suffix range: last N bytes
      start = Math.max(0, buf.length - (end || 0));
      end = buf.length - 1;
    } else if (end === null || end >= buf.length) {
      end = buf.length - 1;
    }
    if (start > end || start >= buf.length) {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${buf.length}` });
      return res.end();
    }
    const slice = buf.subarray(start, end + 1);
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${buf.length}`,
      'content-length': slice.length,
    });
    return res.end(slice);
  }
  res.writeHead(200, { ...headers, 'content-length': buf.length });
  res.end(buf);
}

// ---- GIF picker (Giphy) ----
// Server-side proxy so the API key never reaches the browser and we sidestep
// CORS. The browser only ever sends a Giphy gif *id*; the only URLs this server
// fetches are the fixed Giphy API host and the media URLs Giphy's own API hands
// back for that id — a client can't coax it into fetching arbitrary hosts (no
// SSRF surface). With no key set, the picker shows a "set GIPHY_API_KEY" hint
// rather than failing. Get a free key at https://developers.giphy.com.
const GIPHY_API_KEY = process.env.GIPHY_API_KEY || '';
const GIPHY_RATING = process.env.GIPHY_RATING || 'g'; // content-rating ceiling
const GIF_BYTES_MAX = 12 * 1024 * 1024;               // cap on a fetched gif (< SEND_FILE_MAX)
const GIPHY_API = 'https://api.giphy.com/v1/gifs/';

// Call a Giphy gifs endpoint ("search?…", "trending?…", "<id>?…") -> parsed
// JSON. Times out so a slow Giphy can never wedge a request.
async function giphyFetch(endpoint) {
  const res = await fetch(GIPHY_API + endpoint, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`giphy ${res.status}`);
  return res.json();
}

// Trim a Giphy gif object to what the picker grid needs: id + one animated
// preview rendition (used directly as an <img src> and as the optimistic echo).
function gifPreview(g) {
  if (!g || !g.id || !g.images) return null;
  const im = g.images;
  const p = im.fixed_width || im.fixed_height || im.downsized || im.preview_gif;
  if (!p || !p.url) return null;
  return {
    id: String(g.id),
    title: String(g.title || '').slice(0, 140),
    preview: { url: p.url, w: Number(p.width) || 0, h: Number(p.height) || 0 },
  };
}

// Pick a sendable gif rendition: best quality that still fits the byte cap.
// Giphy's per-rendition `url` is the animated .gif (mp4/webp live under other
// keys), so we also guard on the extension. If Giphy ever renames renditions,
// this chain is the one place to repair.
function gifSendable(g) {
  if (!g || !g.images) return null;
  for (const name of ['original', 'downsized_medium', 'downsized', 'fixed_height', 'fixed_width']) {
    const r = g.images[name];
    if (!r || !r.url || !/\.gif(\?|$)/i.test(r.url)) continue;
    if (Number(r.size) > GIF_BYTES_MAX) continue; // too big here; fall through to a smaller one
    return { url: r.url, w: Number(r.width) || 0, h: Number(r.height) || 0 };
  }
  return null;
}

// A friendly download filename derived from the gif's title.
function gifFileName(title) {
  const slug = String(title || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return (slug || 'giphy') + '.gif';
}

async function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = decodeURIComponent(rel.split('?')[0]);
  const filePath = path.join(PUBLIC_DIR, rel);
  // Prevent path traversal outside PUBLIC_DIR.
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[ext] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

function handleSse(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  res.write(`event: status\ndata: ${JSON.stringify({ status: bridge.status })}\n\n`);
  sseClients.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
}

// 503 when Signal isn't reachable, with an actionable hint.
function bridgeError(res, err) {
  const msg = String(err?.message || err);
  if (/Timed out|not connected|not reachable|not found/i.test(msg)) {
    sendJson(res, 503, {
      error: 'signal-unreachable',
      message:
        'Cannot reach Signal Desktop. Make sure it is running with ' +
        `--remote-debugging-port=${CDP_PORT} (run: npm run launch-signal).`,
    });
  } else {
    sendJson(res, 500, { error: 'bridge-error', message: msg });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  try {
    // --- API ---
    if (pathname === '/api/status') {
      let me = null;
      try {
        const p = await bridge.ping();
        me = p?.me || null;
        return sendJson(res, 200, { status: bridge.status, me, conversationCount: p?.conversationCount });
      } catch (err) {
        return sendJson(res, 200, { status: bridge.status, me: null });
      }
    }

    if (pathname === '/api/events' && req.method === 'GET') {
      return handleSse(req, res);
    }

    if (pathname === '/api/conversations' && req.method === 'GET') {
      const includeArchived = url.searchParams.get('archived') === '1';
      const list = await bridge.listConversations({ includeArchived });
      return sendJson(res, 200, { conversations: list });
    }

    // /api/conversations/:id/messages
    let m = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (m && req.method === 'GET') {
      const id = decodeURIComponent(m[1]);
      const older = url.searchParams.get('older') === '1';
      const data = await bridge.getMessages(id, { older });
      return sendJson(res, 200, data);
    }

    // /api/attachments/:messageId/:index   (?thumb=1 -> poster/thumbnail image)
    m = pathname.match(/^\/api\/attachments\/([^/]+)\/(\d+)$/);
    if (m && req.method === 'GET') {
      const messageId = decodeURIComponent(m[1]);
      const index = Number(m[2]);
      const thumb = url.searchParams.get('thumb') === '1';
      const key = `${messageId}:${index}${thumb ? ':t' : ''}`;

      const out = await loadAttachment(key, messageId, index, thumb);
      if (out.error) {
        const code = out.error === 'too-large' ? 413
          : (out.error === 'pending' || out.error === 'no-path') ? 409
          : 404;
        return sendJson(res, code, { error: out.error });
      }
      return serveBuffer(req, res, out.entry.buf, out.entry.contentType, key);
    }

    // /api/conversations/:id/send   { text?, attachments?: [{fileName,contentType,base64,width?,height?}] }
    m = pathname.match(/^\/api\/conversations\/([^/]+)\/send$/);
    if (m && req.method === 'POST') {
      const id = decodeURIComponent(m[1]);
      let body;
      try {
        body = await readBody(req, SEND_BODY_MAX);
      } catch (err) {
        const tooBig = /too large/i.test(String(err?.message));
        return sendJson(res, tooBig ? 413 : 400, { ok: false, error: tooBig ? 'too-large' : 'invalid-body' });
      }
      const text = (body.text || '').toString();
      const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
      if (!text.trim() && !rawAttachments.length) return sendJson(res, 400, { ok: false, error: 'empty' });

      if (rawAttachments.length) {
        if (rawAttachments.length > SEND_MAX_FILES) {
          return sendJson(res, 400, { ok: false, error: 'too-many-files' });
        }
        const files = [];
        for (const a of rawAttachments) {
          if (!a || typeof a.base64 !== 'string' || !a.base64) {
            return sendJson(res, 400, { ok: false, error: 'bad-attachment' });
          }
          // 4 base64 chars -> 3 bytes; cheap decoded-size check before decoding.
          if (Math.floor((a.base64.length * 3) / 4) > SEND_FILE_MAX) {
            return sendJson(res, 413, { ok: false, error: 'file-too-large' });
          }
          files.push({
            fileName: (a.fileName || a.name || 'attachment').toString().slice(0, 255),
            contentType: (a.contentType || 'application/octet-stream').toString(),
            base64: a.base64,
            width: Number(a.width) || undefined,
            height: Number(a.height) || undefined,
          });
        }
        const result = await bridge.sendMedia(id, text, files);
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      const result = await bridge.sendText(id, text);
      return sendJson(res, result.ok ? 200 : 400, result);
    }

    // /api/conversations/:id/messages/:messageId/edit   { text }
    m = pathname.match(/^\/api\/conversations\/([^/]+)\/messages\/([^/]+)\/edit$/);
    if (m && req.method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const messageId = decodeURIComponent(m[2]);
      let body;
      try { body = await readBody(req); }
      catch { return sendJson(res, 400, { ok: false, error: 'invalid-body' }); }
      const text = (body.text || '').toString();
      if (!text.trim()) return sendJson(res, 400, { ok: false, error: 'empty' });
      const result = await bridge.editMessage(id, messageId, text);
      return sendJson(res, result.ok ? 200 : 400, result);
    }

    // /api/conversations/:id/messages/:messageId/delete   { forEveryone? }
    m = pathname.match(/^\/api\/conversations\/([^/]+)\/messages\/([^/]+)\/delete$/);
    if (m && req.method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const messageId = decodeURIComponent(m[2]);
      let body;
      try { body = await readBody(req, 64 * 1024); }
      catch { return sendJson(res, 400, { ok: false, error: 'invalid-body' }); }
      const result = await bridge.deleteMessage(id, messageId, !!body.forEveryone);
      return sendJson(res, result.ok ? 200 : 400, result);
    }

    // /api/conversations/:id/read
    m = pathname.match(/^\/api\/conversations\/([^/]+)\/read$/);
    if (m && req.method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const result = await bridge.markRead(id);
      return sendJson(res, 200, result);
    }

    // /api/conversations/:id/typing
    m = pathname.match(/^\/api\/conversations\/([^/]+)\/typing$/);
    if (m && req.method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const body = await readBody(req);
      const result = await bridge.sendTyping(id, !!body.isTyping);
      return sendJson(res, 200, result);
    }

    // /api/conversations/:id/tldr   GET -> {enabled, configured}; POST {enabled} -> set
    // Pure server state (no bridge call), so the per-chat toggle works even when
    // Signal is unreachable.
    m = pathname.match(/^\/api\/conversations\/([^/]+)\/tldr$/);
    if (m && (req.method === 'GET' || req.method === 'POST')) {
      const id = decodeURIComponent(m[1]);
      if (req.method === 'POST') {
        let body;
        try { body = await readBody(req, 4 * 1024); }
        catch { return sendJson(res, 400, { error: 'invalid-body' }); }
        tldr.setEnabled(id, !!body.enabled);
      }
      return sendJson(res, 200, { enabled: tldr.isEnabled(id), configured: tldr.configured() });
    }

    // GET /api/gif/search?q=&limit=   (empty q -> trending)
    if (pathname === '/api/gif/search' && req.method === 'GET') {
      if (!GIPHY_API_KEY) return sendJson(res, 200, { ok: false, error: 'no-key', results: [] });
      const q = (url.searchParams.get('q') || '').trim();
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 24, 1), 50);
      const common = `api_key=${encodeURIComponent(GIPHY_API_KEY)}&limit=${limit}&rating=${encodeURIComponent(GIPHY_RATING)}`;
      const endpoint = q ? `search?${common}&q=${encodeURIComponent(q)}` : `trending?${common}`;
      try {
        const data = await giphyFetch(endpoint);
        const results = (data.data || []).map(gifPreview).filter(Boolean);
        return sendJson(res, 200, { ok: true, results, poweredBy: 'GIPHY' });
      } catch {
        return sendJson(res, 502, { ok: false, error: 'giphy-unreachable', results: [] });
      }
    }

    // POST /api/conversations/:id/send-gif   { id, text? }
    // The browser passes only a Giphy gif id; the server resolves it to a media
    // URL via Giphy's API, fetches the bytes, and sends through the same
    // sendMedia path as any other attachment (so it lands as a real image/gif).
    m = pathname.match(/^\/api\/conversations\/([^/]+)\/send-gif$/);
    if (m && req.method === 'POST') {
      if (!GIPHY_API_KEY) return sendJson(res, 503, { ok: false, error: 'no-key' });
      const convId = decodeURIComponent(m[1]);
      let body;
      try { body = await readBody(req, 64 * 1024); }
      catch { return sendJson(res, 400, { ok: false, error: 'invalid-body' }); }
      const gifId = String(body.id || '');
      const text = String(body.text || '');
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(gifId)) return sendJson(res, 400, { ok: false, error: 'bad-id' });

      let pick, meta;
      try {
        meta = await giphyFetch(`${gifId}?api_key=${encodeURIComponent(GIPHY_API_KEY)}`);
        pick = gifSendable(meta.data);
      } catch {
        return sendJson(res, 502, { ok: false, error: 'giphy-unreachable' });
      }
      if (!pick) return sendJson(res, 502, { ok: false, error: 'no-rendition' });

      let bytes;
      try {
        const r = await fetch(pick.url, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) return sendJson(res, 502, { ok: false, error: 'gif-fetch-failed' });
        if (Number(r.headers.get('content-length')) > GIF_BYTES_MAX) {
          return sendJson(res, 413, { ok: false, error: 'gif-too-large' });
        }
        bytes = Buffer.from(await r.arrayBuffer());
      } catch {
        return sendJson(res, 502, { ok: false, error: 'gif-fetch-failed' });
      }
      if (bytes.length > GIF_BYTES_MAX) return sendJson(res, 413, { ok: false, error: 'gif-too-large' });

      const file = {
        fileName: gifFileName(meta.data && meta.data.title),
        contentType: 'image/gif',
        base64: bytes.toString('base64'),
        width: pick.w || undefined,
        height: pick.h || undefined,
      };
      const result = await bridge.sendMedia(convId, text, [file]);
      return sendJson(res, result.ok ? 200 : 400, result);
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'not-found' });
    }

    // --- static ---
    return serveStatic(req, res, pathname);
  } catch (err) {
    if (pathname.startsWith('/api/')) return bridgeError(res, err);
    res.writeHead(500).end('Internal error');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Signal web app  ->  http://${HOST}:${PORT}\n`);
  console.log(`  Bridging to Signal Desktop CDP on port ${CDP_PORT} ...`);
});

bridge.on('status', (s) => console.log(`  [bridge] status: ${s}`));
bridge.start().catch((err) => {
  console.error('  [bridge] failed to start:', err.message);
  console.error(`  -> Is Signal running with --remote-debugging-port=${CDP_PORT}? Run: npm run launch-signal`);
});

process.on('SIGINT', () => {
  bridge.stop();
  process.exit(0);
});
