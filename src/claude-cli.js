// Talking to the `claude` CLI as an installation, rather than as a model.
//
// src/tldr.js owns the prompts and the summary runs; this owns the two things
// that are about the CLI *itself* — is it logged in, and can we get it logged in
// — plus the scratch cwd both share.
//
// Why any of this exists: `claude -p` runs on the user's Claude subscription via
// the CLI's own stored credentials. When those expire the whole auto-TLDR
// feature goes idle, and until now the only way out was a terminal the user may
// not have open. `claude auth login` turns out to work with no TTY (it prints an
// OAuth URL on stdout and waits for a code on stdin), so the server can drive it
// and the browser can finish it.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function log(...args) { console.log('  [claude]', ...args); }

// A scratch working directory for child `claude` processes.
//
// `claude` discovers project CLAUDE.md, settings and skills from its cwd upward.
// Spawning it inside this repo would load THIS project's instructions into a run
// that only has to summarize a transcript: slower, noisier, and it would couple
// our summaries to whatever the repo's CLAUDE.md happens to say that week. An
// empty dir of our own has nothing project-scoped to discover. (User-level
// config is a separate axis, and `--setting-sources ""` on the spawn is what
// excludes that -- cwd alone would not.)
//
// Never fall back to os.tmpdir() itself: the temp root is full of other
// processes' files and is a plausible discovery root, which is the exact thing
// this is avoiding. A fixed named subdirectory is the fallback instead, and is
// also what keeps a crash-restart loop from minting a new mkdtemp per boot.
let scratchDir = null;
export function runDir() {
  if (scratchDir && fs.existsSync(scratchDir)) return scratchDir;
  const fixed = path.join(os.tmpdir(), 'sb-tldr');
  try {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tldr-'));
    // Best-effort: the dir stays empty, but leaving one per server start behind
    // in %TEMP% forever is untidy.
    process.once('exit', () => { try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch {} });
  } catch {
    try { fs.mkdirSync(fixed, { recursive: true }); } catch { /* fall through */ }
    scratchDir = fixed;
  }
  return scratchDir;
}

// ---- is it logged in? -------------------------------------------------------

// Parse `claude auth status --json`, which prints
// `{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}`.
//
// Returns true/false, or null for output we could not read — null means "no
// answer", never "logged out", because the caller uses a definite `false` to
// latch the feature off and a guess would latch it off over a CLI version that
// changed its output shape.
export function parseAuthStatus(stdout) {
  const s = String(stdout ?? '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let obj;
  try { obj = JSON.parse(s.slice(start, end + 1)); } catch { return null; }
  if (!obj || typeof obj !== 'object' || typeof obj.loggedIn !== 'boolean') return null;
  return obj.loggedIn;
}

const STATUS_TIMEOUT_MS = 20_000;

// Ask the CLI whether it is logged in.
//
// ⚠️ This is the probe `claude --version` could never be. `--version` exits 0 for
// an installed-but-logged-out CLI, which is how the feature once reported itself
// "configured" while every summary died at claude-auth. `auth status` reports
// login state directly — and, verified against a credentials file whose token
// had expired with no refresh token, reports `loggedIn: false` rather than
// merely "there is a token on disk".
//
// Resolves { ok: true, loggedIn } or { ok: false, reason: 'not-found' |
// 'unreadable' }. Note the CLI exits **1** when logged out, so the exit code is
// not a usable signal on its own — stdout is parsed first and the exit code only
// consulted when there was nothing to parse.
export function authStatus(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['auth', 'status', '--json'], {
      cwd: runDir(), timeout: STATUS_TIMEOUT_MS, windowsHide: true,
    }, (err, stdout) => {
      // EINVAL alongside ENOENT: since the CVE-2024-27980 fix, Node refuses to
      // execFile a .cmd/.bat without a shell, which is exactly the shape an
      // npm-installed `claude` has on Windows.
      if (err && (err.code === 'ENOENT' || err.code === 'EINVAL')) {
        return resolve({ ok: false, reason: 'not-found' });
      }
      const loggedIn = parseAuthStatus(stdout);
      if (loggedIn === null) return resolve({ ok: false, reason: 'unreadable' });
      resolve({ ok: true, loggedIn });
    });
  });
}

// ---- getting it logged in ---------------------------------------------------

// Pull the OAuth URL out of `claude auth login`'s output, which looks like:
//
//   Opening browser to sign in…
//   If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?…
//   Paste code here if prompted >
//
// ⚠️ The host allow-list is load-bearing, not tidiness. This URL is handed to the
// browser and rendered as a link the user is being told to click, so anything
// that reached it would be a link we vouched for. Requiring https and an
// Anthropic-operated host means a `claude` on PATH that is not the CLI we think
// it is cannot turn this into a phishing link or a `javascript:` payload.
// Returns null when nothing in the text qualifies.
const AUTH_HOSTS = new Set(['claude.com', 'www.claude.com', 'platform.claude.com', 'console.anthropic.com', 'anthropic.com', 'www.anthropic.com']);
export function parseAuthUrl(text) {
  for (const raw of String(text ?? '').match(/https:\/\/[^\s'"<>]+/g) || []) {
    // Trailing sentence punctuation is not part of the URL.
    const trimmed = raw.replace(/[.,;)\]]+$/, '');
    let u;
    try { u = new URL(trimmed); } catch { continue; }
    if (u.protocol !== 'https:' || !AUTH_HOSTS.has(u.hostname)) continue;
    return u.toString();
  }
  return null;
}

// The code pasted back from the sign-in page. Shape-checked before it is written
// to the child's stdin: one line, printable ASCII, bounded. This is a
// belt-and-braces guard on a value that goes to a subprocess — a newline is the
// one character that could turn a single stdin write into two answers.
const CODE_MAX = 512;
export function validCode(code) {
  const s = String(code ?? '').trim();
  if (!s || s.length > CODE_MAX) return null;
  if (!/^[\x21-\x7e]+$/.test(s)) return null;
  return s;
}

// How long to wait for the child to print its URL before giving up on it.
const URL_TIMEOUT_MS = 30_000;
// How long a started-but-unfinished login is allowed to sit holding a child
// process. Signing in takes a minute or two; this is the runaway ceiling.
const PENDING_TIMEOUT_MS = 10 * 60_000;
// How long to wait for the child to exit after the code goes in.
const CODE_TIMEOUT_MS = 60_000;

// A browser-driven `claude auth login`.
//
// ⚠️ **The browser normally finishes the login by itself.** The CLI's prompt
// reads "Paste code here *if prompted*", and that qualifier is the whole story:
// the usual path is that the sign-in page calls back, the child exits logged in,
// and the user is never shown a code at all. Building this around the code field
// as the primary path produced a bubble demanding a code that does not exist.
// So the child's **exit** is the signal to watch, and `submitCode` is the
// fallback for the flow that really does prompt.
//
// One pending login at a time, process-wide: begin() on an already-pending login
// returns the SAME url rather than spawning a second child, so a double-click or
// two open tabs cannot leave an orphan holding a half-finished OAuth exchange.
//
// ⚠️ A pasted code is a credential in transit. It arrives over the loopback-only
// HTTP server, goes straight to the child's stdin, and is never logged, echoed
// back, or stored. Keep it that way — every log line in here is a fixed string
// for that reason.
//
// `onLogin` fires once, server-side, the moment a login is observed to have
// succeeded — so the feature comes back even if no browser is watching.
export function createClaudeLogin({ bin = 'claude', onLogin } = {}) {
  // { child, url, timer, exited, loggedIn }. `loggedIn` is null until the
  // post-exit auth check answers, which is what lets the UI tell "still waiting
  // for you" apart from "finished, and here is the verdict".
  let pending = null;

  function clearPending(p) {
    if (!p || pending !== p) return;
    clearTimeout(p.timer);
    pending = null;
  }

  function kill(p) {
    if (!p) return;
    clearPending(p);
    try { p.child.kill(); } catch {}
  }

  // Called once the child exits, however it got there. Asks the credential store
  // whether the login actually took — the child's exit code is not the authority
  // on that, and this is the same ground truth submitCode uses.
  function settle(p) {
    if (pending !== p) return Promise.resolve();
    // Memoized: the exit handler starts this, and submitCode awaits the same
    // promise rather than racing a second auth check against the first.
    if (!p.settling) {
      p.settling = (async () => {
        clearTimeout(p.timer);
        const st = await authStatus(bin);
        if (pending !== p) return; // cancelled or superseded while we asked
        p.loggedIn = !!(st.ok && st.loggedIn);
        log(p.loggedIn ? 'login complete.' : 'login ended without signing in.');
        if (p.loggedIn && typeof onLogin === 'function') {
          try { await onLogin(); } catch (e) { log('post-login hook failed:', e.message); }
        }
      })();
    }
    return p.settling;
  }

  return {
    // Where a login got to, for the browser to poll. `waiting` means the child is
    // still running (the user is signing in); once it exits, `loggedIn` carries
    // the verdict. Cheap by construction: the auth check runs ONCE on exit, not
    // per poll -- a spawn every couple of seconds for ten minutes would be an
    // absurd way to ask a question the child already answers by exiting.
    status() {
      if (!pending) return { waiting: false, loggedIn: null };
      return { waiting: !pending.exited, loggedIn: pending.loggedIn };
    },

    // Spawn the CLI's login and resolve once it has told us where to send the
    // user. Resolves { ok: true, url } or { ok: false, error }.
    async begin() {
      // A still-running login is reused; a finished one is cleared out of the
      // way so "log in again" after a failed attempt actually starts a new child
      // rather than handing back a dead URL.
      if (pending && !pending.exited) return { ok: true, url: pending.url };
      pending = null;

      let child;
      try {
        child = spawn(bin, ['auth', 'login'], {
          cwd: runDir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        return { ok: false, error: 'not-found' };
      }
      // The child can exit before we write the code; without this the EPIPE
      // surfaces as an unhandled error event on the stream.
      child.stdin.on('error', () => {});

      const p = { child, url: null, timer: null, exited: false, loggedIn: null };
      pending = p;
      // The normal completion path: the browser calls back, the CLI stores the
      // token and exits. Nobody pastes anything, so this exit is the only signal
      // there is.
      child.on('exit', () => { p.exited = true; settle(p).catch(() => {}); });

      const url = await new Promise((resolve) => {
        let out = '';
        let done = false;
        const finish = (value) => { if (!done) { done = true; resolve(value); } };
        const onChunk = (buf) => {
          // The URL is printed across stdout, but read stderr too: which stream
          // a CLI uses for its human-facing chatter is not a contract.
          out += String(buf);
          const found = parseAuthUrl(out);
          if (found) finish(found);
        };
        child.stdout.on('data', onChunk);
        child.stderr.on('data', onChunk);
        // spawn reports a missing binary asynchronously, unlike execFile.
        child.on('error', () => finish(null));
        child.on('exit', () => finish(null)); // exited without ever offering a URL
        setTimeout(() => finish(null), URL_TIMEOUT_MS).unref?.();
      });

      if (!url) {
        kill(p);
        return { ok: false, error: 'no-url' };
      }
      p.url = url;
      // Don't hold a child forever if the user wanders off mid-sign-in.
      p.timer = setTimeout(() => {
        log('login timed out waiting for the code — cancelled.');
        kill(p);
      }, PENDING_TIMEOUT_MS);
      p.timer.unref?.();
      log('login started — waiting for the code.');
      return { ok: true, url };
    },

    // Hand the pasted code to the waiting child and report whether we ended up
    // logged in. Resolves { ok: true } or { ok: false, error }.
    //
    // The verdict comes from `auth status`, not from the child's exit code: the
    // status call is ground truth about the credential store, and it means a CLI
    // that changes its exit conventions cannot make us report a login that did
    // not happen.
    async submitCode(code) {
      const p = pending;
      if (!p) return { ok: false, error: 'no-pending-login' };
      // Already finished in the browser while the user was hunting for a code to
      // paste -- report the outcome rather than writing into a dead stdin.
      if (p.exited) return p.loggedIn ? { ok: true } : { ok: false, error: 'not-logged-in' };
      const clean = validCode(code);
      if (!clean) return { ok: false, error: 'bad-code' };

      const exited = new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        p.child.on('exit', finish);
        p.child.on('error', finish);
        setTimeout(finish, CODE_TIMEOUT_MS).unref?.();
      });
      try { p.child.stdin.write(clean + '\n'); } catch { /* the verdict below is what counts */ }
      await exited;
      // settle() is what asks the credential store, and the exit handler has
      // already started it; wait for its answer rather than racing a second
      // auth check against it.
      await settle(p);
      return p.loggedIn ? { ok: true } : { ok: false, error: 'not-logged-in' };
    },

    // Drop a login the user backed out of, so the next begin() starts clean.
    cancel() {
      if (!pending) return { ok: true };
      log('login cancelled.');
      kill(pending);
      return { ok: true };
    },
  };
}
