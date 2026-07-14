// This module exports a single string of JavaScript that is injected into
// Signal Desktop's *isolated* execution context via CDP `Runtime.evaluate`.
//
// Inside that context it has direct access to Signal's internals:
//   window.reduxStore            - full app state (conversations, messages, ...)
//   window.ConversationController - conversation model registry (.get(id), .getAll())
//   conversation.enqueueMessageForSend(...) - the real send path
//   conversation.loadNewestMessages(...)    - loads history into redux (non-disruptive)
//
// The script installs `window.__sb` (our RPC surface) and a redux subscriber
// that coalesces change events into `window.__sbQueue`, which the Node server
// drains a few times a second and forwards to the browser via SSE.
//
// It is idempotent and self-healing: re-running it (e.g. after Signal reloads
// and spins up a fresh isolated context) is a no-op if already installed.

export const INSTALL_SCRIPT = `(function () {
  if (!window.reduxStore || !window.ConversationController) return 'not-ready';
  // Always (re)define window.__sb below so a server restart hot-swaps the API
  // code. The redux subscriber + queue are installed once (guarded further down).
  window.__sbQueue = window.__sbQueue || [];

  function pushEvent(e) {
    try {
      var q = window.__sbQueue;
      q.push(e);
      if (q.length > 2000) q.splice(0, 1000); // bound memory if server stalls
    } catch (_) {}
  }

  function safeTitle(c) {
    return (c && (c.title || c.profileName || c.name || c.e164 || c.username)) || 'Unknown';
  }

  function formatConversation(c) {
    var lm = c.lastMessage || null;
    return {
      id: c.id,
      type: c.type,
      title: safeTitle(c),
      isMe: !!c.isMe,
      e164: c.e164 || null,
      color: c.color || null,
      lastMessageText: lm ? (lm.text || '') : '',
      lastMessageStatus: lm ? (lm.status || null) : null,
      lastMessageDeleted: lm ? !!lm.deletedForEveryone : false,
      timestamp: c.lastMessageReceivedAtMs || c.timestamp || c.activeAt || 0,
      unreadCount: c.unreadCount || 0,
      markedUnread: !!c.markedUnread,
      isPinned: !!c.isPinned,
      isArchived: !!c.isArchived,
      isBlocked: !!c.isBlocked,
      muted: c.muteExpiresAt ? (c.muteExpiresAt > Date.now()) : false,
      isGroup: c.type === 'group',
      typing: c.typingContactIdTimestamps ? Object.keys(c.typingContactIdTimestamps).length > 0 : false,
    };
  }

  function resolveAuthorTitle(serviceIdOrId) {
    if (!serviceIdOrId) return null;
    try {
      var conv = window.ConversationController.get(serviceIdOrId);
      if (!conv) return null;
      return conv.getTitle ? conv.getTitle() : safeTitle(conv.attributes);
    } catch (_) { return null; }
  }

  // Signal keeps a message's text plain and describes everything else in a
  // parallel bodyRanges array. Two kinds live in there:
  //
  //   - @mentions: a placeholder char (U+FFFC) in the body plus a range carrying
  //     { start, length, mentionAci }. Read raw, the placeholder renders as a
  //     "[OBJ]"/tofu glyph, so we mirror Signal's renderer and splice "@Name"
  //     into the text.
  //   - formatting: { start, length, style } (BOLD=1 … MONOSPACE=5), referencing
  //     text that's really there. The frontend renders these (public/format.js).
  //
  // Splicing a mention changes the text length, which would leave every later
  // style range pointing at the wrong characters — so both are handled together:
  // walk the mentions right-to-left (so earlier splices don't shift the offsets
  // of later ones) and shift the style ranges by each splice's delta as we go.
  function formatBody(body, ranges) {
    var text = body || '';
    var styles = [];
    var mentions = [];
    if (Array.isArray(ranges)) {
      for (var i = 0; i < ranges.length; i++) {
        var r = ranges[i];
        if (!r || typeof r.start !== 'number') continue;
        if (r.mentionAci || r.mentionUuid) mentions.push(r);
        else if (typeof r.style === 'number' && typeof r.length === 'number') {
          styles.push({ start: r.start, length: r.length, style: r.style });
        }
      }
    }
    mentions.sort(function (a, b) { return b.start - a.start; });

    for (var m = 0; m < mentions.length; m++) {
      var mr = mentions[m];
      var name = '@' + (resolveAuthorTitle(mr.mentionAci || mr.mentionUuid) || 'Unknown');
      var len = typeof mr.length === 'number' ? mr.length : 1;
      var end = mr.start + len;
      var delta = name.length - len;
      text = text.slice(0, mr.start) + name + text.slice(end);

      for (var s = 0; s < styles.length; s++) {
        var st = styles[s];
        var stEnd = st.start + st.length;
        if (st.start >= end) st.start += delta;          // wholly after the mention
        else if (stEnd > mr.start) st.length += delta;   // covers it -> grows/shrinks with it
      }
    }

    // Clamp: a malformed range must never make the renderer slice past the end.
    styles = styles.filter(function (st) {
      if (st.start < 0) { st.length += st.start; st.start = 0; }
      if (st.start + st.length > text.length) st.length = text.length - st.start;
      return st.length > 0;
    });
    return { text: text, styles: styles };
  }

  function describeAttachment(a) {
    var ct = (a && a.contentType) || '';
    var kind = 'file';
    if (/^image\\//.test(ct)) kind = 'image';
    else if (/^video\\//.test(ct)) kind = 'video';
    else if (/^audio\\//.test(ct)) kind = 'audio';
    if (a && a.flags === 1) kind = 'voice'; // VOICE_MESSAGE flag
    return {
      kind: kind, contentType: ct, fileName: a.fileName || null, size: a.size || null,
      width: a.width || null, height: a.height || null,
      pending: !!a.pending, error: !!a.error,
      hasThumbnail: !!(a.thumbnail && a.thumbnail.path),
    };
  }

  // Largest attachment we will inline. Bigger files keep the chip — base64 over
  // CDP for a huge video would be slow and memory-heavy. (Separate from the
  // server's larger byte cache; this is just the per-fetch inline ceiling.)
  var MAX_INLINE_ATTACHMENT_BYTES = 25 * 1024 * 1024;

  // Build the renderer-only URL for an attachment. Signal registers an
  // 'attachment://' protocol that decrypts v2 (on-disk encrypted) attachments on
  // the fly given the per-file localKey; we just have to ask for it by 'key'.
  // (Confirmed by probing: 'attachment://v2/<path>?size=&key=&contentType='
  // returns the decrypted bytes with the right content-type. 'localKey=' 400s.)
  function attachmentUrl(a) {
    var v = a.version || 1;
    if (v >= 2) {
      var qs = 'size=' + (a.size || 0) + '&key=' + encodeURIComponent(a.localKey || '');
      if (a.contentType) qs += '&contentType=' + encodeURIComponent(a.contentType);
      return 'attachment://v2/' + a.path + '?' + qs;
    }
    // v1: legacy unencrypted-on-disk attachments. Best-effort.
    return 'attachment://v1/' + a.path + (a.contentType ? '?contentType=' + encodeURIComponent(a.contentType) : '');
  }

  function b64FromArrayBuffer(buf) {
    var bytes = new Uint8Array(buf);
    var binary = '';
    var CHUNK = 0x8000; // chunk to avoid call-stack overflow on large buffers
    for (var i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  // Decode a standard (padded) base64 string to bytes WITHOUT janking Signal's
  // UI thread. This runs in the renderer via CDP evaluate, so a slow synchronous
  // decode freezes the user's real Signal window. Current Signal (Chrome 140+)
  // has the native Uint8Array.fromBase64 — a single native call, ~30x faster than
  // a per-byte JS loop and with no intermediate binary string (also halving peak
  // transient memory for a big file). Older builds fall back to a chunked atob
  // that yields to the event loop between slices so renders aren't blocked (a
  // 25 MB attachment is ~33 MB of base64). We can't fetch() a data: URL to decode
  // natively off-thread — Signal's CSP blocks data: in connect-src (probed).
  // Input is the client's readAsDataURL output: standard alphabet, padded.
  async function base64ToBytes(b64) {
    if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
    // Fallback for pre-Chrome-140 Signal. Input is standard padded base64 (length
    // a multiple of 4); reject anything else so we fail like atob/native rather
    // than silently under-allocating from fractional length math below.
    if (b64.length % 4 !== 0) throw new Error('bad base64 length');
    var pad = b64.charCodeAt(b64.length - 1) === 61
      ? (b64.charCodeAt(b64.length - 2) === 61 ? 2 : 1) : 0; // 61 = '='
    var out = new Uint8Array((b64.length / 4) * 3 - pad);
    var SLICE = 0x10000 * 4; // 256K base64 chars (4-aligned) -> 192 KB of bytes
    var o = 0;
    for (var pos = 0; pos < b64.length; pos += SLICE) {
      var bin = atob(b64.slice(pos, pos + SLICE));
      for (var k = 0; k < bin.length; k++) out[o++] = bin.charCodeAt(k);
      // Yield to the event loop between slices so the UI can paint; no need on
      // the last/only slice.
      if (pos + SLICE < b64.length) await new Promise(function (r) { setTimeout(r, 0); });
    }
    return out;
  }

  // Aggregate per-recipient send state into a single status for outgoing msgs.
  function computeOutgoingStatus(m) {
    if (Array.isArray(m.errors) && m.errors.length) return 'error';
    var map = m.sendStateByConversationId;
    if (!map) return m.status || 'sent';
    var rank = { Pending: 0, Sending: 0, Sent: 1, Delivered: 2, Read: 3, Viewed: 3, Failed: -1 };
    var best = null, anyFailed = false, allPending = true;
    for (var k in map) {
      var st = map[k] && map[k].status;
      if (st === 'Failed') anyFailed = true;
      if (st && st !== 'Pending' && st !== 'Sending') allPending = false;
      if (st && (best === null || rank[st] > rank[best])) best = st;
    }
    if (best === 'Read' || best === 'Viewed') return 'read';
    if (best === 'Delivered') return 'delivered';
    if (best === 'Sent') return 'sent';
    if (anyFailed) return 'error';
    return 'sending';
  }

  function formatMessage(m) {
    if (!m) return null;
    var direction = m.type === 'incoming' ? 'incoming'
                  : m.type === 'outgoing' ? 'outgoing'
                  : 'system';
    var authorTitle = direction === 'incoming'
      ? resolveAuthorTitle(m.sourceServiceId || m.source) : null;
    var attachments = Array.isArray(m.attachments) ? m.attachments.map(describeAttachment) : [];
    var reactions = Array.isArray(m.reactions) ? m.reactions.map(function (r) {
      return { emoji: r.emoji, from: resolveAuthorTitle(r.fromId) };
    }) : [];
    var status = direction === 'outgoing' ? computeOutgoingStatus(m) : null;
    var formatted = formatBody(m.body || '', m.bodyRanges);
    return {
      id: m.id,
      direction: direction,
      type: m.type,
      text: formatted.text,
      // Formatting only (mentions are already inlined into the text above), with
      // offsets realigned to it.
      bodyRanges: formatted.styles,
      authorTitle: authorTitle,
      authorId: m.sourceServiceId || m.source || null,
      timestamp: m.sent_at || m.timestamp || m.received_at_ms || 0,
      status: status,
      readStatus: m.readStatus,
      attachments: attachments,
      reactions: reactions,
      deletedForEveryone: !!m.deletedForEveryone,
      isViewOnce: !!m.isViewOnce,
      isErased: !!m.isErased,
      hasError: Array.isArray(m.errors) && m.errors.length > 0,
      expireTimer: m.expireTimer || null,
      // Set once a message has been edited (Signal records an edit revision +
      // timestamp). Lets the UI show an "Edited" marker like Signal's own.
      edited: !!(m.editMessageTimestamp || (Array.isArray(m.editHistory) && m.editHistory.length > 1)),
    };
  }

  window.__sb = {
    ping: function () {
      var s = window.reduxStore.getState();
      var me = null;
      try {
        var meConv = Object.values(s.conversations.conversationLookup).find(function (c) { return c.isMe; });
        me = meConv ? { id: meConv.id, title: safeTitle(meConv) } : null;
      } catch (_) {}
      return {
        ok: true,
        conversationCount: Object.keys(s.conversations.conversationLookup).length,
        me: me,
      };
    },

    listConversations: function (opts) {
      opts = opts || {};
      var s = window.reduxStore.getState();
      var lookup = s.conversations.conversationLookup;
      var out = [];
      for (var id in lookup) {
        var c = lookup[id];
        if (!c) continue;
        if (c.isArchived && !opts.includeArchived) continue;
        if (!c.activeAt && !c.isPinned) continue;
        out.push(formatConversation(c));
      }
      out.sort(function (a, b) {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        return (b.timestamp || 0) - (a.timestamp || 0);
      });
      return out;
    },

    getMessages: async function (id, opts) {
      opts = opts || {};
      var conv = window.ConversationController.get(id);
      if (!conv) return { error: 'conversation-not-found' };
      try {
        if (opts.older) {
          var st0 = window.reduxStore.getState().conversations.messagesByConversation[id];
          var oldestId = st0 && st0.messageIds && st0.messageIds.length ? st0.messageIds[0] : undefined;
          if (oldestId) await conv.loadOlderMessages(oldestId);
        } else {
          // loadNewestMessages() RESETS the loaded window to just the newest page,
          // which would discard any older messages the user expanded via "Load
          // older". This no-older path also serves the initial open (redux
          // empty -> loadNewestMessages). The background refresh (triggered by
          // the same redux change loadOlder causes, and by every new message)
          // hits this path, so calling
          // it unconditionally makes "Load older" appear broken: the older messages
          // flash in, then the next refresh collapses them away. Only (re)load when
          // the newest message isn't already in the window — once it is, redux
          // already tracks new arrivals and status changes, so we just read it.
          var st1 = window.reduxStore.getState().conversations.messagesByConversation[id];
          var ids1 = st1 && st1.messageIds ? st1.messageIds : null;
          var newestLoaded = !!(st1 && st1.metrics && st1.metrics.newest && ids1 && ids1.length &&
            st1.metrics.newest.id === ids1[ids1.length - 1]);
          if (!newestLoaded) await conv.loadNewestMessages(undefined, undefined);
        }
      } catch (e) {
        return { error: 'load-failed', detail: String(e) };
      }
      var s = window.reduxStore.getState();
      var mbc = s.conversations.messagesByConversation[id];
      var lookup = s.conversations.messagesLookup;
      var ids = (mbc && mbc.messageIds) || [];
      var messages = [];
      for (var i = 0; i < ids.length; i++) {
        var fm = formatMessage(lookup[ids[i]]);
        if (fm) messages.push(fm);
      }
      var convRedux = s.conversations.conversationLookup[id];
      var metrics = mbc && mbc.metrics ? mbc.metrics : null;
      return {
        conversation: convRedux ? formatConversation(convRedux)
          : { id: id, title: (conv.getTitle ? conv.getTitle() : 'Unknown'), type: conv.get('type') },
        messages: messages,
        oldestLoaded: ids.length ? ids[0] : null,
        hasOlder: metrics ? (metrics.oldest && ids.length && metrics.oldest.id !== ids[0]) : false,
      };
    },

    // Fetch decrypted attachment bytes for a loaded message, base64-encoded.
    // The message must already be in redux (it is whenever the UI shows it).
    // opts.thumbnail -> return the small poster image instead of the full media.
    getAttachment: async function (messageId, index, opts) {
      opts = opts || {};
      try {
        var lookup = window.reduxStore.getState().conversations.messagesLookup || {};
        var m = lookup[messageId];
        if (!m || !Array.isArray(m.attachments)) return { ok: false, error: 'message-not-loaded' };
        var a = m.attachments[index];
        if (!a) return { ok: false, error: 'attachment-not-found' };
        if (opts.thumbnail) {
          if (!a.thumbnail || !a.thumbnail.path) return { ok: false, error: 'no-thumbnail' };
          a = a.thumbnail;
        }
        if (a.pending) return { ok: false, error: 'pending' };
        if (!a.path) return { ok: false, error: 'no-path' };
        if ((a.version || 1) >= 2 && !a.localKey) return { ok: false, error: 'no-key' };
        if (a.size && a.size > MAX_INLINE_ATTACHMENT_BYTES) return { ok: false, error: 'too-large', size: a.size };
        var r = await fetch(attachmentUrl(a));
        if (!r.ok) return { ok: false, error: 'fetch-failed', status: r.status };
        var buf = await r.arrayBuffer();
        // Re-check against actual bytes: some attachments carry no size field,
        // which would otherwise bypass the inline cap above.
        if (buf.byteLength > MAX_INLINE_ATTACHMENT_BYTES) return { ok: false, error: 'too-large', size: buf.byteLength };
        return {
          ok: true,
          contentType: a.contentType || 'application/octet-stream',
          size: buf.byteLength,
          base64: b64FromArrayBuffer(buf),
        };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },

    // bodyRanges: optional [{ start, length, style }] — the formatting the
    // composer parsed out of its markdown-ish syntax. Signal's own composer
    // produces the identical shape from its toolbar. Sanitized server-side.
    sendText: async function (id, body, bodyRanges) {
      var conv = window.ConversationController.get(id);
      if (!conv) return { ok: false, error: 'conversation-not-found' };
      if (typeof body !== 'string' || !body.length) return { ok: false, error: 'empty-body' };
      try {
        await conv.enqueueMessageForSend(
          { body: body, attachments: [], preview: [], bodyRanges: Array.isArray(bodyRanges) ? bodyRanges : [] },
          { dontClearDraft: true },
        );
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },

    // Send a message with one or more attachments (optionally with a text body).
    // files: [{ fileName, contentType, base64, width?, height? }].
    //
    // We pass *in-memory* attachment objects ({ data, contentType, size,
    // fileName }) straight to enqueueMessageForSend — the SAME primitive
    // sendText uses. Signal's own send path finalizes each one: it writes and
    // encrypts the bytes to disk (v2 + per-file localKey), generates a
    // thumbnail, uploads to the CDN, and delivers. This deliberately avoids the
    // redux composer (processAttachments/sendMultiMediaMessage): that path is
    // coupled to the conversation being open/mounted in Signal's own window, so
    // driving it headlessly would be fragile and disruptive. (Confirmed by
    // probing the running app — the old window.Signal.Migrations API is gone.)
    sendMedia: async function (id, body, files, bodyRanges) {
      var conv = window.ConversationController.get(id);
      if (!conv) return { ok: false, error: 'conversation-not-found' };
      if (!Array.isArray(files) || !files.length) return { ok: false, error: 'no-files' };
      try {
        var attachments = [];
        for (var i = 0; i < files.length; i++) {
          var f = files[i] || {};
          if (typeof f.base64 !== 'string' || !f.base64) return { ok: false, error: 'empty-file' };
          var data = await base64ToBytes(f.base64);
          var att = {
            contentType: f.contentType || 'application/octet-stream',
            data: data,
            size: data.byteLength,
            fileName: f.fileName || 'attachment',
            pending: false,
          };
          // Dimensions help images render at the right aspect ratio; optional.
          if (f.width) att.width = f.width;
          if (f.height) att.height = f.height;
          attachments.push(att);
        }
        await conv.enqueueMessageForSend(
          {
            body: typeof body === 'string' ? body : '',
            attachments: attachments,
            preview: [],
            bodyRanges: Array.isArray(bodyRanges) ? bodyRanges : [],
          },
          { dontClearDraft: true },
        );
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },

    markRead: async function (id) {
      var conv = window.ConversationController.get(id);
      if (!conv) return { ok: false, error: 'conversation-not-found' };
      try {
        // Signal's markRead takes the newest message as { received_at, sent_at }
        // (received_at drives which messages get marked read; sent_at is only
        // logged), NOT a bare timestamp. Passing Date.now() throws a SQL bind error
        // inside markConversationRead's getUnreadByConversationAndMarkRead, so the
        // read state silently never persisted -- the unread badge reappeared on
        // reload. lastMessageReceivedAt and timestamp on the conversation are
        // (observed to be) the newest message's received_at and sent_at, so we
        // needn't load any messages. (Signal's own redux markConversationRead action
        // is unusable here: it bails when the Signal window isn't the active window,
        // which it never is while we drive it headlessly.)
        var receivedAt = conv.get('lastMessageReceivedAt');
        if (receivedAt != null && conv.markRead) {
          await conv.markRead(
            { received_at: receivedAt, sent_at: conv.get('timestamp') },
            { sendReadReceipts: true }
          );
          // markRead recomputes unreadCount via a throttled async updater; flush it so
          // redux (and our SSE 'conversations' event) reflect the cleared count now
          // instead of up to a throttle window later.
          if (conv.throttledUpdateUnread && conv.throttledUpdateUnread.flush) {
            conv.throttledUpdateUnread.flush();
          }
        } else if (conv.get('unreadCount')) {
          // Unread messages exist but there's no received_at to mark from. Surface it
          // rather than reporting a false success -- a bare { ok: true } here would
          // re-create exactly the swallowed-failure that made the badge come back.
          return { ok: false, error: 'no-lastMessageReceivedAt' };
        }
        // A manual "mark as unread" flag isn't cleared by markRead -- clear it too, or
        // it (like the count) reappears on reload.
        if (conv.get('markedUnread') && conv.setMarkedUnread) {
          conv.setMarkedUnread(false);
        }
        return { ok: true };
      } catch (e) { return { ok: false, error: String(e) }; }
    },

    sendTyping: function (id, isTyping) {
      var conv = window.ConversationController.get(id);
      if (!conv || !conv.notifyTyping) return { ok: false };
      try { conv.notifyTyping({ isTyping: !!isTyping, fromMe: true }); return { ok: true }; }
      catch (e) { return { ok: false, error: String(e) }; }
    },

    // Edit the text of a message you already sent. Routes through Signal's own
    // composer action (the same one its UI fires) — it replaces the body, keeps
    // the message id, records an edit revision, and re-sends per Signal's edit
    // protocol so recipients see the update. Verified to work without the
    // conversation being open. There is NO conversation-model method for this in
    // current Signal (no enqueueEditMessageForSend); the composer thunk is the
    // path. Text-only: any attachments on the message are left untouched.
    editMessage: async function (conversationId, targetMessageId, body, bodyRanges) {
      var conv = window.ConversationController.get(conversationId);
      if (!conv) return { ok: false, error: 'conversation-not-found' };
      if (typeof body !== 'string' || !body.length) return { ok: false, error: 'empty-body' };
      try {
        var r = window.reduxActions.composer.sendEditedMessage(conversationId, {
          targetMessageId: targetMessageId,
          message: body,
          bodyRanges: Array.isArray(bodyRanges) ? bodyRanges : [],
        });
        if (r && typeof r.then === 'function') await r; // thunk returns a promise
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },

    // Delete a message. forEveryone=false deletes it locally only (always works).
    // forEveryone=true is Signal's "unsend": it can fail (outside the time
    // window, send not delivered, or — like Note to Self — no other recipient to
    // retract from). The redux action does NOT throw on failure; instead, on
    // success the message's deletedForEveryone flag flips, and on failure Signal
    // raises a 'DeleteForEveryoneFailed' toast. So for the forEveryone path we
    // briefly watch both signals to return a real ok/fail to the caller (snapshot
    // the prior toast first so a stale one doesn't read as this call's failure).
    // Best-effort: toasts aren't keyed by message, so two unsends racing inside
    // the same window could cross signals, and a failure toast arriving after the
    // poll window reports as pending. The SSE refresh reconciles the true state.
    deleteMessage: async function (conversationId, messageId, forEveryone) {
      var conv = window.ConversationController.get(conversationId);
      if (!conv) return { ok: false, error: 'conversation-not-found' };
      try {
        if (!forEveryone) {
          var r = window.reduxActions.conversations.deleteMessages({
            conversationId: conversationId, messageIds: [messageId],
          });
          if (r && typeof r.then === 'function') await r;
          return { ok: true };
        }
        var prevToast = (window.reduxStore.getState().toast || {}).toast || null;
        var r2 = window.reduxActions.conversations.deleteMessagesForEveryone([messageId]);
        if (r2 && typeof r2.then === 'function') await r2;
        for (var i = 0; i < 30; i++) { // up to ~3s
          var st = window.reduxStore.getState();
          var m = st.conversations.messagesLookup[messageId];
          if (m && m.deletedForEveryone) return { ok: true };
          var t = (st.toast || {}).toast || null;
          if (t && t !== prevToast && t.toastType === 'DeleteForEveryoneFailed') {
            return { ok: false, error: 'delete-for-everyone-failed' };
          }
          await new Promise(function (res) { setTimeout(res, 100); });
        }
        return { ok: true, pending: true }; // SSE refresh reconciles the final state
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  };

  // Realtime: watch redux and queue coalesced change events for the server.
  // Installed exactly once, even across server restarts / re-injections.
  if (!window.__sbSubscribed) {
    window.__sbSubscribed = true;
    var prevLookup;
    var prevMBC;
    window.reduxStore.subscribe(function () {
      try {
        var conv = window.reduxStore.getState().conversations;
        if (conv.conversationLookup !== prevLookup) {
          prevLookup = conv.conversationLookup;
          pushEvent({ type: 'conversations' });
        }
        var mbc = conv.messagesByConversation;
        if (mbc !== prevMBC) {
          if (prevMBC) {
            for (var cid in mbc) {
              if (mbc[cid] !== prevMBC[cid]) pushEvent({ type: 'messages', conversationId: cid });
            }
          }
          prevMBC = mbc;
        }
      } catch (_) {}
    });
  }

  window.__sbInstalled = true;
  return 'installed';
})()`;

/** Drains and clears the in-page event queue. Returns [] if not yet installed. */
export const DRAIN_SCRIPT = `(function () {
  if (!window.__sbInstalled || !Array.isArray(window.__sbQueue)) return { installed: false, events: [] };
  var q = window.__sbQueue;
  window.__sbQueue = [];
  return { installed: true, events: q };
})()`;
