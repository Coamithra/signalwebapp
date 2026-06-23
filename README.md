# Signal Web App

A local web UI for Signal — run your Signal Desktop as a **browser tab** instead of a
separate window. It bridges to your already-running Signal Desktop via the Chrome
DevTools Protocol (CDP), so there's **no reimplementation of Signal's encryption** and
**no separate login**: it rides on the real app, always current.

```
Browser tab (vanilla JS UI)  <—REST + SSE—>  Node server  <—CDP—>  Signal Desktop (:9222)
```

- **Zero dependencies.** Pure Node built-ins + vanilla JS. No `npm install`, no build step.
- **Realtime.** New messages, send receipts, and typing flow in over Server-Sent Events.
- **Non-invasive reads.** Loading a chat's history does **not** move your real Signal window.
- **Local only.** The server binds to `127.0.0.1` and CDP is localhost-only. Nothing is exposed.

## Requirements

- **Signal Desktop**, installed and logged in.
- **Node.js ≥ 22** (for the built-in global `fetch` and `WebSocket`) — https://nodejs.org.
- **Windows** for the one-click launcher and autostart scripts. The server + UI are
  cross-platform; on macOS/Linux just launch Signal with the debug flag yourself (below).

## Get the code

```bash
git clone https://github.com/Coamithra/signalwebapp.git
cd signalwebapp
```

There is **no `npm install`** — the app has zero dependencies.

## Run it

### Easiest (Windows): double-click `start.bat`

[`start.bat`](start.bat) launches Signal into the system tray with remote debugging, starts
the local server, and opens the tab in your browser. Keep its console window open while you
use Signal; close it (or Ctrl+C) to stop.

### Manual / cross-platform

**1. Launch Signal with remote debugging** (quits any running Signal and relaunches it in the tray):

```powershell
npm run launch-signal
```

This runs [`scripts/launch-signal.ps1`](scripts/launch-signal.ps1). To do it by hand:
- **Windows:** `& "$env:LOCALAPPDATA\Programs\signal-desktop\Signal.exe" --remote-debugging-port=9222 --start-in-tray`
- **macOS:** `/Applications/Signal.app/Contents/MacOS/Signal --remote-debugging-port=9222`
- **Linux:** `signal-desktop --remote-debugging-port=9222`

**2. Start the server:** `npm start`

**3. Open the tab:** http://127.0.0.1:7700 — pin it and you're done.

> The status dot (top-left) is **green** when connected to Signal, **amber** while
> connecting, **red** if Signal isn't reachable (relaunch it with the debug port).

## Autostart on login (set it and forget it)

So the tab is just *there* after you boot — double-click [`install-autostart.bat`](install-autostart.bat),
or run:

```powershell
npm run autostart:install     # remove later with: npm run autostart:remove
```

This drops a hidden launcher in your Startup folder ([scripts/autostart.ps1](scripts/autostart.ps1)
via a tiny VBScript shim) that, on each login:

1. **Ensures Signal has the debug port.** Signal's own "Open at login" launches it
   *without* `--remote-debugging-port`, so the launcher quietly relaunches Signal into the
   system tray *with* the flag if the port isn't already open.
2. **Starts the bridge server** hidden and detached (no console window).

It's idempotent — if everything's already running, it does nothing.

> **Recommended:** once the autostart is installed, turn **off** Signal's own
> *Settings → General → "Start Signal on system boot"* and keep *"Minimize to system
> tray"* on. The launcher then starts Signal once, cleanly, with the flag — no
> redundant relaunch on boot. (Leaving Signal's boot option on still works; the launcher
> just reconciles it with a quick invisible relaunch.)

**Then, on the Chrome side** (one-time): open http://127.0.0.1:7700, **right-click the
tab → Pin**, and set Chrome **Settings → On startup → Continue where you left off**.
Now the pinned tab reopens with Chrome and reconnects on its own — if it loads before the
server is ready, the status dot goes amber→green and the chat list fills in automatically.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Status dot **red** / "Cannot reach Signal Desktop" | Signal isn't running with the debug port. Run `npm run launch-signal` (or `start.bat`). Signal's normal shortcut/login-launch does **not** include the flag. |
| `npm start` prints "failed to start" | Same as above — Signal needs `--remote-debugging-port=9222`. |
| Empty/black right pane, or the list won't scroll | Hard-refresh the tab (Ctrl+Shift+R) to pick up the latest assets. |
| Tab stuck "connecting" after a Signal update | Signal may have changed internals. Restart the server; if it persists, the fix is usually localized to [`src/page-api.js`](src/page-api.js). |
| Port 7700 already in use | Set a different port: `set PORT=7800 && npm start` (PowerShell: `$env:PORT=7800; npm start`). |

## What works

- Conversation list (sorted, pinned, unread badges, mute/typing indicators)
- Message history with day dividers, group sender names, delivery/read ticks, reactions
- Sending text messages (Enter to send, Shift+Enter for newline)
- Attachments shown as labelled chips (📷 / 🎬 / 🎤 / 📎) — inline image/media rendering is
  the first card on the [board](https://trello.com/b/xPTe6ZZx)
- Live updates via SSE; auto-reconnect if Signal restarts or reloads

## Configuration

| Env var            | Default       | Purpose                          |
|--------------------|---------------|----------------------------------|
| `PORT`             | `7700`        | Web server port                  |
| `SIGNAL_CDP_PORT`  | `9222`        | Signal Desktop remote-debug port |
| `SIGNAL_CDP_HOST`  | auto (probe)  | Pin the CDP host. Unset: probe `127.0.0.1` then `::1` and accept whichever exposes Signal. Set to one host (e.g. `127.0.0.1`) as an escape hatch. |

## Architecture

| File | Responsibility |
|------|----------------|
| [`src/cdp.js`](src/cdp.js) | Generic CDP client. Tracks Signal's **isolated** execution context (where its internals live) across reloads; auto-reconnects. |
| [`src/page-api.js`](src/page-api.js) | The JS injected **into Signal's context**. Defines `window.__sb` (list/read/send/typing) and a redux subscriber that queues realtime change events. |
| [`src/bridge.js`](src/bridge.js) | Composes CDP + injected API into clean async methods; drains the in-page event queue and emits realtime events. |
| [`src/server.js`](src/server.js) | HTTP server: REST API, SSE stream, static UI. Binds to localhost only. |
| [`public/`](public/) | The UI — `index.html`, `style.css`, `app.js`. |

### Why this approach

Signal has no official web client by design. Rather than reimplement the Signal
Protocol (X3DH, Double Ratchet, the `textsecure` service layer) — which is enormous
and whose unofficial clients Signal expires every few months — this rides on the real
Signal Desktop. Signal Desktop's app code (`ConversationController`, `reduxStore`,
`conversation.enqueueMessageForSend`, …) is reachable from CDP in the renderer's
**isolated context**, so we call it directly. See [`PLAN.md`](PLAN.md) for the full
research notes and roadmap.

## Caveats

- Signal Desktop must be running with `--remote-debugging-port`.
- These are **undocumented internals**; a future Signal version can rename them.
  The injected API is small and centralized ([`src/page-api.js`](src/page-api.js)) so
  it's easy to repair if something moves.
- Opening a chat marks it read (clearing its unread badge), which sends read receipts
  per your Signal settings — same as Signal Desktop. The `markRead` endpoint
  (`POST /api/conversations/:id/read`) drives this; merely loading history without
  opening the thread does not mark anything read.

## Contributing

Work is tracked on the [Signal Web App Trello board](https://trello.com/b/xPTe6ZZx).
See [CONTRIBUTING.md](CONTRIBUTING.md) for the card → worktree → PR workflow, and
[CLAUDE.md](CLAUDE.md) for the architecture and conventions (especially the CDP
isolated-context gotcha — read it before touching the bridge).

## Roadmap

Tracked on the [board](https://trello.com/b/xPTe6ZZx); see also [`PLAN.md`](PLAN.md) for the
original research notes. Near-term: inline attachment/media rendering, group info & member
lists, message search, and disappearing-message UI.

---

> **Disclaimer:** Unofficial, not affiliated with or endorsed by Signal. It drives Signal
> Desktop's undocumented internals via the Chrome DevTools Protocol, which can break on any
> Signal update. Use at your own risk; it runs entirely on your machine (localhost only).
