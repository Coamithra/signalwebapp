// Signal web app — frontend. Talks to the local bridge server over REST,
// receives realtime nudges via SSE, and renders a Signal-like chat UI.

import {
  parseFormatting, toMarkdown, renderFormatted,
  shortcodeBefore, shortcodeQueryBefore, matchShortcodes, emojiForShortcode,
} from './format.js';
import {
  colorFor, initials, previewText, menuActionsFor, kindForType, iconForKind,
  parseEmojiFreq, nextEmojiFreq, parseGifCommand, evictOldestTldr, retryErrorReason,
  tldrBubble, tldrHint, jumboSizeFor, hasLink, safeHttpUrl, previewDomain,
} from './ui-logic.js';

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
  hasOlder: false,        // the open thread has unloaded history above (drives #loadOlder + auto-load)
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

// ---------- link preview cards ----------

// The "postcard" under a message that links somewhere: domain, title,
// description, hero image. Everything here (including the href) came off the
// wire, so it's built with createElement and the url is scheme-checked — a
// preview whose url isn't http(s) still renders, just not as a link.
// Returns null when the message has no preview worth drawing.
function linkPreviewEl(msg) {
  const p = (msg.preview || [])[0];
  if (!p || !p.url) return null;
  // A card with no title and no image is just the URL again — skip it.
  if (!p.title && !p.image) return null;

  const href = safeHttpUrl(p.url);
  const card = el(href ? 'a' : 'div', { class: 'link-preview' });
  if (href) {
    card.setAttribute('href', href);
    card.setAttribute('target', '_blank');
    card.setAttribute('rel', 'noopener noreferrer');
  }
  // The card sits inside the bubble; without this a click would also hit
  // whatever bubble-level handlers exist now or later.
  card.addEventListener('click', (e) => e.stopPropagation());

  const body = el('div', { class: 'lp-body' });
  const domain = previewDomain(p.url);
  if (domain) body.appendChild(el('div', { class: 'lp-domain', text: domain }));
  if (p.title) body.appendChild(el('div', { class: 'lp-title', text: p.title }));
  if (p.description) body.appendChild(el('div', { class: 'lp-desc', text: p.description }));
  card.appendChild(body);

  if (p.image) {
    const img = el('img', {
      class: 'lp-image',
      src: `/api/previews/${encodeURIComponent(msg.id)}/0`,
      loading: 'lazy',
      alt: '',
    });
    // Reserve the box from the stored dimensions so the thread doesn't reflow
    // when the bytes arrive — same reasoning as mediaBox() for attachments.
    if (p.image.width && p.image.height) {
      img.style.aspectRatio = `${p.image.width} / ${p.image.height}`;
    }
    // A preview image is decoration: if it won't load, drop it and keep the card.
    img.addEventListener('error', () => img.remove());
    card.appendChild(img);
  }
  return card;
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
    // Link preview "postcard" below the text. Signal only ever shows the first.
    const card = linkPreviewEl(msg);
    if (card) bubble.appendChild(card);
  }
  if (!bubble.childNodes.length) bubble.appendChild(document.createTextNode(' '));
  applyJumbo(bubble, msg);
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
// local delete. "Summarize in chat" appears on any message the server tagged with
// a YouTube link, whoever sent it. The eligibility rules live in ui-logic.js
// (testable); this only binds the action names to labels and handlers.
const MENU_ACTIONS = {
  summarize: (msg) => ({ label: 'Summarize in chat', onClick: () => startTldr(msg.youtube.url, 'summarize') }),
  // Inert on purpose: see menuActionsFor. Carries no onClick, so openMessageMenu
  // renders it as a disabled button.
  summarized: () => ({ label: 'Already summarized', disabled: true }),
  edit: (msg) => ({ label: 'Edit', onClick: () => startEdit(msg) }),
  deleteForEveryone: (msg) => ({ label: 'Delete for everyone', danger: true, onClick: () => confirmDelete(msg, true) }),
  deleteForMe: (msg) => ({ label: 'Delete for me', danger: true, onClick: () => confirmDelete(msg, false) }),
};
function menuItemsFor(msg) {
  // An unknown name is skipped rather than thrown on: a menu missing one entry
  // beats a TypeError inside the message list. A test keeps the two in step.
  return menuActionsFor(msg).map((action) => MENU_ACTIONS[action]).filter(Boolean).map((build) => build(msg));
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

// Emoji-only text renders big and bubble-less (Signal's "jumbomoji"). Both the
// size and the veto come from ui-logic; here we only paint it. Toggles rather
// than sets, because an in-place edit reuses the same bubble node and can turn
// a 👍 back into ordinary text.
function applyJumbo(bubble, msg) {
  const px = jumboSizeFor(msg);
  bubble.classList.toggle('jumbomoji', !!px);
  bubble.style.fontSize = px ? `${px}px` : '';
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
      // A disabled entry is there to explain why the action isn't offered, so it
      // gets neither the attribute's click-swallowing nor a handler to swallow.
      ...(it.disabled
        ? { disabled: '' }
        : { onclick: () => { closeMessageMenu(); it.onClick(); } }),
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
  // The message's non-text parts ride along so the optimistic repaint in
  // submitEdit can re-decide jumbomoji without re-finding the message. Signal's
  // edit is text-only, so these are exactly as true after the edit as before.
  state.editing = {
    messageId: msg.id, original: source,
    attachments: msg.attachments || [], isViewOnce: !!msg.isViewOnce,
  };
  const input = $('#composerInput');
  closeEmojiPop(); // the box is being replaced wholesale; any suggestions are stale
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
  closeEmojiPop();
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
  if (textEl) {
    textEl.replaceChildren(renderFormatted(text, bodyRanges));
    // The edit may have crossed the emoji-only line in either direction.
    applyJumbo(textEl.closest('.bubble'), { ...editing, text, bodyRanges });
  }

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

  state.hasOlder = !!data.hasOlder;
  $('#loadOlder').classList.toggle('hidden', !state.hasOlder);
}

// Stops an in-flight "load older" scroll-anchor settle (see loadOlderMessages()).
// Held at module scope so a conversation switch can cancel it.
let cancelOlderPin = null;

// Feel parameters for the scroll-to-load-older gesture — tweak freely, they're
// pure UX tuning and nothing else depends on their values.
const OLDER_ARM_PX = 80;       // how close to the top before the gesture arms
const OLDER_INTENT_PX = 110;   // extra upward scrolling needed once armed
const OLDER_DWELL_MS = 250;    // ...and it must take at least this long (kills one flick)
const OLDER_COOLDOWN_MS = 600; // quiet period after a load, so loads can't chain
const OLDER_WHEEL_LINE_PX = 16; // assumed line height for line-mode wheel events

let loadingOlder = false;
let olderBlockedUntil = 0;
let olderArmedAt = 0;   // 0 = disarmed
let olderIntent = 0;    // upward scroll accumulated since arming, in px
let lastScrollTop = 0;

// Fetch one more page of history and put the viewport back where it was. Shared
// by the #loadOlder button and the scroll gesture, so both anchor identically.
async function loadOlderMessages() {
  if (!state.activeId || loadingOlder) return;
  loadingOlder = true;
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
    const id = state.activeId;
    const data = await api(`/api/conversations/${encodeURIComponent(id)}/messages?older=1`);
    if (id !== state.activeId) return; // switched threads mid-load; those rows aren't ours
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
      // Keep the gesture's baseline in step: a pin correction fires a real scroll
      // event, which would otherwise read as the user scrolling up.
      lastScrollTop = m.scrollTop;
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
    lastScrollTop = m.scrollTop; // in case the anchor was gone and pin() never ran
  } catch (err) { toast(err.message, true); }
  finally {
    loadingOlder = false;
    olderBlockedUntil = Date.now() + OLDER_COOLDOWN_MS;
    resetOlderGesture();
  }
}

function resetOlderGesture() {
  olderArmedAt = 0;
  olderIntent = 0;
}

// Start measuring upward intent. Called both when scrolling into the top zone and
// from the wheel/touch path — the latter matters because a thread already parked at
// scrollTop 0 emits no scroll events, so without it the gesture could never arm
// again after a load's cooldown swallowed the last one.
function armOlderGesture() {
  if (olderArmedAt || !state.hasOlder || loadingOlder || Date.now() < olderBlockedUntil) return;
  olderArmedAt = Date.now();
  olderIntent = 0;
}

// Accumulate "keep scrolling up" intent and fire once it clears both the distance
// and the dwell-time gate. Upward intent arrives as scrollTop decreases while in
// the arming zone, and — once pinned at the very top, where no scroll events fire
// any more — as raw wheel/touch deltas.
function noteOlderIntent(px) {
  if (px <= 0 || !state.hasOlder || loadingOlder || !olderArmedAt) return;
  olderIntent += px;
  if (olderIntent >= OLDER_INTENT_PX && Date.now() - olderArmedAt >= OLDER_DWELL_MS) {
    resetOlderGesture();
    loadOlderMessages();
  }
}

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
    resetOlderGesture(); // upward intent belongs to the thread it was built in
    olderBlockedUntil = 0; // ...and so does another thread's cooldown
    lastScrollTop = 0;
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

// ---------- composer: link preview warming ----------
// Sending resolves the preview server-side, but a cold fetch takes a second or
// two. Nudging Signal to start it while the user is still typing means the send
// almost always finds one already waiting and adds no latency of its own.
// Best-effort throughout: a failure here costs nothing but the card.
const WARM_DEBOUNCE_MS = 400;
let warmTimer = null;
let lastWarmed = '';

function warmLinkPreview(text) {
  if (warmTimer) { clearTimeout(warmTimer); warmTimer = null; }
  // An edit never attaches a preview (submitEdit sends text only), so warming
  // during one would stomp Signal's global slot for nothing.
  if (state.editing) return;
  if (!hasLink(text)) return;
  if (text === lastWarmed) return; // same text (a caret move, an emoji expansion) -> already asked
  warmTimer = setTimeout(() => {
    lastWarmed = text;
    fetch('/api/link-preview/warm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch(() => {});
  }, WARM_DEBOUNCE_MS);
}

// ---------- composer: send ----------
async function sendMessage() {
  closeEmojiPop();
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
  // Drop any warm still pending: it holds the pre-send text, and firing it after
  // the message has gone would re-grab into Signal's global slot for nothing.
  if (warmTimer) { clearTimeout(warmTimer); warmTimer = null; }
  lastWarmed = ''; // so re-sending the same link warms again rather than being deduped
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
    applyJumbo(bubble, { text, bodyRanges, attachments }); // messageRow was handed none
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
  replaceRange(input, hit.start, hit.end, hit.emoji);
}

// Swap [start, end) for `text` in a way the browser's own undo stack records, so
// Ctrl+Z steps back over an expansion instead of skipping past it. execCommand is
// deprecated but it is still the only API that writes to that stack: setRangeText
// edits the value without it, so before this Ctrl+Z jumped straight over an
// expansion to whatever was typed before (verified in Chrome 150). Falls back to
// setRangeText if it's ever removed.
// Note it fires a SYNCHRONOUS input event, so the composer's input handler
// re-enters once per call. That's fine — the second pass finds no shortcode left
// to expand and no open run to complete — but keep it in mind before adding
// anything heavier to that handler.
function replaceRange(input, start, end, text) {
  input.setSelectionRange(start, end);
  if (!document.execCommand('insertText', false, text)) {
    input.setRangeText(text, start, end, 'end');
  }
}

// ---------- composer: emoji shortcode autocomplete ----------
// The other half of the shortcode story: expandShortcodeAtCaret() above handles
// ":shrug:" once you close it, this suggests names while ":shr" is still open —
// which is what you need when you can't guess Signal's name for the thing
// (":+1:" for 👍). Keyboard-first; the popup only exists while it has matches.

// The counting/decay/cap rules live in ui-logic.js (and are unit-tested); what
// stays here is the localStorage wiring, which is best-effort — storage can be
// full or disabled, so the read and the write both tolerate throwing.
const EMOJI_POP_LIMIT = 8;        // rows shown; a hard cap, not a page size
const EMOJI_FREQ_KEY = 'sb.emojiFreq';

// Parsed once and kept: the popup needs this on every keystroke, and only a
// pick can change it. Another tab writing the key is not worth a storage
// listener — the two would just re-learn each other's favourites.
let emojiFreqCache = null;
function emojiFreq() {
  if (!emojiFreqCache) emojiFreqCache = readEmojiFreq();
  return emojiFreqCache;
}

// One write shape for both callers: exactly what parseEmojiFreq reads back.
function saveEmojiFreq({ counts, picks }) {
  try { localStorage.setItem(EMOJI_FREQ_KEY, JSON.stringify({ counts, picks })); } catch { /* full or disabled */ }
}

// -> { counts: {emoji: score}, picks: number-since-last-decay }
function readEmojiFreq() {
  let freq;
  try {
    freq = parseEmojiFreq(localStorage.getItem(EMOJI_FREQ_KEY), emojiForShortcode);
  } catch { return { counts: Object.create(null), picks: 0 }; }
  // Counts written before the switch to emoji keys were converted on the way
  // in; persist that once so the conversion doesn't re-run on every load.
  if (freq.migrated) saveEmojiFreq(freq);
  return freq;
}

function bumpEmojiFreq(emoji) {
  const freq = emojiFreq();
  const snap = nextEmojiFreq(freq, emoji);
  // nextEmojiFreq mutates freq.counts but deliberately not freq.picks — the
  // caller owns that. Without this the cached pick counter never advances, so
  // the decay would only ever fire on the first pick after a page load.
  freq.picks = snap.picks;
  saveEmojiFreq(snap);
}

let emojiPop = null;      // { node, list, items, index, start } while open
let emojiPopDismissed = null; // start offset of the ":run" Escape rejected, until it's broken

function closeEmojiPop() {
  if (!emojiPop) return;
  emojiPop.node.remove();
  emojiPop = null;
  const input = $('#composerInput');
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
}

// Escape means "I meant this text literally", so unlike closeEmojiPop() it has
// to stick: without this the next keystroke re-matches the same run and pops
// the list straight back up.
function dismissEmojiPop() {
  if (emojiPop) emojiPopDismissed = emojiPop.start;
  closeEmojiPop();
}

// Recompute from the caret. Called on input and on anything that can move the
// caret without changing the text (clicks, arrow keys), so the popup never
// lingers over a spot it no longer describes.
function updateEmojiPop() {
  const input = $('#composerInput');
  if (input.selectionStart !== input.selectionEnd) return closeEmojiPop();
  const q = shortcodeQueryBefore(input.value, input.selectionStart);
  if (!q) { emojiPopDismissed = null; return closeEmojiPop(); } // run broken -> Escape forgotten
  // Still the run Escape rejected (typing more of the same word keeps it
  // dismissed); a different run is a fresh ask.
  if (emojiPopDismissed === q.start) return closeEmojiPop();
  emojiPopDismissed = null;
  const items = matchShortcodes(q.query, EMOJI_POP_LIMIT, emojiFreq().counts);
  if (!items.length) return closeEmojiPop();
  renderEmojiPop(items, q.start);
}

function renderEmojiPop(items, start) {
  if (!emojiPop) {
    const list = el('div', { class: 'emoji-pop-list', role: 'listbox', 'aria-label': 'Emoji suggestions' });
    const node = el('div', { class: 'emoji-pop' }, [
      list,
      el('div', { class: 'emoji-pop-hint', text: '↑↓ to choose · Enter or Tab to insert · Esc to dismiss' }),
    ]);
    $('.composer').appendChild(node);
    emojiPop = { node, list, items: [], index: 0, start };
    const input = $('#composerInput');
    // The textarea stays the focused element, so it's what a screen reader is
    // reading — the listbox has to be announced through it.
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'emojiPopList');
    list.id = 'emojiPopList';
  }
  // Keep the highlight on the same emoji across a keystroke where it survived,
  // so typing another character doesn't yank the selection back to the top.
  // Tracked by emoji, not name: rows dedupe by emoji, so the name a given glyph
  // is listed under can change as the query narrows (🌤️ is `sun_small_cloud`
  // for ":sun" and `mostly_sunny` for ":sunn") — matching on the name would drop
  // the highlight of a row that never actually left.
  const previous = emojiPop.items[emojiPop.index];
  emojiPop.items = items;
  emojiPop.start = start;
  const kept = previous ? items.findIndex((i) => i.emoji === previous.emoji) : -1;
  emojiPop.index = kept >= 0 ? kept : 0;

  const frag = document.createDocumentFragment();
  items.forEach((item, i) => {
    frag.appendChild(el('button', {
      class: 'emoji-pop-item', type: 'button', role: 'option', id: `emojiPopItem${i}`,
      // The composer must keep focus and the caret: a blur here would collapse
      // the selection state the insert depends on.
      onmousedown: (e) => e.preventDefault(),
      onclick: () => pickEmoji(i),
      onmousemove: () => setEmojiPopIndex(i),
    }, [
      el('span', { class: 'emoji-pop-emoji', text: item.emoji }),
      el('span', { class: 'emoji-pop-name', text: `:${item.name}:` }),
      // A synonym hit: you typed "chef" and the row says :cook:, so show the
      // word that put it there — otherwise the list looks like it guessed.
      ...(item.tag ? [el('span', { class: 'emoji-pop-tag', text: item.tag })] : []),
    ]));
  });
  emojiPop.list.replaceChildren(frag);
  paintEmojiPopSelection();
}

function paintEmojiPopSelection() {
  const rows = emojiPop.list.children;
  for (let i = 0; i < rows.length; i++) {
    const on = i === emojiPop.index;
    rows[i].classList.toggle('selected', on);
    rows[i].setAttribute('aria-selected', String(on));
  }
  const active = rows[emojiPop.index];
  if (!active) return;
  active.scrollIntoView({ block: 'nearest' });
  $('#composerInput').setAttribute('aria-activedescendant', active.id);
}

function setEmojiPopIndex(i) {
  if (!emojiPop || i === emojiPop.index) return;
  emojiPop.index = i;
  paintEmojiPopSelection();
}

function moveEmojiPop(delta) {
  const n = emojiPop.items.length;
  setEmojiPopIndex(((emojiPop.index + delta) % n + n) % n); // wraps both ways
}

function pickEmoji(i) {
  const item = emojiPop?.items[i];
  if (!item) return;
  const input = $('#composerInput');
  // Focus first: a mouse pick has to put the caret back before the insert, and
  // execCommand only writes to the undo stack of the focused element.
  input.focus();
  // Re-read the run rather than trusting the offset captured at render time.
  // Not every caret move is observable (Ctrl+A, a context-menu paste, an IME
  // commit), so a stale `start` would splice the emoji into the middle of the
  // text and leave the ":shr" behind.
  const q = shortcodeQueryBefore(input.value, input.selectionStart);
  closeEmojiPop();
  if (!q) return;
  replaceRange(input, q.start, input.selectionStart, item.emoji);
  bumpEmojiFreq(item.emoji);
  autoGrow();
  updateSendEnabled();
}

// Returns true when the popup consumed the key, so the composer's own Enter /
// ArrowUp handlers stay out of the way while it's open.
function emojiPopKey(e) {
  // Mid-composition an IME owns these keys: Enter commits its candidate and the
  // arrows walk the candidate list. Stealing them would insert an emoji instead.
  if (!emojiPop || e.isComposing) return false;
  // Modifiers mean something else in the composer (Shift+Enter is a newline), so
  // only the bare keys belong to the popup.
  const bare = !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
  switch (e.key) {
    case 'ArrowDown': if (!bare) return false; moveEmojiPop(1); break;
    case 'ArrowUp': if (!bare) return false; moveEmojiPop(-1); break;
    case 'Enter': case 'Tab': if (!bare) return false; pickEmoji(emojiPop.index); break;
    case 'Escape': dismissEmojiPop(); break;
    default: return false;
  }
  e.preventDefault();
  return true;
}

// ---------- GIF picker ----------
// "/gif [query]" in the composer opens the picker instead of sending. Invoked
// from the top of sendMessage(), so it covers both Enter and the Send button.
function tryGifCommand() {
  if (!state.activeId) return false;
  const input = $('#composerInput');
  const query = parseGifCommand(input.value);
  if (query === null) return false;
  input.value = '';
  autoGrow();
  updateSendEnabled();
  openGifPicker(query);
  return true;
}

// Modal GIF picker: search box + a masonry grid of animated previews served
// straight from Giphy's CDN. Picking one sends it (with any caption still in the
// composer) through /send-gif. Mirrors the openLightbox() overlay/Escape pattern.
function openGifPicker(initialQuery = '') {
  if (!state.activeId) return;
  closeEmojiPop();

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
    applyJumbo(bubble, { text, bodyRanges, attachments: [g] }); // ditto: the GIF is media
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
  const hint = tldrHint(data);
  children.push(hint.note
    ? el('div', { class: 'menu-note', text: hint.note })
    : el('div', { class: 'menu-hint' }, [hint.before, el('code', { text: hint.code }), hint.after]));
  // A logged-out CLI is the one hint the user can act on from here, so it gets a
  // button rather than only a sentence. It runs the same flow as the failure
  // bubble's Log in and reports into that bubble, so closing the menu (which the
  // click does) doesn't lose the code field.
  if (hint.login) {
    children.push(el('button', {
      class: 'menu-item', role: 'menuitem',
      onclick: () => { closeThreadMenu(); beginClaudeLogin(); },
    }, [el('span', { class: 'menu-check' }), el('span', { class: 'menu-label', text: 'Log in to Claude Code…' })]));
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

// Store a conversation's status, bounding the Map (eviction rule in ui-logic.js).
const TLDR_CONV_CAP = 50;
function setTldrFor(convId, status) {
  const key = String(convId);
  tldrByConv.set(key, status);
  evictOldestTldr(tldrByConv, TLDR_CONV_CAP, state.activeId);
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
// rides into the Retry handler so a manual retry knows what to re-run. What to
// show (label, icon, which buttons) is decided in ui-logic.js (tldrBubble);
// this only paints it.
function renderTldrStatus(stage, reason, url, kind) {
  const host = $('#tldrStatus');
  if (!host) return;
  const b = tldrBubble(stage, reason, kind);
  const children = [];
  if (b.tone === 'warn') children.push(el('span', { class: 'tldr-icon', text: '⚠' }));
  else if (b.tone === 'work') children.push(el('span', { class: 'tldr-spinner' }));
  children.push(el('span', { class: 'tldr-text', text: b.label }));
  // The sign-in link is a real anchor, never window.open(): opened after an
  // await it would be eaten by the popup blocker, and the CLI has usually
  // opened its own tab in the server machine's default browser already — which
  // may not be the browser you are reading this in. A plain link works in both
  // cases and needs no popup permission.
  if (b.codeInput) children.push(...tldrLoginForm(url));
  if (b.login) children.push(el('button', { class: 'tldr-retry', text: 'Log in', onclick: () => beginClaudeLogin(url) }));
  // Retry is dropped when there is no link to re-run (the 'logged-in' bubble
  // reached from the thread menu); a button whose action has no argument is a
  // trap, and that is a rendering concern rather than a stage-policy one.
  if (b.retry && url) children.push(el('button', { class: 'tldr-retry', text: 'Retry', onclick: () => retryTldr(url) }));
  if (b.cancelLogin) children.push(el('button', { class: 'tldr-retry', text: 'Cancel', onclick: () => cancelClaudeLogin(url) }));
  if (b.dismiss) {
    children.push(el('button', {
      class: 'tldr-dismiss', text: '×', title: 'Dismiss', 'aria-label': 'Dismiss', onclick: () => clearTldrFor(state.activeId),
    }));
  }
  const cls = 'tldr-bubble' + (b.tone === 'warn' ? ' failed' : b.tone === 'info' ? ' info' : '');
  host.replaceChildren(el('div', { class: cls }, children));
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
    // A clean done clears the bubble; a done WITH a reason means the TLDR was
    // sent but its "For context" block failed, so fall through and show the
    // dismissible notice instead of vanishing silently.
    if (!e.reason) {
      clearTldrFor(convId);
      return;
    }
  }
  // `kind` is the server's fixed classification of a failure ('auth' /
  // 'not-found'); it is what decides whether the bubble offers to log in, so it
  // is never inferred from the human-readable reason text.
  setTldrFor(convId, { stage: e.state, reason: e.reason, url: e.url, kind: e.kind });
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
  renderTldrStatus(st.stage, st.reason, st.url, st.kind);
}

// ---------- in-app `claude auth login` ----------
// The auto-TLDR bubble's dead end used to be "Auto-TLDR failed: Claude Code CLI
// is not logged in" plus a Retry that could not possibly work until the user
// found a terminal. These three handlers drive the server's login routes (see
// src/claude-cli.js) so the whole thing happens in the tab you are already in.
//
// The CLI uses the paste-a-code OAuth redirect rather than a localhost callback,
// so a new tab alone cannot finish it — the flow is: start the login, open the
// sign-in page, paste the code that page gives you back into the bubble.
//
// ⚠️ That code is a credential. It goes straight to the server (loopback only)
// and into the CLI's stdin. Never log it, never put it in a URL, never store it.
//
// Only one login can be pending server-side, so the URL for it is a single
// module-level value rather than per-conversation state.
let claudeAuthUrl = null;

// The sign-in link + the code field, as bubble children.
//
// The link is a real anchor: opened from a click handler after an await,
// window.open() is eaten by the popup blocker, and the CLI has usually already
// opened its own tab in the SERVER machine's default browser — which may not be
// the browser you are reading this in. An anchor works either way.
function tldrLoginForm(url) {
  const input = el('input', {
    class: 'tldr-code', type: 'text', placeholder: 'Code, if it asks for one',
    'aria-label': 'Sign-in code', autocomplete: 'off', spellcheck: 'false',
    onkeydown: (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitClaudeCode(input.value, url); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelClaudeLogin(); }
    },
  });
  // Focus without stealing it from a user already typing in the composer.
  setTimeout(() => { if (document.activeElement === document.body) input.focus(); }, 0);
  const nodes = [];
  if (claudeAuthUrl) {
    nodes.push(el('a', {
      class: 'tldr-link', href: claudeAuthUrl, target: '_blank', rel: 'noopener noreferrer',
      text: 'Open sign-in page',
    }));
  }
  nodes.push(input);
  nodes.push(el('button', { class: 'tldr-retry', text: 'Submit', onclick: () => submitClaudeCode(input.value, url) }));
  return nodes;
}

// Start the login and show the code field. `url` is the YouTube link whose
// summary failed, carried through so the bubble can offer to re-run it once the
// sign-in lands; it is undefined when this is reached from the thread menu.
async function beginClaudeLogin(url) {
  const key = state.activeId;
  if (!key) return;
  // We deliberately do NOT open a tab here. `claude auth login` opens one itself
  // as it starts, so doing it too gave the user two sign-in windows for one
  // login -- and only one of them belongs to the OAuth exchange the CLI is
  // actually waiting on, which makes "which of these do I use?" a real question
  // with a wrong answer in it. The anchor in the bubble covers the case the
  // CLI's tab cannot: it opens in the *server machine's* default browser, which
  // need not be the browser this app is open in.
  const prev = tldrByConv.get(key);
  setTldrFor(key, { stage: 'logging-in', url, prev });
  renderActiveTldr();
  let r;
  try {
    r = await api('/api/tldr/login', { method: 'POST' });
    if (!r.ok) throw new Error(r.error || 'login failed');
  } catch (err) {
    setTldrFor(key, { stage: 'login-failed', reason: loginErrorReason(err.message), url, prev });
    renderActiveTldr();
    return;
  }
  claudeAuthUrl = r.url;
  setTldrFor(key, { stage: 'login', url, prev });
  renderActiveTldr();
  pollClaudeLogin(key, url, prev);
}

// Watch for the login finishing on its own, which is the NORMAL path: the
// sign-in page calls back, the CLI exits logged in, and no code is ever shown.
// Polling is cheap by design — the server answers from the child's exit and only
// checks the credential store once, so this is not a spawn every two seconds.
const LOGIN_POLL_MS = 1500;
const LOGIN_POLL_LIMIT = 400; // ~10 min, matching the server's pending timeout
let loginPollTimer = null;
function stopClaudeLoginPoll() {
  if (loginPollTimer) { clearTimeout(loginPollTimer); loginPollTimer = null; }
}
function pollClaudeLogin(key, url, prev, tries = 0) {
  stopClaudeLoginPoll();
  loginPollTimer = setTimeout(async () => {
    // The user cancelled, switched away from the flow, or typed a code in by
    // hand while we were waiting — whatever the bubble says now, it isn't ours.
    if (tldrByConv.get(key)?.stage !== 'login') return;
    let st;
    try { st = await api('/api/tldr/login/status'); }
    catch { st = null; } // a blip shouldn't abandon a login that may still land
    if (tldrByConv.get(key)?.stage !== 'login') return;
    if (st && st.loggedIn === true) return finishClaudeLogin(key, url);
    if (st && st.loggedIn === false) {
      claudeAuthUrl = null;
      setTldrFor(key, { stage: 'login-failed', reason: 'sign-in did not complete', url, prev });
      renderActiveTldr();
      return;
    }
    if (tries + 1 >= LOGIN_POLL_LIMIT) {
      setTldrFor(key, { stage: 'login-failed', reason: 'timed out waiting for sign-in', url, prev });
      renderActiveTldr();
      return;
    }
    pollClaudeLogin(key, url, prev, tries + 1);
  }, LOGIN_POLL_MS);
}

// Shared landing point for both completion paths (the browser callback and a
// pasted code): the server has already re-probed availability via its onLogin
// hook, so go straight back to the link that failed.
function finishClaudeLogin(key, url) {
  stopClaudeLoginPoll();
  claudeAuthUrl = null;
  refreshThreadMenuIfOpen(key); // the toggle's "not logged in" hint is now stale
  // Straight on with the summary that failed, rather than parking on a "signed
  // in" notice and making the user click Retry: the link is the thing they
  // wanted, and the login was only ever in the way of it.
  if (url) { retryTldr(url); return; }
  // Reached from the thread menu instead, with no link in flight: say it worked.
  setTldrFor(key, { stage: 'logged-in', url });
  renderActiveTldr();
}

// Hand the pasted code to the server, which writes it to the waiting CLI.
async function submitClaudeCode(code, url) {
  const key = state.activeId;
  const clean = String(code || '').trim();
  if (!key || !clean) return;
  const prev = tldrByConv.get(key)?.prev;
  stopClaudeLoginPoll(); // this hand-entered code supersedes the watcher
  setTldrFor(key, { stage: 'logging-in', url, prev });
  renderActiveTldr();
  try {
    const r = await api('/api/tldr/login/code', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: clean }),
    });
    if (!r.ok) throw new Error(r.error || 'not-logged-in');
  } catch (err) {
    setTldrFor(key, { stage: 'login-failed', reason: loginErrorReason(err.message), url, prev });
    renderActiveTldr();
    return;
  }
  finishClaudeLogin(key, url);
}

// Back out of a login: drop the server's pending child and restore whatever the
// bubble said before, so cancelling returns you to the failure rather than to a
// blank thread.
async function cancelClaudeLogin() {
  const key = state.activeId;
  if (!key) return;
  stopClaudeLoginPoll();
  claudeAuthUrl = null;
  const prev = tldrByConv.get(key)?.prev;
  if (prev) setTldrFor(key, prev); else tldrByConv.delete(key);
  renderActiveTldr();
  try { await api('/api/tldr/login/cancel', { method: 'POST' }); } catch { /* best effort */ }
}

// Map a login failure to something worth reading. Same discipline as
// retryErrorReason: the server's errors are fixed tokens, and anything else is
// reported generically rather than dumped raw into the bubble.
function loginErrorReason(msg) {
  const s = String(msg || '');
  if (/not-found/.test(s)) return 'the claude CLI was not found';
  if (/no-url/.test(s)) return 'the CLI did not offer a sign-in link';
  if (/no-pending-login/.test(s)) return 'that sign-in expired — start again';
  if (/bad-code/.test(s)) return 'that does not look like a valid code';
  if (/not-logged-in/.test(s)) return 'the code was not accepted';
  return 'could not sign in';
}

// Repaint an open thread menu so a just-completed login clears its stale hint.
async function refreshThreadMenuIfOpen(id) {
  if (!threadMenuOpen || state.activeId !== id) return;
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(id)}/tldr`);
    if (threadMenuOpen && state.activeId === id) buildThreadMenu(id, data);
  } catch { /* leave the menu as it is */ }
}

// Ask the server to run one link's summary now, and follow it in the status
// bubble. `kind` picks the endpoint: 'retry' re-runs a link whose summary failed
// (ungated server-side — it's the recovery path), 'summarize' is the message
// menu's explicit action, which the server refuses once that video has a summary
// in this chat. Optimistically store the first real stage ('fetching', what the
// server emits first) so the label doesn't visibly run backwards; the rest stream
// back over SSE, identically for both.
async function startTldr(url, kind) {
  const id = state.activeId;
  if (!id || !url) return;
  const key = String(id);
  setTldrFor(key, { stage: 'fetching', reason: null, url });
  renderActiveTldr();
  try {
    const r = await api(`/api/conversations/${encodeURIComponent(id)}/tldr/${kind}`, {
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

// The bubble's Retry button, which only ever re-runs a link the pipeline already
// had in hand.
const retryTldr = (url) => startTldr(url, 'retry');

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
    if (!e.isComposing) {
      expandShortcodeAtCaret(input); // never rewrite mid-IME-composition
      updateEmojiPop();              // after the expansion, so a just-closed ":shrug:" doesn't leave a list behind
    }
    autoGrow();
    updateSendEnabled();
    warmLinkPreview(input.value);
  });
  // The caret can move without the text changing (clicks, plain arrow keys); the
  // popup describes a position, so it has to follow.
  input.addEventListener('click', updateEmojiPop);
  input.addEventListener('keyup', (e) => {
    const key = e.key || ''; // synthetic/autofill events can arrive without one
    if (emojiPop && (key === 'ArrowUp' || key === 'ArrowDown')) return; // those moved the highlight, not the caret
    if (key.startsWith('Arrow') || key === 'Home' || key === 'End') updateEmojiPop();
  });
  input.addEventListener('blur', closeEmojiPop);
  // An IME owns Enter and the arrows while composing, and updateEmojiPop() is
  // skipped for the duration, so the list would sit there going stale.
  input.addEventListener('compositionstart', closeEmojiPop);
  input.addEventListener('keydown', (e) => {
    if (emojiPopKey(e)) return; // suggestions open: they get Enter/Tab/arrows/Escape first
    // Enter commits the candidate mid-IME-composition; sending there would fire
    // on every word a CJK user types.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); return; }
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

    // Scroll-to-load-older, stage 1: arm near the top, then measure how much
    // further up the user keeps going (see noteOlderIntent).
    const top = m.scrollTop;
    const up = lastScrollTop - top;
    lastScrollTop = top;
    if (up < 0) resetOlderGesture(); // heading back down abandons the gesture
    if (top > OLDER_ARM_PX || !state.hasOlder) { resetOlderGesture(); return; }
    if (!olderArmedAt) { armOlderGesture(); return; } // arriving is free
    noteOlderIntent(up);
  });

  // Stage 2: once the thread is pinned at scrollTop 0 no scroll events fire, so
  // the raw wheel/touch deltas are the only remaining evidence of upward intent.
  $('#messages').addEventListener('wheel', (e) => {
    if (e.deltaY > 0) { resetOlderGesture(); return; }
    if (e.deltaY === 0) return; // horizontal-only wheel; says nothing either way
    const m = $('#messages');
    if (m.scrollTop > 1) return; // still scrollable, so the scroll handler counts it
    armOlderGesture();
    // deltaMode: 0 = pixels (normal), 1 = lines, 2 = pages.
    const unit = e.deltaMode === 1 ? OLDER_WHEEL_LINE_PX : e.deltaMode === 2 ? m.clientHeight : 1;
    noteOlderIntent(-e.deltaY * unit);
  }, { passive: true });

  let lastTouchY = null;
  $('#messages').addEventListener('touchstart', (e) => {
    lastTouchY = e.touches.length === 1 ? e.touches[0].clientY : null;
  }, { passive: true });
  $('#messages').addEventListener('touchmove', (e) => {
    if (lastTouchY == null || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    const dy = y - lastTouchY; // finger moving down = pulling older content into view
    lastTouchY = y;
    if (dy < 0) { resetOlderGesture(); return; }
    if ($('#messages').scrollTop > 1) return;
    armOlderGesture();
    noteOlderIntent(dy);
  }, { passive: true });

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

  $('#loadOlder').addEventListener('click', () => { loadOlderMessages(); });

  connectSSE();
  loadConversations();

  // initial status probe
  api('/api/status').then((s) => {
    setStatus(s.status);
    state.me = s.me;
  }).catch(() => setStatus('disconnected'));
}

init();
