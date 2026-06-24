// High-level Signal bridge. Wraps the CDP client + injected page API into a
// clean async interface, and emits realtime 'event' notifications drained from
// the in-page redux subscriber.

import { EventEmitter } from 'node:events';
import { CdpClient } from './cdp.js';
import { INSTALL_SCRIPT, DRAIN_SCRIPT } from './page-api.js';

export class SignalBridge extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.cdp = new CdpClient(opts);
    this._injected = false;
    this._drainTimer = null;
    this._drainMs = opts.drainMs || 200;
    this.status = 'connecting'; // connecting | ready | disconnected

    this.cdp.on('connected', () => {
      this._injected = false;
    });
    this.cdp.on('context-changed', () => {
      this._injected = false; // fresh isolated context -> must re-inject
    });
    this.cdp.on('disconnected', () => {
      this._injected = false;
      this.status = 'disconnected';
      this.emit('status', this.status);
    });
    this.cdp.on('reconnecting', () => {
      this.status = 'connecting';
      this.emit('status', this.status);
    });
  }

  async start() {
    this.cdp.start();
    await this.cdp.whenReady();
    await this._ensureInjected();
    this.status = 'ready';
    this.emit('status', this.status);
    this._startDrainLoop();
  }

  stop() {
    if (this._drainTimer) clearInterval(this._drainTimer);
    this.cdp.close();
  }

  async _ensureInjected() {
    if (this._injected && this.cdp.isConnected) return;
    const result = await this.cdp.evaluate(INSTALL_SCRIPT);
    if (result === 'not-ready') {
      throw new Error('Signal app not fully loaded yet');
    }
    this._injected = true;
  }

  _startDrainLoop() {
    if (this._drainTimer) clearInterval(this._drainTimer);
    this._drainTimer = setInterval(() => {
      this._drain().catch(() => {
        /* transient during reloads; next tick recovers */
      });
    }, this._drainMs);
  }

  async _drain() {
    if (!this.cdp.isConnected) return;
    if (!this._injected) {
      await this._ensureInjected();
      return;
    }
    const res = await this.cdp.evaluate(DRAIN_SCRIPT);
    if (!res || res.installed === false) {
      this._injected = false;
      return;
    }
    const events = res.events || [];
    if (!events.length) return;

    // Coalesce: at most one 'conversations' event + one per changed conversation.
    let conversationsDirty = false;
    const dirtyMessageConvos = new Set();
    for (const e of events) {
      if (e.type === 'conversations') conversationsDirty = true;
      else if (e.type === 'messages' && e.conversationId) dirtyMessageConvos.add(e.conversationId);
    }
    if (conversationsDirty) this.emit('event', { type: 'conversations' });
    for (const cid of dirtyMessageConvos) {
      this.emit('event', { type: 'messages', conversationId: cid });
    }
  }

  // ---- RPC surface ----

  async _call(method, ...args) {
    await this._ensureInjected();
    const argList = args.map((a) => JSON.stringify(a === undefined ? null : a)).join(', ');
    return this.cdp.evaluate(`window.__sb.${method}(${argList})`);
  }

  ping() {
    return this._call('ping');
  }

  listConversations(opts = {}) {
    return this._call('listConversations', opts);
  }

  getMessages(id, opts = {}) {
    return this._call('getMessages', id, opts);
  }

  getAttachment(messageId, index, opts = {}) {
    return this._call('getAttachment', messageId, index, opts);
  }

  sendText(id, body) {
    return this._call('sendText', id, body);
  }

  // files: [{ fileName, contentType, base64, width?, height? }]. The base64
  // rides inside the evaluate expression (_call JSON-stringifies args), so the
  // server caps total payload size before calling this.
  sendMedia(id, body, files) {
    return this._call('sendMedia', id, body, files);
  }

  markRead(id) {
    return this._call('markRead', id);
  }

  sendTyping(id, isTyping) {
    return this._call('sendTyping', id, isTyping);
  }

  editMessage(conversationId, targetMessageId, body) {
    return this._call('editMessage', conversationId, targetMessageId, body);
  }

  // forEveryone=true is Signal's "unsend" (can fail); false deletes locally only.
  deleteMessage(conversationId, messageId, forEveryone) {
    return this._call('deleteMessage', conversationId, messageId, !!forEveryone);
  }
}
