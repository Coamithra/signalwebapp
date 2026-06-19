# Signal Web App — Project Plan

## Concept

A web-based Signal client that piggybacks on Signal Desktop via the Chrome DevTools Protocol (CDP). Instead of reimplementing Signal's encryption protocol, we inject JavaScript into the running Electron app and call its internal functions directly.

## Architecture

```
Browser (React UI)  <--WebSocket-->  Node.js Server  <--CDP-->  Signal Desktop (port 9222)
```

- **Signal Desktop** runs with `--remote-debugging-port=9222`
- **Node.js backend** connects via CDP, wraps Signal's internals into a clean API
- **React frontend** renders a chat UI and communicates with the backend over WebSocket/REST

## Why This Approach

- No need to reimplement Signal Protocol (X3DH, Double Ratchet, etc.)
- No client expiry issues — we ride on the real app, always up to date
- Signal Desktop is open source (GPLv3) and already does all the heavy lifting
- The alternative (reimplementing the service layer from `ts/textsecure/`) is massive

## Tradeoffs

- Signal Desktop must be running in the background
- Internal APIs are undocumented and can break between versions
- This is a local/personal tool, not a hosted service (CDP is localhost only)
- Signal could disable remote debugging in a future Electron update

---

## Phase 1: CDP Bridge (Node.js Backend)

### Goal
Connect to Signal Desktop via CDP and expose core messaging functions.

### Key Signal Desktop Internals (accessible via `Runtime.evaluate()`)

| Object                          | Purpose                                      |
|---------------------------------|----------------------------------------------|
| `window.ConversationController` | List, find, and open conversations           |
| `window.reduxStore`             | Read full app state (contacts, messages, UI) |
| `window.reduxActions`           | Trigger actions (open conversation, etc.)    |
| `window.textsecure`             | Protocol layer — message sending             |
| `window.Signal`                 | Core namespace with utilities                |
| `window.MessageCache`           | Access cached messages                       |

### Tasks

1. **Set up Node.js project** with TypeScript
   - Dependencies: `chrome-remote-interface`, `express`, `ws`
2. **CDP connection manager** — connect to Signal Desktop on port 9222, handle reconnection
3. **Conversation listing** — call `ConversationController.getAll()` or read from Redux store, return as JSON
4. **Message history** — read messages for a given conversation from the Redux store / MessageCache
5. **Send message** — inject JS that calls Signal's internal send function for a given conversation
6. **Receive messages** — hook into Signal's message pipeline via CDP (either Redux store subscription or debugger breakpoints)
7. **Expose REST + WebSocket API** for the frontend:
   - `GET /api/conversations` — list conversations
   - `GET /api/conversations/:id/messages` — message history
   - `POST /api/conversations/:id/messages` — send a message
   - `WS /ws` — real-time events (new messages, typing indicators, read receipts)

### Reference: signal-bot approach
- Repo: https://github.com/mandatoryprogrammer/signal-bot
- Sends messages by injecting JS templates via `Runtime.evaluate()`
- Receives messages by setting `Debugger.setBreakpointByUrl()` on Signal's message handler
- Only dependency: `chrome-remote-interface`
- Our approach should improve on this — signal-bot uses hardcoded line numbers which break across versions. We should hook into Redux/ConversationController instead.

---

## Phase 2: React Frontend

### Goal
A clean chat UI that talks to the Node.js backend.

### Tasks

1. **Project setup** — Vite + React + TypeScript
2. **Conversation sidebar** — list all conversations with name, avatar, last message preview
3. **Message view** — display message history for selected conversation, auto-scroll
4. **Message input** — text input with send button, enter-to-send
5. **Real-time updates** — WebSocket connection for incoming messages, typing indicators
6. **Basic styling** — clean, Signal-like appearance (dark/light theme)

---

## Phase 3: Polish & Features

- Attachment support (images, files)
- Group conversation support
- Search conversations/messages
- Read receipts / typing indicators
- Notification support (browser notifications for new messages)
- Disappearing messages UI
- Contact/conversation info panel

---

## How to Launch Signal Desktop for Development

```bash
# Windows (default per-user install location)
"%LOCALAPPDATA%\Programs\signal-desktop\Signal.exe" --remote-debugging-port=9222

# macOS
/Applications/Signal.app/Contents/MacOS/Signal --remote-debugging-port=9222

# Linux
signal-desktop --remote-debugging-port=9222
```

Then verify: open `chrome://inspect/#devices` in Chrome, click Configure, add `localhost:9222`. You should see Signal's renderer listed.

---

## Key Resources

- **Signal Desktop source**: https://github.com/signalapp/Signal-Desktop
  - Service layer: `ts/textsecure/` (~28 files)
  - Window types: `ts/window.d.ts`
  - Protobuf schemas: `protos/`
- **Signal protocol docs**: https://signal.org/docs/
- **signal-bot (CDP reference)**: https://github.com/mandatoryprogrammer/signal-bot
- **chrome-remote-interface**: https://github.com/cyrus-and/chrome-remote-interface
- **CDP docs**: https://chromedevtools.github.io/devtools-protocol/
- **Signal server (open source)**: https://github.com/signalapp/Signal-Server
- **signal-cli REST API (alternative approach)**: https://github.com/bbernhard/signal-cli-rest-api
- **Third-party client list**: https://github.com/exquo/signal-soft

---

## Research Notes

### Why Signal doesn't have an official web client
A Signal developer stated: "If we had a 'Signal Web', we could serve a malicious version of the app." Native apps are stored locally and harder to tamper with than code served from a web server each session. (Source: https://aboutsignal.com/blog/signal-web/)

### Alternative approaches considered
1. **signal-cli-rest-api backend** — Docker container wrapping Java CLI. Works but heavy, unaudited, Java dependency.
2. **Extract Signal Desktop's `ts/textsecure/` service layer** — use `@signalapp/libsignal-client` npm + adapted service code. Most "correct" but massive effort, and Signal expires unofficial clients every ~3 months.
3. **CDP bridge (chosen)** — ride on Signal Desktop. Least effort, always current, but requires the desktop app running.
