// Low-level Chrome DevTools Protocol client for Signal Desktop's renderer.
//
// Signal Desktop runs as Electron with `--remote-debugging-port`. Its app code
// (ConversationController, reduxStore, etc.) lives in the *isolated* execution
// context (Electron's preload world), NOT the main world — so every evaluate
// must target that context's id. Context ids change on reload, so we track
// `Runtime.executionContextCreated` / `...Cleared` and always re-resolve.

import { EventEmitter } from 'node:events';

// Per-host timeout for the /json probe. The DevTools HTTP endpoint is local and
// answers in milliseconds; the cap just stops a hung/half-open host from
// blocking the next candidate (and thus defeating the IPv4→IPv6 fallback).
const PROBE_TIMEOUT_MS = 2500;

export class CdpClient extends EventEmitter {
  /** @param {{ host?: string, port?: number }} [opts] */
  constructor(opts = {}) {
    super();
    // Candidate CDP hosts to probe, in order. Chromium's --remote-debugging-port
    // binds IPv4 loopback (127.0.0.1); the bare name 'localhost' can resolve
    // IPv6-first (::1) and miss Signal entirely, or hit an unrelated debug target
    // squatting on ::1:9222. So when no host is pinned we try IPv4 then IPv6 and
    // only accept the one actually exposing Signal's background.html. An explicit
    // host (SIGNAL_CDP_HOST) is used verbatim as the sole candidate — the escape
    // hatch — so e.g. SIGNAL_CDP_HOST=localhost preserves the old behavior.
    this._hostCandidates = opts.host ? [opts.host] : ['127.0.0.1', '::1'];
    this.host = this._hostCandidates[0]; // updated to the host that resolves
    this.port = opts.port || 9222;
    /** @type {WebSocket|null} */
    this.ws = null;
    this._nextId = 0;
    this._pending = new Map(); // id -> { resolve, reject }
    this._isolatedContextId = null;
    this._connected = false;
    this._closing = false;
    this._reconnectTimer = null;
    /** Promise that resolves when an isolated context is available. */
    this._readyResolvers = [];
  }

  get isConnected() {
    return this._connected && this._isolatedContextId != null;
  }

  get httpBase() {
    return this._baseFor(this.host);
  }

  /** HTTP base URL for a host, bracketing IPv6 literals (e.g. ::1 -> [::1]). */
  _baseFor(host) {
    const bare = host.replace(/^\[|\]$/g, ''); // tolerate a pre-bracketed literal
    const h = bare.includes(':') ? `[${bare}]` : bare;
    return `http://${h}:${this.port}`;
  }

  /** Begin connecting; auto-reconnects until close() is called. */
  start() {
    this._closing = false;
    this._connect().catch((err) => this._scheduleReconnect(err));
  }

  close() {
    this._closing = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }

  /**
   * Resolve the renderer page target (background.html) from CDP's HTTP API.
   * Probes each candidate host (with a short per-host timeout so a hung host
   * doesn't block the next) and accepts only one whose /json actually lists
   * Signal's background.html — so an unrelated debug target on another loopback
   * address (e.g. a separate Chrome on ::1) is skipped rather than connected to.
   * The winning host is recorded on `this.host` so httpBase/diagnostics reflect
   * it; the WebSocket leg follows page.webSocketDebuggerUrl, which Chromium keys
   * to the same loopback we queried.
   */
  async _findRendererTarget() {
    const errors = [];
    for (const host of this._hostCandidates) {
      try {
        const res = await fetch(`${this._baseFor(host)}/json`, {
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`CDP /json returned ${res.status}`);
        const targets = await res.json();
        const page = targets.find(
          (t) => t.type === 'page' && /background\.html/.test(t.url || ''),
        );
        if (page) {
          this.host = host;
          return page;
        }
        throw new Error(`no background.html among ${targets.length} target(s)`);
      } catch (err) {
        errors.push(`${host}: ${err.message}`);
      }
    }
    throw new Error(
      `Signal renderer (background.html) not found on port ${this.port}. ` +
        `Is Signal running with --remote-debugging-port? (${errors.join('; ')})`,
    );
  }

  async _connect() {
    const page = await this._findRendererTarget();
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (e) => reject(new Error('CDP websocket error')));
      ws.addEventListener('message', (ev) => this._onMessage(ev));
      ws.addEventListener('close', () => this._onClose());
    });

    this._connected = true;
    // Capture execution contexts as they are (re)announced on enable.
    await this._send('Runtime.enable');
    await this._send('Page.enable').catch(() => {});
    // Give the replayed executionContextCreated events a beat to arrive.
    await new Promise((r) => setTimeout(r, 300));

    if (this._isolatedContextId == null) {
      // Fallback: query contexts directly if events didn't surface one.
      await this._resolveIsolatedContextById();
    }

    this.emit('connected', { version: page });
    this._flushReady();
  }

  async _resolveIsolatedContextById() {
    // As a fallback, evaluate in default world to find the isolated one is not
    // possible; instead we rely on executionContextCreated. If still unknown,
    // probe by trying contextId values is unreliable — so just wait/retry.
    // (executionContextCreated almost always fires on Runtime.enable.)
  }

  _onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    // Lifecycle of execution contexts.
    if (msg.method === 'Runtime.executionContextCreated') {
      const ctx = msg.params.context;
      if (ctx.auxData && ctx.auxData.type === 'isolated') {
        const changed = this._isolatedContextId !== ctx.id;
        this._isolatedContextId = ctx.id;
        if (changed) {
          this.emit('context-changed', ctx.id);
          this._flushReady();
        }
      }
      return;
    }
    if (msg.method === 'Runtime.executionContextDestroyed') {
      if (msg.params.executionContextId === this._isolatedContextId) {
        this._isolatedContextId = null;
      }
      return;
    }
    if (msg.method === 'Runtime.executionContextsCleared') {
      this._isolatedContextId = null;
      return;
    }
    if (msg.method === 'Runtime.bindingCalled') {
      this.emit('binding', msg.params); // { name, payload, executionContextId }
      return;
    }

    // Command responses.
    if (msg.id != null && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    }
  }

  _onClose() {
    this._connected = false;
    this._isolatedContextId = null;
    this.ws = null;
    // Reject all pending commands.
    for (const { reject } of this._pending.values()) {
      reject(new Error('CDP connection closed'));
    }
    this._pending.clear();
    this.emit('disconnected');
    if (!this._closing) this._scheduleReconnect(new Error('connection closed'));
  }

  _scheduleReconnect(err) {
    if (this._closing) return;
    this.emit('reconnecting', err);
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect().catch((e) => this._scheduleReconnect(e));
    }, 2000);
  }

  _send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('CDP not connected'));
        return;
      }
      const id = ++this._nextId;
      this._pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Wait until an isolated context is available (or timeout). */
  whenReady(timeoutMs = 15000) {
    if (this.isConnected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this._readyResolvers.push(entry);
      entry.timer = setTimeout(() => {
        const i = this._readyResolvers.indexOf(entry);
        if (i >= 0) this._readyResolvers.splice(i, 1);
        reject(new Error('Timed out waiting for Signal CDP connection'));
      }, timeoutMs);
    });
  }

  _flushReady() {
    if (!this.isConnected) return;
    const resolvers = this._readyResolvers;
    this._readyResolvers = [];
    for (const r of resolvers) {
      clearTimeout(r.timer);
      r.resolve();
    }
  }

  /**
   * Evaluate an expression in Signal's isolated context.
   * @param {string} expression
   * @param {{ awaitPromise?: boolean, returnByValue?: boolean }} [opts]
   */
  async evaluate(expression, opts = {}) {
    await this.whenReady();
    const params = {
      expression,
      contextId: this._isolatedContextId,
      returnByValue: opts.returnByValue !== false,
      awaitPromise: opts.awaitPromise !== false,
      userGesture: true,
    };
    let result;
    try {
      result = await this._send('Runtime.evaluate', params);
    } catch (err) {
      // Context may have been swapped out mid-flight; retry once.
      if (/context/i.test(String(err.message))) {
        await this.whenReady();
        result = await this._send('Runtime.evaluate', {
          ...params,
          contextId: this._isolatedContextId,
        });
      } else {
        throw err;
      }
    }
    if (result.exceptionDetails) {
      const ex = result.exceptionDetails;
      throw new Error(
        `Signal eval threw: ${ex.exception?.description || ex.text || 'unknown error'}`,
      );
    }
    return result.result.value;
  }

  /** Register a CDP binding so injected page code can push events to us. */
  async addBinding(name) {
    await this.whenReady();
    // Bind into the isolated context specifically.
    await this._send('Runtime.addBinding', {
      name,
      executionContextId: this._isolatedContextId,
    }).catch(async (err) => {
      // Some Electron builds reject contextId-scoped bindings; fall back to global.
      await this._send('Runtime.addBinding', { name });
    });
  }
}
