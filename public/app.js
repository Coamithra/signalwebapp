// Signal web app — frontend. Talks to the local bridge server over REST,
// receives realtime nudges via SSE, and renders a Signal-like chat UI.

import { parseFormatting, toMarkdown, renderFormatted, shortcodeBefore } from './format.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  conversations: [],
  filtered: null,
  activeId: null,
  me: null,
  nearBottom: true,
  lastActiveTimestamp: 0,
  sending: false,
  pendingAttachments: [], // staged files awaiting send: {id, fileName, contentType, base64, size, kind, width, height, previewUrl}
  messages: [],           // messages of the open thread (for up-arrow quick-edit lookup)
  editing: null,          // { messageId, original } while editing an already-sent message
};

// Outbound media limits — kept in lockstep with the server (src/server.js).
const MAX_PENDING_FILES = 10;
const MAX_PENDING_FILE_BYTES = 25 * 1024 * 1024;
let attachSeq = 0;

// ---------- tiny DOM helper ----------
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v; // only for trusted/static markup
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

// ---------- avatars ----------
const AVATAR_COLORS = [
  '#a84d4d', '#c46a2d', '#b89b2d', '#5e9e54', '#3f9c8f', '#3f7fae',
  '#4a6fd0', '#7059c4', '#9b53b8', '#b8527f', '#7a8a99', '#8a7250',
];
function colorFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function initials(title) {
  const words = (title || '?').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}
function avatarEl(conv, size) {
  const node = el('div', { class: size === 'small' ? 'thread-avatar' : 'conv-avatar' });
  node.style.background = conv.isMe ? '#3a76f0' : colorFor(conv.id);
  node.textContent = conv.isMe ? '★' : initials(conv.title);
  return node;
}

// ---------- time formatting ----------
function fmtListTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const diffDays = (now - d) / 86400000;
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' });
}
function fmtMsgTime(ts) {
  return ts ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
}
function fmtDayDivider(ts) {
  const d = new Date(ts);
  const now = new Date();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  const diffDays = (now - d) / 86400000;
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
}

// ---------- API ----------
async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = j.message || j.error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

// ---------- conversation list ----------
function previewText(conv) {
  if (conv.typing) return '…typing';
  if (conv.lastMessageDeleted) return 'This message was deleted';
  const t = conv.lastMessageText || '';
  return t || (conv.lastMessageStatus ? 'Attachment' : '');
}

function renderConversations() {
  const list = $('#conversationList');
  const items = state.filtered ?? state.conversations;
  const frag = document.createDocumentFragment();

  for (const conv of items) {
    const badge = conv.unreadCount > 0
      ? el('div', { class: 'conv-badge', text: String(conv.unreadCount) })
      : conv.markedUnread
        ? el('div', { class: 'conv-badge dot' })
        : null;

    const previewEl = el('div', { class: 'conv-preview' });
    if (conv.typing) {
      previewEl.appendChild(el('span', { class: 'you', text: 'typing…' }));
    } else {
      previewEl.textContent = previewText(conv);
    }

    const row = el('div', {
      class: 'conv' + (conv.id === state.activeId ? ' active' : ''),
      onclick: () => openConversation(conv.id),
    }, [
      avatarEl(conv, 'large'),
      el('div', { class: 'conv-body' }, [
        el('div', { class: 'conv-top' }, [
          el('div', { class: 'conv-name' }, [
            conv.isPinned ? el('span', { class: 'pin-icon', text: '📌 ' }) : null,
            document.createTextNode(conv.title),
          ]),
          el('div', { class: 'conv-time', text: fmtListTime(conv.timestamp) }),
        ]),
        el('div', { class: 'conv-bottom' }, [
          previewEl,
          conv.muted ? el('span', { class: 'muted-icon', text: '🔕' }) : null,
          badge,
        ]),
      ]),
    ]);
    frag.appendChild(row);
  }

  list.replaceChildren(frag);
}

async function loadConversations() {
  try {
    const { conversations } = await api('/api/conversations');
    state.conversations = conversations;
    maybeMarkActiveRead(); // a new message in the open thread shouldn't leave a badge
    applySearch();
    renderConversations();
    if (state.activeId) {
      const active = conversations.find((c) => c.id === state.activeId);
      if (active && active.timestamp > state.lastActiveTimestamp) {
        scheduleRefreshActive();
      }
    }
  } catch (err) {
    setStatus('disconnected');
  }
}

function applySearch() {
  const q = $('#search').value.trim().toLowerCase();
  state.filtered = q
    ? state.conversations.filter((c) => c.title.toLowerCase().includes(q))
    : null;
}

// ---------- thread ----------
function renderThreadHeader(conv) {
  const av = avatarEl(conv, 'small');
  $('#threadAvatar').replaceWith(Object.assign(av, { id: 'threadAvatar' }));
  $('#threadTitle').textContent = conv.title;
  let sub = '';
  if (conv.isMe) sub = 'Note to Self';
  else if (conv.isGroup) sub = 'Group';
  else if (conv.e164) sub = conv.e164;
  $('#threadSubtitle').textContent = sub;
}

// ---------- attachments ----------
function attachmentChip(att, statusText, href) {
  const icon = att.kind === 'image' ? '🖼️' : att.kind === 'video' ? '🎬'
    : att.kind === 'voice' ? '🎤' : att.kind === 'audio' ? '🎵' : '📎';
  const label = att.fileName || (att.kind === 'image' ? 'Photo' : att.kind === 'video' ? 'Video'
    : att.kind === 'voice' ? 'Voice message' : att.kind === 'audio' ? 'Audio' : 'Attachment');
  const children = [
    el('span', { class: 'att-icon', text: icon }),
    el('span', { class: 'att-label', text: statusText ? `${label} — ${statusText}` : label }),
  ];
  return href
    ? el('a', { class: 'attachment-chip', href, download: att.fileName || '', target: '_blank', rel: 'noopener' }, children)
    : el('div', { class: 'attachment-chip' }, children);
}

function openLightbox(src) {
  const img = el('img', { class: 'lightbox-img', src });
  const overlay = el('div', { class: 'lightbox' }, [img]);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  overlay.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
}

function wrapMedia(node) {
  return el('div', { class: 'att-media-wrap' }, [node]);
}

// Compute an attachment's on-screen pixel box from its stored dimensions,
// clamped to the same limits as .att-media in CSS (max 330px / 60vw wide,
// 340px tall). Setting an explicit width+height reserves the space *before* the
// bytes load, so media that arrives later (over /api/attachments) doesn't reflow
// the thread — which is what lets "load older" keep the viewport anchored.
function mediaBox(att) {
  if (!att.width || !att.height) return null;
  const maxW = Math.min(330, Math.round(window.innerWidth * 0.6));
  const scale = Math.min(maxW / att.width, 340 / att.height, 1);
  return { w: Math.max(1, Math.round(att.width * scale)), h: Math.max(1, Math.round(att.height * scale)) };
}

// Render one attachment by kind. Bytes come from /api/attachments/:id/:index,
// which serves the renderer-decrypted file. Falls back to a chip for
// pending/errored/unsupported attachments (or if the media fails to load).
function attachmentEl(msg, att, i) {
  if (att.pending) return attachmentChip(att, 'Downloading…');
  if (att.error) return attachmentChip(att, 'Unavailable');

  const src = `/api/attachments/${encodeURIComponent(msg.id)}/${i}`;

  if (att.kind === 'image') {
    const img = el('img', { class: 'att-media att-image', src, loading: 'lazy', alt: att.fileName || 'Image' });
    const ibox = mediaBox(att);
    if (ibox) { img.style.width = `${ibox.w}px`; img.style.height = `${ibox.h}px`; }
    img.addEventListener('click', () => openLightbox(src));
    img.addEventListener('error', () => img.replaceWith(attachmentChip(att, "Couldn't load")));
    return wrapMedia(img);
  }
  if (att.kind === 'video') {
    const v = el('video', { class: 'att-media att-video', src, controls: '', preload: 'metadata' });
    const vbox = mediaBox(att);
    if (vbox) { v.style.width = `${vbox.w}px`; v.style.height = `${vbox.h}px`; }
    if (att.hasThumbnail) v.setAttribute('poster', `${src}?thumb=1`);
    v.addEventListener('error', () => v.replaceWith(attachmentChip(att, "Couldn't load")));
    return wrapMedia(v);
  }
  if (att.kind === 'audio' || att.kind === 'voice') {
    const a = el('audio', { class: 'att-audio', src, controls: '', preload: 'metadata' });
    a.addEventListener('error', () => a.replaceWith(attachmentChip(att, "Couldn't load")));
    return el('div', { class: 'att-audio-wrap' }, [
      el('span', { class: 'att-icon', text: att.kind === 'voice' ? '🎤' : '🎵' }),
      a,
    ]);
  }
  // files / unknown types -> downloadable chip
  return attachmentChip(att, null, src);
}

function messageRow(msg, prev, isGroup) {
  if (msg.direction === 'system') return null;

  const sameAuthorAsPrev =
    prev && prev.direction === msg.direction && prev.authorId === msg.authorId &&
    (msg.timestamp - prev.timestamp) < 3 * 60 * 1000;

  const row = el('div', {
    class: `msg-row ${msg.direction} ${sameAuthorAsPrev ? 'tight' : 'loose'}`,
  });
  if (msg.id) row.dataset.mid = msg.id; // stable handle for scroll anchoring on rebuild

  // group sender label on incoming
  if (isGroup && msg.direction === 'incoming' && !sameAuthorAsPrev && msg.authorTitle) {
    const label = el('div', { class: 'msg-author', text: msg.authorTitle });
    label.style.color = colorFor(msg.authorId || msg.authorTitle);
    row.appendChild(label);
  }

  if (msg.deletedForEveryone) {
    appendBubble(row, msg, el('div', { class: 'bubble deleted', text: 'This message was deleted' }));
    return row;
  }

  const bubble = el('div', { class: 'bubble' });

  if (msg.isViewOnce) {
    bubble.appendChild(el('div', { class: 'view-once', text: '👁 View-once media' }));
  } else {
    for (let i = 0; i < (msg.attachments || []).length; i++) {
      bubble.appendChild(attachmentEl(msg, msg.attachments[i], i));
    }
    // Text goes in its own span so bold/italic/etc. (msg.bodyRanges) can be real
    // elements around it, and so an in-place edit can swap just the body.
    if (msg.text) {
      bubble.appendChild(el('span', { class: 'msg-text' }, [renderFormatted(msg.text, msg.bodyRanges)]));
    }
  }
  if (!bubble.childNodes.length) bubble.appendChild(document.createTextNode(' '));
  appendBubble(row, msg, bubble);

  if (msg.reactions && msg.reactions.length) {
    // Group by emoji, keeping the reactor names so hovering a pill shows who reacted.
    const byEmoji = new Map();
    for (const r of msg.reactions) {
      if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, []);
      byEmoji.get(r.emoji).push(r.from || 'Unknown');
    }
    const rx = el('div', { class: 'reactions' });
    for (const [emoji, names] of byEmoji) {
      const n = names.length;
      rx.appendChild(el('span', {
        class: 'reaction-pill',
        text: n > 1 ? `${emoji} ${n}` : emoji,
        title: [...new Set(names)].join(', '),
      }));
    }
    row.appendChild(rx);
  }

  const meta = el('div', { class: 'msg-meta' });
  if (msg.edited) meta.appendChild(el('span', { class: 'edited-label', text: 'Edited' }));
  meta.appendChild(document.createTextNode(fmtMsgTime(msg.timestamp)));
  if (msg.direction === 'outgoing') {
    const tick = el('span', { class: 'tick' });
    if (msg.status === 'read') { tick.className = 'tick read'; tick.textContent = '✓✓'; }
    else if (msg.status === 'delivered') { tick.textContent = '✓✓'; }
    else if (msg.status === 'sent') { tick.textContent = '✓'; }
    else if (msg.status === 'error') { tick.className = 'tick error'; tick.textContent = '⚠'; }
    else { tick.textContent = '🕓'; }
    meta.appendChild(tick);
  }
  row.appendChild(meta);
  return row;
}

// ---------- message actions: hover "…" menu, edit, delete ----------
// Which actions apply to a given message. Edit only makes sense for your own
// text messages; "Delete for everyone" only for your own (Signal's unsend);
// "Delete for me" (local) is always available. Tombstones/incoming get just the
// local delete.
function menuItemsFor(msg) {
  const items = [];
  const isOut = msg.direction === 'outgoing';
  const hasText = !!(msg.text && msg.text.trim());
  if (isOut && hasText && !msg.deletedForEveryone && !msg.isViewOnce) {
    items.push({ label: 'Edit', onClick: () => startEdit(msg) });
  }
  if (isOut && !msg.deletedForEveryone) {
    items.push({ label: 'Delete for everyone', danger: true, onClick: () => confirmDelete(msg, true) });
  }
  items.push({ label: 'Delete for me', danger: true, onClick: () => confirmDelete(msg, false) });
  return items;
}

// The kebab button shown on hover. Null for messages with no id (optimistic
// echoes, not yet sent) or with no applicable actions.
function buildMenuButton(msg) {
  if (!msg.id || msg.direction === 'system') return null;
  if (!menuItemsFor(msg).length) return null;
  const btn = el('button', {
    class: 'msg-menu-btn', title: 'Message actions', 'aria-label': 'Message actions', text: '⋯',
  });
  btn.addEventListener('click', (e) => { e.stopPropagation(); openMessageMenu(msg, btn); });
  return btn;
}

// Lay the bubble out with its hover menu button on the outer edge (or bare if
// there's no menu). Used by both the normal and deleted-tombstone render paths.
function appendBubble(row, msg, bubble) {
  const btn = buildMenuButton(msg);
  if (!btn) { row.appendChild(bubble); return; }
  row.appendChild(el('div', { class: 'bubble-wrap' },
    msg.direction === 'outgoing' ? [btn, bubble] : [bubble, btn]));
}

let closeMessageMenu = () => {};
function openMessageMenu(msg, anchorBtn) {
  closeMessageMenu();
  const items = menuItemsFor(msg);
  if (!items.length) return;
  const menu = el('div', { class: 'msg-menu' });
  for (const it of items) {
    menu.appendChild(el('button', {
      class: 'msg-menu-item' + (it.danger ? ' danger' : ''), text: it.label,
      onclick: () => { closeMessageMenu(); it.onClick(); },
    }));
  }
  document.body.appendChild(menu);

  // Anchor under the button, right-aligned; flip above if it would overflow.
  const r = anchorBtn.getBoundingClientRect();
  let left = Math.max(6, r.right - menu.offsetWidth);
  let top = r.bottom + 4;
  if (top + menu.offsetHeight > window.innerHeight - 6) top = r.top - menu.offsetHeight - 4;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(Math.max(6, top))}px`;

  const onDocClick = (e) => { if (!menu.contains(e.target)) closeMessageMenu(); };
  const onKey = (e) => { if (e.key === 'Escape') closeMessageMenu(); };
  const onScroll = () => closeMessageMenu();
  // Defer the doc-click listener so the click that opened the menu doesn't close it.
  setTimeout(() => document.addEventListener('click', onDocClick), 0);
  document.addEventListener('keydown', onKey);
  $('#messages').addEventListener('scroll', onScroll, { passive: true });
  closeMessageMenu = () => {
    menu.remove();
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKey);
    $('#messages').removeEventListener('scroll', onScroll);
    closeMessageMenu = () => {};
  };
}

// Find a rendered message row by its stable id (set as data-mid).
function rowByMid(mid) {
  for (const row of $('#messagesInner').children) {
    if (row.dataset && row.dataset.mid === mid) return row;
  }
  return null;
}

// The newest of your own editable text messages — used by the ↑ quick-edit.
// Reads state.messages (the loaded/rendered window), so a message you *just* sent
// isn't selectable until the next refresh gives it a real id — until then ↑ edits
// the previous one. That brief window matches how the optimistic echo works.
function lastEditableOutgoing() {
  const msgs = state.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.direction === 'outgoing' && m.text && m.text.trim() && !m.deletedForEveryone && !m.isViewOnce) return m;
  }
  return null;
}

// ----- edit mode (composer) -----
function startEdit(msg) {
  if (!msg || !msg.id) return;
  // Put the composer's own syntax back in the box, so editing an italic message
  // shows "_like this_" and doesn't silently strip the formatting on save.
  const source = toMarkdown(msg.text || '', msg.bodyRanges);
  state.editing = { messageId: msg.id, original: source };
  const input = $('#composerInput');
  input.value = source;
  $('#editBanner').classList.remove('hidden');
  autoGrow();
  updateSendEnabled();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function cancelEdit() {
  if (!state.editing) return;
  state.editing = null;
  $('#editBanner').classList.add('hidden');
  const input = $('#composerInput');
  input.value = '';
  autoGrow();
  updateSendEnabled();
}

async function submitEdit() {
  const input = $('#composerInput');
  const editing = state.editing;
  const raw = input.value.trim();
  if (!editing || !state.activeId || state.sending) return;
  if (!raw) { toast('Message is empty — delete it instead', true); return; }
  if (raw === (editing.original || '').trim()) { cancelEdit(); return; } // no change
  const { text, bodyRanges } = parseFormatting(raw);
  if (!text.trim()) { toast('Message is empty — delete it instead', true); return; }
  const id = state.activeId;
  const messageId = editing.messageId;
  state.sending = true;
  updateSendEnabled();

  // Optimistic: update the bubble text in place. Keep edit mode active until the
  // server confirms, so a failure leaves the user's text right where they can retry.
  const row = rowByMid(messageId);
  const textEl = row ? row.querySelector('.bubble .msg-text') : null;
  if (textEl) textEl.replaceChildren(renderFormatted(text, bodyRanges));

  try {
    const r = await api(`/api/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/edit`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, bodyRanges }),
    });
    if (!r.ok) throw new Error(r.error || 'edit failed');
    cancelEdit();           // success -> leave edit mode and clear the composer
    scheduleRefreshActive();
  } catch (err) {
    // Repaint from server truth rather than reverting the bubble node by hand: a
    // background refresh may have already replaced it, so the saved reference
    // could be detached. The edit failed, so the server still has the old text.
    scheduleRefreshActive();
    toast('Failed to edit: ' + err.message, true); // stay in edit mode for a retry
  } finally {
    state.sending = false;
    updateSendEnabled();
  }
}

// ----- delete -----
async function confirmDelete(msg, forEveryone) {
  const ok = await confirmDialog({
    title: forEveryone ? 'Delete for everyone?' : 'Delete for me?',
    body: forEveryone
      ? 'This message will be deleted for everyone in the chat. This may fail if too much time has passed.'
      : 'This message will be deleted from this device only.',
    confirmLabel: 'Delete',
  });
  if (ok) doDelete(msg, forEveryone);
}

async function doDelete(msg, forEveryone) {
  const id = state.activeId;
  if (!id || !msg.id) return;
  // If we're editing the very message being deleted, drop out of edit mode.
  if (state.editing && state.editing.messageId === msg.id) cancelEdit();

  // Optimistic only for "delete for me" (always succeeds). "Delete for everyone"
  // can fail (time window / undelivered), so leave it until the server confirms.
  if (!forEveryone) { const row = rowByMid(msg.id); if (row) row.remove(); }

  try {
    const r = await api(`/api/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(msg.id)}/delete`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ forEveryone }),
    });
    if (!r.ok) throw new Error(r.error || 'delete failed');
    scheduleRefreshActive();
  } catch (err) {
    // Repaint from server truth rather than re-inserting the saved node: a
    // background refresh may have rebuilt the thread, so insertBefore could throw
    // on a stale sibling. The delete failed, so the message is still there.
    scheduleRefreshActive();
    toast(err.message === 'delete-for-everyone-failed'
      ? 'Could not delete for everyone (message too old or not delivered).'
      : 'Failed to delete: ' + err.message, true);
  }
}

// Small promise-based confirm modal (mirrors the lightbox/gif overlay pattern).
function confirmDialog({ title, body, confirmLabel }) {
  return new Promise((resolve) => {
    const finish = (val) => { close(); resolve(val); };
    const okBtn = el('button', { class: 'dlg-btn danger', text: confirmLabel || 'OK', onclick: () => finish(true) });
    const panel = el('div', { class: 'dlg-panel' }, [
      el('div', { class: 'dlg-title', text: title }),
      body ? el('div', { class: 'dlg-body', text: body }) : null,
      el('div', { class: 'dlg-actions' }, [
        el('button', { class: 'dlg-btn', text: 'Cancel', onclick: () => finish(false) }),
        okBtn,
      ]),
    ]);
    const overlay = el('div', { class: 'dlg-overlay' }, [panel]);
    const onKey = (e) => { if (e.key === 'Escape') finish(false); };
    function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    okBtn.focus();
  });
}

function renderMessages(data) {
  state.messages = data.messages || [];
  const inner = $('#messagesInner');
  const isGroup = data.conversation?.isGroup;
  const frag = document.createDocumentFragment();
  let lastDay = null;
  let prev = null;

  for (const msg of data.messages) {
    const day = new Date(msg.timestamp).toDateString();
    if (day !== lastDay) {
      frag.appendChild(el('div', { class: 'day-divider', text: fmtDayDivider(msg.timestamp) }));
      lastDay = day;
      prev = null;
    }
    const row = messageRow(msg, prev, isGroup);
    if (row) { frag.appendChild(row); prev = msg; }
  }
  inner.replaceChildren(frag);

  $('#loadOlder').classList.toggle('hidden', !data.hasOlder);
}

// Stops an in-flight "load older" scroll-anchor settle (see the #loadOlder
// handler). Held at module scope so a conversation switch can cancel it.
let cancelOlderPin = null;

let openToken = 0;
// Tell Signal the thread has been read so its unread badge clears. Fire-and-forget:
// the redux 'conversations' change event reconciles the list over SSE, but we also
// clear the count locally so the badge disappears instantly instead of ~300ms later.
// This marks read in Signal proper, which sends read receipts per the user's Signal
// settings (i.e. normal Signal Desktop behavior).
function markConversationRead(conv) {
  if (!conv || (!conv.unreadCount && !conv.markedUnread)) return;
  conv.unreadCount = 0;
  conv.markedUnread = false;
  renderConversations();
  api(`/api/conversations/${encodeURIComponent(conv.id)}/read`, { method: 'POST' })
    .catch(() => {}); // best-effort; the SSE conversations event resyncs if it failed
}

// Keep the *open* thread read as content arrives. Native Signal marks a focused,
// open conversation read automatically; without this, a message arriving in (or a
// reply you send to) the thread you're already looking at leaves a stale unread
// badge that only a re-click clears. Gated on tab visibility so we never send read
// receipts for messages you couldn't have seen (tab hidden/backgrounded).
function maybeMarkActiveRead() {
  if (!state.activeId || document.visibilityState !== 'visible') return;
  const conv = state.conversations.find((c) => c.id === state.activeId);
  if (conv && (conv.unreadCount > 0 || conv.markedUnread)) markConversationRead(conv);
}

async function openConversation(id) {
  if (state.activeId !== id) {
    clearPending(); // staged files belong to the conversation they were added in
    cancelEdit();   // an in-progress edit belongs to the conversation it started in
    closeThreadMenu(); // the options menu is per-chat; don't carry it across switches
    if (cancelOlderPin) cancelOlderPin(); // don't let a stale settle yank the new thread
    state.activeId = id;
    renderConversations(); // update active highlight
    renderActiveTldr(); // re-hydrate the auto-TLDR bubble for the chat we just opened
  }
  updateSendEnabled();
  $('#emptyState').classList.add('hidden');
  $('#conversationView').classList.remove('hidden');

  const conv = state.conversations.find((c) => c.id === id);
  if (conv) {
    renderThreadHeader(conv);
    state.lastActiveTimestamp = conv.timestamp;
    markConversationRead(conv); // opening a thread clears its unread badge
  }

  const token = ++openToken;
  pendingRefresh = false; // switching threads drops any refresh deferred for the old one
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(id)}/messages`);
    if (token !== openToken) return; // a newer open superseded this
    if (data.conversation) renderThreadHeader(data.conversation);
    renderMessages(data);
    scrollToBottom(true);
    $('#composerInput').focus();
  } catch (err) {
    toast(err.message, true);
  }
}

let refreshTimer = null;
let pendingRefresh = false;
function scheduleRefreshActive() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshActiveMessages, 150);
}
// True when the user has an active (non-collapsed) text selection inside the
// thread. A background refresh would replaceChildren() and wipe it mid-copy.
function selectionInMessages() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  const messages = $('#messages');
  return !!messages && messages.contains(sel.getRangeAt(0).commonAncestorContainer);
}
async function refreshActiveMessages() {
  if (!state.activeId) return;
  // Don't clobber a live selection — defer until it clears (see selectionchange
  // handler in init()), otherwise the rebuild deselects text the user is copying.
  if (selectionInMessages()) { pendingRefresh = true; return; }
  pendingRefresh = false;
  const id = state.activeId;
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(id)}/messages`);
    if (id !== state.activeId) return;
    renderMessages(data);
    if (state.nearBottom) scrollToBottom(true);
    const conv = state.conversations.find((c) => c.id === id);
    if (conv) state.lastActiveTimestamp = conv.timestamp;
  } catch {}
}

function scrollToBottom(force) {
  const m = $('#messages');
  // behavior:'instant' overrides .messages' scroll-behavior:smooth — assigning
  // scrollTop would otherwise animate (and visibly "catch up" as late content
  // reflows), so opening a thread jumps straight to the newest message instead.
  if (force || state.nearBottom) m.scrollTo({ top: m.scrollHeight, behavior: 'instant' });
}

// ---------- composer: pending attachments ----------
function kindForType(ct) {
  if (/^image\//.test(ct)) return 'image';
  if (/^video\//.test(ct)) return 'video';
  if (/^audio\//.test(ct)) return 'audio';
  return 'file';
}
function iconForKind(kind) {
  return kind === 'image' ? '🖼️' : kind === 'video' ? '🎬' : kind === 'audio' ? '🎵' : '📎';
}

// FileReader -> base64 (without the "data:<ct>;base64," prefix the server/Signal
// don't want).
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result);
      resolve(res.slice(res.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

// Natural dimensions for an image File (best-effort; 0/0 on failure).
function imageDims(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight, url });
    img.onerror = () => { URL.revokeObjectURL(url); resolve({ width: 0, height: 0, url: null }); };
    img.src = url;
  });
}

function revokePreview(item) {
  if (item && item.previewUrl) { URL.revokeObjectURL(item.previewUrl); item.previewUrl = null; }
}

async function addPendingFiles(fileList) {
  if (!state.activeId) return;
  const files = Array.from(fileList || []);
  if (!files.length) return;

  for (const file of files) {
    // Check the cap per file (not up front) so that skipped oversize files
    // don't burn a slot and everything that fits still gets a turn.
    if (state.pendingAttachments.length >= MAX_PENDING_FILES) {
      toast(`You can attach up to ${MAX_PENDING_FILES} files`, true);
      break;
    }
    if (file.size > MAX_PENDING_FILE_BYTES) {
      toast(`"${file.name}" is too large (max 25 MB)`, true);
      continue;
    }
    try {
      const base64 = await readFileAsBase64(file);
      const contentType = file.type || 'application/octet-stream';
      const kind = kindForType(contentType);
      const item = {
        id: ++attachSeq, fileName: file.name || 'attachment', contentType, base64,
        size: file.size, kind, width: 0, height: 0, previewUrl: null,
      };
      if (kind === 'image') {
        const d = await imageDims(file);
        item.width = d.width; item.height = d.height; item.previewUrl = d.url;
      }
      state.pendingAttachments.push(item);
      renderPending();
    } catch {
      toast(`Couldn't read "${file.name || 'file'}"`, true);
    }
  }
  updateSendEnabled();
}

function removePending(id) {
  const i = state.pendingAttachments.findIndex((a) => a.id === id);
  if (i < 0) return;
  revokePreview(state.pendingAttachments[i]);
  state.pendingAttachments.splice(i, 1);
  renderPending();
  updateSendEnabled();
}

function clearPending() {
  for (const item of state.pendingAttachments) revokePreview(item);
  state.pendingAttachments = [];
  renderPending();
  updateSendEnabled();
}

function renderPending() {
  const tray = $('#attachTray');
  if (!state.pendingAttachments.length) { tray.replaceChildren(); tray.classList.add('hidden'); return; }
  const frag = document.createDocumentFragment();
  for (const item of state.pendingAttachments) {
    const thumb = item.kind === 'image' && item.previewUrl
      ? el('img', { class: 'attach-prev-img', src: item.previewUrl, alt: item.fileName })
      : el('span', { class: 'attach-prev-icon', text: iconForKind(item.kind) });
    frag.appendChild(el('div', { class: 'attach-prev' }, [
      thumb,
      el('span', { class: 'attach-prev-name', text: item.fileName }),
      el('button', {
        class: 'attach-prev-remove', title: 'Remove', 'aria-label': 'Remove', text: '×',
        onclick: () => removePending(item.id),
      }),
    ]));
  }
  tray.replaceChildren(frag);
  tray.classList.remove('hidden');
}

function updateSendEnabled() {
  const hasText = $('#composerInput').value.trim().length > 0;
  $('#sendBtn').disabled = !state.activeId || (!hasText && !state.pendingAttachments.length);
}

// Optimistic preview of a staged attachment (local data, not yet on the server).
function pendingEchoEl(item) {
  if (item.kind === 'image') {
    const img = el('img', { class: 'att-media att-image', src: `data:${item.contentType};base64,${item.base64}`, alt: item.fileName });
    if (item.width && item.height) img.style.aspectRatio = `${item.width} / ${item.height}`;
    return wrapMedia(img);
  }
  return attachmentChip({ kind: item.kind, fileName: item.fileName }, null, null);
}

// ---------- composer: send ----------
async function sendMessage() {
  if (state.editing) return submitEdit(); // composer is in edit mode -> save the edit
  if (tryGifCommand()) return; // "/gif …" opens the picker instead of sending
  const input = $('#composerInput');
  // What Signal stores is plain text + formatting ranges, so the composer's
  // "_italic_ :shrug:" syntax is resolved here, once, and both halves are sent.
  // `raw` is kept to restore the box verbatim if the send fails.
  const raw = input.value.trim();
  const { text, bodyRanges } = parseFormatting(raw);
  const attachments = state.pendingAttachments.slice();
  if ((!text && !attachments.length) || !state.activeId || state.sending) return;
  const id = state.activeId;
  state.sending = true;
  input.value = '';
  autoGrow();
  // Clear the tray optimistically; restore it if the send fails (below).
  state.pendingAttachments = [];
  renderPending();
  updateSendEnabled();

  // optimistic echo (attachments rendered from local bytes; replaced by the
  // real, server-backed render on the refresh that follows a successful send)
  const inner = $('#messagesInner');
  const optimistic = messageRow(
    { direction: 'outgoing', text, bodyRanges, attachments: [], reactions: [], timestamp: Date.now(), status: 'sending', authorId: 'me' },
    null, false,
  );
  optimistic.classList.add('optimistic');
  const bubble = optimistic.querySelector('.bubble');
  if (bubble && attachments.length) {
    if (!text) bubble.textContent = ''; // drop the empty-bubble placeholder
    const ref = text ? bubble.firstChild : null;
    for (const item of attachments) bubble.insertBefore(pendingEchoEl(item), ref);
  }
  inner.appendChild(optimistic);
  scrollToBottom(true);

  try {
    const r = await api(`/api/conversations/${encodeURIComponent(id)}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        bodyRanges,
        attachments: attachments.map((a) => ({
          fileName: a.fileName, contentType: a.contentType, base64: a.base64, width: a.width, height: a.height,
        })),
      }),
    });
    if (!r.ok) throw new Error(r.error || 'send failed');
    for (const item of attachments) revokePreview(item); // sent — drop local previews
    scheduleRefreshActive();
    maybeMarkActiveRead(); // replying to an unread thread clears its badge now, not on the next resync
  } catch (err) {
    toast('Failed to send: ' + err.message, true);
    optimistic.querySelector('.tick')?.replaceWith(
      Object.assign(document.createElement('span'), { className: 'tick error', textContent: '⚠' }),
    );
    // Put the files back in the tray so the user doesn't lose them.
    if (attachments.length) {
      state.pendingAttachments = attachments.concat(state.pendingAttachments);
      renderPending();
    }
    if (raw) input.value = input.value || raw;
    updateSendEnabled();
  } finally {
    state.sending = false;
  }
}

function autoGrow() {
  const input = $('#composerInput');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}

// Swap ":shrug:" for 🤷 the moment you close the colon, like Signal's own
// composer — so what's in the box is what gets sent. (parseFormatting() expands
// any that slip through, e.g. pasted text, at send time.)
function expandShortcodeAtCaret(input) {
  const caret = input.selectionStart;
  if (caret !== input.selectionEnd) return; // mid-selection: leave it alone
  const hit = shortcodeBefore(input.value, caret);
  if (!hit) return;
  // setRangeText rather than rewriting .value: it edits in place, so Ctrl+Z can
  // still step back through what was typed.
  input.setRangeText(hit.emoji, hit.start, hit.end, 'end');
}

// ---------- GIF picker ----------
// "/gif [query]" in the composer opens the picker instead of sending. Invoked
// from the top of sendMessage(), so it covers both Enter and the Send button.
function tryGifCommand() {
  if (!state.activeId) return false;
  const input = $('#composerInput');
  const m = /^\s*\/gif\b[ \t]*(.*)$/i.exec(input.value);
  if (!m) return false;
  input.value = '';
  autoGrow();
  updateSendEnabled();
  openGifPicker(m[1].trim());
  return true;
}

// Modal GIF picker: search box + a masonry grid of animated previews served
// straight from Giphy's CDN. Picking one sends it (with any caption still in the
// composer) through /send-gif. Mirrors the openLightbox() overlay/Escape pattern.
function openGifPicker(initialQuery = '') {
  if (!state.activeId) return;

  const searchInput = el('input', {
    class: 'gif-search', type: 'text', placeholder: 'Search GIFs', value: initialQuery, autocomplete: 'off',
  });
  const grid = el('div', { class: 'gif-grid' });
  const status = el('div', { class: 'gif-status' });
  const panel = el('div', { class: 'gif-panel' }, [
    el('div', { class: 'gif-head' }, [
      searchInput,
      el('button', { class: 'gif-close', text: '×', title: 'Close', 'aria-label': 'Close', onclick: () => close() }),
    ]),
    status,
    grid,
    el('div', { class: 'gif-attribution', text: 'Powered by GIPHY' }),
  ]);
  const overlay = el('div', { class: 'gif-overlay' }, [panel]);

  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  searchInput.focus();

  function showStatus(node) {
    status.replaceChildren(typeof node === 'string' ? document.createTextNode(node) : node);
    status.classList.remove('hidden');
  }
  function noKeyMessage() {
    return el('div', {}, [
      el('div', { text: 'GIF search needs a free Giphy API key.' }),
      el('div', { class: 'gif-hint' }, [
        'Set ',
        el('code', { text: 'GIPHY_API_KEY' }),
        ' in the server environment (get one at ',
        el('a', { href: 'https://developers.giphy.com', target: '_blank', rel: 'noopener', text: 'developers.giphy.com' }),
        '), then restart the server.',
      ]),
    ]);
  }

  let token = 0;
  async function search(q) {
    const mine = ++token;
    grid.replaceChildren();
    showStatus('Loading…');
    try {
      const data = await api(`/api/gif/search?q=${encodeURIComponent(q)}`);
      if (mine !== token) return; // a newer search superseded this one
      if (data.error === 'no-key') { showStatus(noKeyMessage()); return; }
      if (!data.results || !data.results.length) { showStatus(q ? 'No GIFs found' : 'No trending GIFs right now'); return; }
      status.classList.add('hidden');
      renderResults(data.results);
    } catch {
      if (mine === token) showStatus("Couldn't reach GIPHY — check your connection.");
    }
  }

  function renderResults(results) {
    const frag = document.createDocumentFragment();
    for (const g of results) {
      const img = el('img', { class: 'gif-thumb', src: g.preview.url, alt: g.title || 'GIF', loading: 'lazy' });
      const cell = el('button', { class: 'gif-cell', title: g.title || 'GIF', onclick: () => { close(); sendGif(g); } }, [img]);
      if (g.preview.w && g.preview.h) cell.style.aspectRatio = `${g.preview.w} / ${g.preview.h}`;
      frag.appendChild(cell);
    }
    grid.replaceChildren(frag);
  }

  let debounce;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => search(searchInput.value.trim()), 300);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(debounce); search(searchInput.value.trim()); }
  });

  search(initialQuery.trim());
}

// Send a chosen GIF. The server fetches the bytes by id and routes them through
// the normal media-send path; here we echo it optimistically with the Giphy
// preview URL (animated, off the CDN) and reuse the same caption/refresh flow as
// sendMessage().
async function sendGif(g) {
  const id = state.activeId;
  if (!id || state.sending) return;
  const input = $('#composerInput');
  const { text, bodyRanges } = parseFormatting(input.value.trim()); // the caption formats like any other message
  state.sending = true;
  input.value = '';
  autoGrow();
  updateSendEnabled();

  const inner = $('#messagesInner');
  const optimistic = messageRow(
    { direction: 'outgoing', text, bodyRanges, attachments: [], reactions: [], timestamp: Date.now(), status: 'sending', authorId: 'me' },
    null, false,
  );
  optimistic.classList.add('optimistic');
  const bubble = optimistic.querySelector('.bubble');
  if (bubble) {
    if (!text) bubble.textContent = '';
    const ref = text ? bubble.firstChild : null;
    const img = el('img', { class: 'att-media att-image', src: g.preview.url, alt: g.title || 'GIF' });
    if (g.preview.w && g.preview.h) img.style.aspectRatio = `${g.preview.w} / ${g.preview.h}`;
    bubble.insertBefore(wrapMedia(img), ref);
  }
  inner.appendChild(optimistic);
  scrollToBottom(true);

  try {
    const r = await api(`/api/conversations/${encodeURIComponent(id)}/send-gif`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: g.id, text, bodyRanges }),
    });
    if (!r.ok) throw new Error(r.error || 'send failed');
    scheduleRefreshActive();
    maybeMarkActiveRead();
  } catch (err) {
    toast('Failed to send GIF: ' + err.message, true);
    optimistic.querySelector('.tick')?.replaceWith(
      Object.assign(document.createElement('span'), { className: 'tick error', textContent: '⚠' }),
    );
    if (text) input.value = input.value || text; // give the caption back
    updateSendEnabled();
  } finally {
    state.sending = false;
  }
}

// ---------- thread options menu (per-chat) ----------
// A small dropdown in the thread header. For now it holds the Auto-TLDR toggle:
// when on, YouTube links you post in this chat get an auto-summary, generated
// server-side (see src/tldr.js). State is fetched lazily when the menu opens.
let threadMenuOpen = false;

function closeThreadMenu() {
  if (!threadMenuOpen) return;
  $('#threadMenu').classList.add('hidden');
  $('#threadMenuBtn').setAttribute('aria-expanded', 'false');
  threadMenuOpen = false;
}

async function openThreadMenu() {
  if (!state.activeId) return;
  const pop = $('#threadMenu');
  pop.replaceChildren(el('div', { class: 'menu-note', text: 'Loading…' }));
  pop.classList.remove('hidden');
  $('#threadMenuBtn').setAttribute('aria-expanded', 'true');
  threadMenuOpen = true;
  const id = state.activeId;
  let data;
  try { data = await api(`/api/conversations/${encodeURIComponent(id)}/tldr`); }
  catch { data = { enabled: false, configured: false }; }
  if (state.activeId !== id || !threadMenuOpen) return; // switched/closed while loading
  buildThreadMenu(id, data);
}

function buildThreadMenu(id, data) {
  const toggle = el('button', {
    class: 'menu-item' + (data.enabled ? ' on' : ''),
    role: 'menuitemcheckbox',
    'aria-checked': data.enabled ? 'true' : 'false',
    onclick: () => setTldr(id, !data.enabled),
  }, [
    el('span', { class: 'menu-check', text: data.enabled ? '✓' : '' }),
    el('span', { class: 'menu-label', text: 'Auto-TLDR YouTube links' }),
  ]);
  const children = [toggle];
  if (!data.configured) {
    children.push(el('div', { class: 'menu-hint' }, [
      'Needs ', el('code', { text: 'GEMINI_API_KEY' }), ' in the server .env.',
    ]));
  } else {
    children.push(el('div', { class: 'menu-note', text: 'YouTube links you post here get a short auto-summary.' }));
  }
  $('#threadMenu').replaceChildren(...children);
}

async function setTldr(id, next) {
  try {
    const r = await api(`/api/conversations/${encodeURIComponent(id)}/tldr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    });
    if (state.activeId === id && threadMenuOpen) buildThreadMenu(id, r);
    toast(r.enabled ? 'Auto-TLDR on for this chat' : 'Auto-TLDR off for this chat');
  } catch (err) {
    toast('Could not update: ' + err.message, true);
  }
}

// ---------- auto-TLDR status bubble (local-only, per-chat) ----------
// A transient bubble pinned below the thread that mirrors what the server-side
// auto-TLDR pipeline is doing for a YouTube link you posted (see src/tldr.js).
// It is NEVER a real Signal message — purely local feedback. Driven by 'tldr'
// SSE stage events; the bubble shows the open thread's status, but state is kept
// per conversation (below) so it survives switching. On failure it stays put
// with a Retry button (which re-runs even after the server's automatic retries
// are spent) and a
// dismiss "×". Lives in #tldrStatus, outside #messagesInner, so the message
// refreshes that replaceChildren() the thread never wipe it.
//
// Status is kept PER CONVERSATION and in-memory, so switching chats doesn't lose
// it: a summary still running (or a failure left) in another thread is restored
// when you come back, and a chat you open mid-pipeline is re-hydrated. Ephemeral
// by design -- a page reload or server restart clears it (we don't persist a
// log). With several links in flight in one chat it tracks the most recent stage
// event. A sidebar/cross-conversation indicator is out of scope.
const tldrByConv = new Map(); // conversationId -> { stage, reason, url }

// Store a conversation's status, bounding the Map. Entries normally clear on
// 'done'/dismiss, but a 'failed' left in a background chat lingers until it's
// reopened and dismissed, so cap defensively: FIFO-evict the oldest entry that
// isn't the chat currently on screen.
const TLDR_CONV_CAP = 50;
function setTldrFor(convId, status) {
  const key = String(convId);
  tldrByConv.set(key, status);
  if (tldrByConv.size > TLDR_CONV_CAP) {
    for (const oldest of tldrByConv.keys()) {
      if (oldest === state.activeId) continue;
      tldrByConv.delete(oldest);
      break;
    }
  }
}

// Drop a conversation's stored status (on 'done', or when the user dismisses a
// failed bubble) and repaint if that chat is the one on screen.
function clearTldrFor(convId) {
  if (convId == null) return;
  const key = String(convId);
  tldrByConv.delete(key);
  if (key === state.activeId) renderActiveTldr();
}

// Render/replace the bubble for a pipeline stage. `url` is the link in flight; it
// rides into the Retry handler so a manual retry knows what to re-run.
function renderTldrStatus(stage, reason, url) {
  const host = $('#tldrStatus');
  if (!host) return;
  const failed = stage === 'failed';
  const label =
    stage === 'fetching' ? 'Fetching transcript…'
    : stage === 'summarizing' ? 'Summarizing…'
    : stage === 'retrying' ? `Retrying${reason ? ` (${reason})` : ''}…`
    : failed ? `Auto-TLDR failed${reason ? `: ${reason}` : ''}`
    : 'Working…';

  const children = [
    failed ? el('span', { class: 'tldr-icon', text: '⚠' }) : el('span', { class: 'tldr-spinner' }),
    el('span', { class: 'tldr-text', text: label }),
  ];
  if (failed) {
    children.push(el('button', { class: 'tldr-retry', text: 'Retry', onclick: () => retryTldr(url) }));
    children.push(el('button', {
      class: 'tldr-dismiss', text: '×', title: 'Dismiss', 'aria-label': 'Dismiss', onclick: () => clearTldrFor(state.activeId),
    }));
  }
  host.replaceChildren(el('div', { class: 'tldr-bubble' + (failed ? ' failed' : '') }, children));
  host.classList.remove('hidden');
  scrollToBottom(); // follow it into view only if already near the bottom
}

// Handle a 'tldr' SSE stage event for ANY conversation: store the status per chat
// (so it survives switching) and paint the bubble only when it's the open thread.
function handleTldrStage(e) {
  if (!e || !e.conversationId) return;
  const convId = String(e.conversationId);
  if (e.state === 'done') {
    // Drop the status only if this completion matches the tracked link, so a
    // finishing link can't wipe a different one that's still in progress.
    const cur = tldrByConv.get(convId);
    if (cur && cur.url !== e.url) return;
    clearTldrFor(convId);
    return;
  }
  setTldrFor(convId, { stage: e.state, reason: e.reason, url: e.url });
  if (convId === state.activeId) renderActiveTldr();
}

// Paint the open conversation's stored status into #tldrStatus, or clear the host
// when there's nothing for it. Called on every update and on conversation switch,
// so the bubble follows you between chats.
function renderActiveTldr() {
  const st = state.activeId ? tldrByConv.get(state.activeId) : null;
  if (!st) {
    const host = $('#tldrStatus');
    if (host) { host.replaceChildren(); host.classList.add('hidden'); }
    return;
  }
  renderTldrStatus(st.stage, st.reason, st.url);
}

// Friendly text for the error tokens the retry endpoint can return, so the bubble
// never shows a raw enum like "not-configured".
function retryErrorReason(msg) {
  if (msg === 'not-configured') return 'auto-TLDR is not configured';
  if (msg === 'bad-url') return 'not a recognized YouTube link';
  return msg || 'retry failed';
}

// Manual retry: ask the server to re-run this link's summary. Optimistically store
// the first real stage ('fetching', what the server emits first) so the label
// doesn't visibly run backwards; the rest stream back over SSE.
async function retryTldr(url) {
  const id = state.activeId;
  if (!id || !url) return;
  const key = String(id);
  setTldrFor(key, { stage: 'fetching', reason: null, url });
  renderActiveTldr();
  try {
    const r = await api(`/api/conversations/${encodeURIComponent(id)}/tldr/retry`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }),
    });
    if (!r.ok) throw new Error(r.error || 'retry failed');
  } catch (err) {
    // Only show the failure if we're still tracking this same link for that chat.
    const cur = tldrByConv.get(key);
    if (cur && cur.url === url) {
      setTldrFor(key, { stage: 'failed', reason: retryErrorReason(err.message), url });
      renderActiveTldr();
    }
  }
}

// ---------- status + toast ----------
function setStatus(status) {
  const dot = $('#statusDot');
  dot.className = 'status-dot ' + status;
  $('#status').title =
    status === 'ready' ? 'Connected to Signal'
    : status === 'connecting' ? 'Connecting to Signal…'
    : 'Disconnected — is Signal Desktop running?';
  if (status !== 'ready') {
    $('#emptySub').textContent =
      status === 'connecting' ? 'Connecting to Signal Desktop…'
      : 'Cannot reach Signal Desktop. Launch it with remote debugging enabled.';
  } else {
    $('#emptySub').textContent = '';
  }
}

let toastTimer = null;
function toast(message, isError) {
  let t = $('.toast');
  if (!t) { t = el('div', { class: 'toast' }); document.body.appendChild(t); }
  t.textContent = message;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 3500);
}

// ---------- realtime (SSE) ----------
function connectSSE() {
  const es = new EventSource('/api/events');
  let convTimer = null;
  let lastStatus = null;

  es.addEventListener('status', (ev) => {
    let s; try { s = JSON.parse(ev.data).status; } catch { return; }
    setStatus(s);
    // When the bridge (re)becomes ready — initial boot, or the server/Signal
    // came back after the tab was already open — reload so the tab self-heals.
    if (s === 'ready' && lastStatus !== 'ready') {
      loadConversations();
      if (state.activeId) scheduleRefreshActive();
    }
    lastStatus = s;
  });
  es.addEventListener('signal', (ev) => {
    let e; try { e = JSON.parse(ev.data); } catch { return; }
    if (e.type === 'conversations') {
      clearTimeout(convTimer);
      convTimer = setTimeout(loadConversations, 300);
    } else if (e.type === 'messages' && e.conversationId === state.activeId) {
      scheduleRefreshActive();
    } else if (e.type === 'tldr') {
      handleTldrStage(e);
    }
  });
  es.onerror = () => setStatus('connecting');
  es.onopen = () => { /* status arrives via 'status' event */ };
}

// ---------- init ----------
function init() {
  setStatus('connecting');

  $('#search').addEventListener('input', () => { applySearch(); renderConversations(); });

  const input = $('#composerInput');
  input.addEventListener('input', (e) => {
    if (!e.isComposing) expandShortcodeAtCaret(input); // never rewrite mid-IME-composition
    autoGrow();
    updateSendEnabled();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); return; }
    if (e.key === 'Escape' && state.editing) { e.preventDefault(); cancelEdit(); return; }
    // ↑ on an empty composer pulls your last editable message in for a quick edit.
    if (e.key === 'ArrowUp' && !state.editing && input.value === '') {
      const last = lastEditableOutgoing();
      if (last) { e.preventDefault(); startEdit(last); }
    }
  });
  $('#sendBtn').addEventListener('click', sendMessage);
  $('#editCancel').addEventListener('click', cancelEdit);
  updateSendEnabled();

  // gif: opens the picker (same as typing "/gif")
  $('#gifBtn').addEventListener('click', () => { if (state.activeId) openGifPicker(''); });

  // thread options menu (per-chat): toggle on the button, dismiss on outside-click/Escape
  $('#threadMenuBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (threadMenuOpen) closeThreadMenu(); else openThreadMenu();
  });
  document.addEventListener('click', (e) => {
    if (threadMenuOpen && !e.target.closest('.thread-menu')) closeThreadMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeThreadMenu(); });

  // attach: file-picker button + hidden input
  const fileInput = $('#fileInput');
  $('#attachBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    addPendingFiles(fileInput.files);
    fileInput.value = ''; // allow re-picking the same file
  });

  // paste files/images straight into the composer
  input.addEventListener('paste', (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) { e.preventDefault(); addPendingFiles(files); }
  });

  // drag-and-drop onto the conversation pane
  const view = $('#conversationView');
  const overlay = $('#dropOverlay');
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  let dragDepth = 0;
  view.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || !state.activeId) return;
    e.preventDefault(); dragDepth++; overlay.classList.remove('hidden');
  });
  view.addEventListener('dragover', (e) => {
    if (!hasFiles(e) || !state.activeId) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
  });
  view.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth--; if (dragDepth <= 0) { dragDepth = 0; overlay.classList.add('hidden'); }
  });
  view.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; overlay.classList.add('hidden');
    addPendingFiles(e.dataTransfer.files);
  });

  $('#messages').addEventListener('scroll', () => {
    const m = $('#messages');
    state.nearBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 120;
  });

  // Double-click a bubble to select all its text (easy copy). Skip bubbles with
  // no real text (media-only, placeholders, the blank-bubble filler) so the
  // browser's native double-click behavior is left intact there.
  $('#messages').addEventListener('dblclick', (e) => {
    const bubble = e.target.closest('.bubble');
    if (!bubble) return;
    const hasText = [...bubble.childNodes].some(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim(),
    );
    if (!hasText) return;
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(bubble);
    sel.removeAllRanges();
    sel.addRange(range);
  });

  // Once a deferred-protected selection clears, run the refresh we held back.
  document.addEventListener('selectionchange', () => {
    if (pendingRefresh && !selectionInMessages()) refreshActiveMessages();
  });

  // Coming back to the tab with the open thread still showing an unread badge
  // (a message arrived while it was hidden) marks it read now that you can see it.
  document.addEventListener('visibilitychange', maybeMarkActiveRead);

  $('#loadOlder').addEventListener('click', async () => {
    if (!state.activeId) return;
    try {
      const m = $('#messages');
      const inner = $('#messagesInner');
      // Anchor on the topmost rendered message: remember which one and exactly
      // where it sits in the viewport. renderMessages() rebuilds every row, so we
      // re-find it afterwards by its stable id (data-mid) and nudge the scroll so
      // it lands back in the same spot. Pinning the element itself (rather than a
      // height delta) survives reflow ABOVE *or* below it — late-loading media,
      // author-label regrouping, the lot.
      let anchorId = null, anchorTop = 0;
      for (const row of inner.children) {
        if (row.dataset && row.dataset.mid) { anchorId = row.dataset.mid; anchorTop = row.getBoundingClientRect().top; break; }
      }
      const data = await api(`/api/conversations/${encodeURIComponent(state.activeId)}/messages?older=1`);
      renderMessages(data);
      if (cancelOlderPin) cancelOlderPin(); // supersede any prior in-flight settle
      // Re-pin instantly (.messages is scroll-behavior:smooth, so scrollBy would
      // otherwise animate). Keep correcting until sizes go quiet (media settled),
      // the user starts scrolling, or a safety cap elapses.
      const pin = () => {
        if (!anchorId) return;
        let el = null;
        for (const row of inner.children) { if (row.dataset && row.dataset.mid === anchorId) { el = row; break; } }
        if (!el) return;
        const delta = el.getBoundingClientRect().top - anchorTop;
        if (delta) m.scrollBy({ top: delta, behavior: 'instant' });
      };
      let idle, cap, ro;
      const stop = () => {
        if (ro) ro.disconnect();
        clearTimeout(idle); clearTimeout(cap);
        m.removeEventListener('wheel', stop);
        m.removeEventListener('touchstart', stop);
        cancelOlderPin = null;
      };
      cancelOlderPin = stop;
      ro = new ResizeObserver(() => { pin(); clearTimeout(idle); idle = setTimeout(stop, 600); });
      pin();
      ro.observe(inner);
      cap = setTimeout(stop, 8000);
      m.addEventListener('wheel', stop, { passive: true });
      m.addEventListener('touchstart', stop, { passive: true });
    } catch (err) { toast(err.message, true); }
  });

  connectSSE();
  loadConversations();

  // initial status probe
  api('/api/status').then((s) => {
    setStatus(s.status);
    state.me = s.me;
  }).catch(() => setStatus('disconnected'));
}

init();
