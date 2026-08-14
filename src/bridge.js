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
      this._setStatus('disconnected');
    });
    this.cdp.on('reconnecting', () => {
      this._setStatus('connecting');
    });
  }

  // Emits only on transition — the drain loop re-asserts 'ready' every tick, and
  // SSE shouldn't carry a status event each 200ms for a status that didn't move.
  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  async start() {
    this.cdp.start();
    await this.cdp.whenReady();
    await this._ensureInjected();
    this._setStatus('ready');
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
      // The way back up: after a reconnect (Signal restarted, context swapped)
      // the handlers above only ever lower the status, so the first successful
      // re-injection is what declares the bridge working again. Without this,
      // /api/status reported 'connecting' forever while every call succeeded —
      // and the frontend's ready-transition self-heal never re-ran.
      this._setStatus('ready');
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

  // Hero image of a link preview: message.preview[index].image.
  getPreviewImage(messageId, index) {
    return this._call('getPreviewImage', messageId, index);
  }

  // Thumbnail beside a quoted reply: message.quote.attachments[0].thumbnail.
  getQuoteThumbnail(messageId) {
    return this._call('getQuoteThumbnail', messageId);
  }

  // Ask Signal to start fetching a link preview for text still being typed, so
  // sendText finds one waiting instead of blocking on the network.
  warmLinkPreview(text) {
    return this._call('warmLinkPreview', text);
  }

  // bodyRanges: optional [{ start, length, style }] formatting (see page-api.js).
  // opts.linkPreview attaches a link preview card (resolved in-page; see
  // page-api.js for why the grab can't happen out here). opts.quoteMessageId
  // makes the message a reply to that message (the quote is built in-page too,
  // out of redux).
  sendText(id, body, bodyRanges, opts = {}) {
    return this._call('sendText', id, body, bodyRanges || [], opts);
  }

  // files: [{ fileName, contentType, base64, width?, height? }]. The base64
  // rides inside the evaluate expression (_call JSON-stringifies args), so the
  // server caps total payload size before calling this. opts as sendText's,
  // minus linkPreview (Signal doesn't card a message carrying media).
  sendMedia(id, body, files, bodyRanges, opts = {}) {
    return this._call('sendMedia', id, body, files, bodyRanges || [], opts);
  }

  markRead(id) {
    return this._call('markRead', id);
  }

  sendTyping(id, isTyping) {
    return this._call('sendTyping', id, isTyping);
  }

  editMessage(conversationId, targetMessageId, body, bodyRanges) {
    return this._call('editMessage', conversationId, targetMessageId, body, bodyRanges || []);
  }

  // forEveryone=true is Signal's "unsend" (can fail); false deletes locally only.
  deleteMessage(conversationId, messageId, forEveryone) {
    return this._call('deleteMessage', conversationId, messageId, !!forEveryone);
  }

  // One reaction per person per message: sending a second emoji replaces the
  // first, and remove=true retracts it.
  sendReaction(conversationId, messageId, emoji, remove) {
    return this._call('sendReaction', conversationId, messageId, emoji, !!remove);
  }
}
