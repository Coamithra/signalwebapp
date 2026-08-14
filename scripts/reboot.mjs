// Restart the server: free the port, then start it again in the foreground.
//
// Exists because `npm start` fails with EADDRINUSE if the previous server still
// holds 127.0.0.1:7700, and finding that process by hand is three commands of
// netstat/taskkill every time.
//
// Written in Node rather than as a shell script on purpose. `npm run reboot`
// pointed at a .sh resolves `bash` through whatever PATH npm happens to have,
// and on this machine that found **WSL's** bash.exe in System32 rather than
// Git's — which fails with `execvpe(/bin/bash) failed` when no distro is
// installed. Node is the one interpreter this repo can already assume, and it
// needs no shell at all. scripts/reboot.sh is a thin wrapper around this file so
// there is only ever one implementation.
//
// Starts the server from THIS checkout, so calling it inside a worktree runs
// that worktree's code — which is the point when testing a branch.
//
// Usage:  npm run reboot        PORT=7800 npm run reboot

import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 7700);
const HOST = '127.0.0.1';
// Resolve the repo root from this file, not the caller's cwd, so it works from
// anywhere.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const run = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true }); }
  catch { return ''; }
};

// The pid LISTENING on PORT, or null. The LISTENING filter matters: the same
// port shows established connections for every open browser tab, and killing
// one of those would be the wrong process.
function listenerPid() {
  if (process.platform === 'win32') {
    for (const line of run('netstat', ['-ano']).split('\n')) {
      const f = line.trim().split(/\s+/);
      if (f.length >= 5 && f[0] === 'TCP' && f[1].endsWith(`:${PORT}`) && f[3] === 'LISTENING') {
        return Number(f[4]) || null;
      }
    }
    return null;
  }
  const out = run('lsof', ['-ti', `tcp:${PORT}`, '-s', 'TCP:LISTEN']).trim();
  return out ? Number(out.split('\n')[0]) : null;
}

// Can we actually bind it? The authority on "is the port free" — a pid can be
// gone while the socket is still in TIME_WAIT, and racing back into npm start
// then fails with the same EADDRINUSE this script exists to prevent.
const portFree = () => new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', () => resolve(false));
  probe.once('listening', () => probe.close(() => resolve(true)));
  probe.listen(PORT, HOST);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pid = listenerPid();
if (pid) {
  console.log(`port ${PORT} held by pid ${pid} — stopping it`);
  if (process.platform === 'win32') run('taskkill', ['/PID', String(pid), '/F']);
  else { try { process.kill(pid); } catch {} }
} else {
  console.log(`nothing listening on port ${PORT}`);
}

let free = await portFree();
for (let i = 0; i < 20 && !free; i++) { await sleep(250); free = await portFree(); }
if (!free) {
  console.error(`could not free port ${PORT} (pid ${listenerPid() ?? '?'}) — stop it by hand`);
  process.exit(1);
}

console.log(`starting server from ${ROOT}`);
// process.execPath, not `npm start`: no shell, no .cmd resolution, and the child
// is the server itself rather than an npm wrapper that swallows Ctrl+C.
const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
