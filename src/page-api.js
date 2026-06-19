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
    };
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
    return {
      id: m.id,
      direction: direction,
      type: m.type,
      text: m.body || '',
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
          await conv.loadNewestMessages(undefined, undefined);
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

    sendText: async function (id, body) {
      var conv = window.ConversationController.get(id);
      if (!conv) return { ok: false, error: 'conversation-not-found' };
      if (typeof body !== 'string' || !body.length) return { ok: false, error: 'empty-body' };
      try {
        await conv.enqueueMessageForSend(
          { body: body, attachments: [], preview: [], bodyRanges: [] },
          { dontClearDraft: true },
        );
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },

    markRead: async function (id) {
      var conv = window.ConversationController.get(id);
      if (!conv) return { ok: false };
      try {
        if (conv.markRead) await conv.markRead(Date.now());
        return { ok: true };
      } catch (e) { return { ok: false, error: String(e) }; }
    },

    sendTyping: function (id, isTyping) {
      var conv = window.ConversationController.get(id);
      if (!conv || !conv.notifyTyping) return { ok: false };
      try { conv.notifyTyping({ isTyping: !!isTyping, fromMe: true }); return { ok: true }; }
      catch (e) { return { ok: false, error: String(e) }; }
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
