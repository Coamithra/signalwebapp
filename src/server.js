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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const PORT = Number(process.env.PORT || 7700);
const HOST = '127.0.0.1';
const CDP_PORT = Number(process.env.SIGNAL_CDP_PORT || 9222);

const bridge = new SignalBridge({ port: CDP_PORT });

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
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

    // /api/conversations/:id/send
    m = pathname.match(/^\/api\/conversations\/([^/]+)\/send$/);
    if (m && req.method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const body = await readBody(req);
      const text = (body.text || '').toString();
      if (!text.trim()) return sendJson(res, 400, { ok: false, error: 'empty' });
      const result = await bridge.sendText(id, text);
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
