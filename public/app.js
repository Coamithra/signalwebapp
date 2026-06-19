// Signal web app — frontend. Talks to the local bridge server over REST,
// receives realtime nudges via SSE, and renders a Signal-like chat UI.

const $ = (sel) => document.querySelector(sel);

const state = {
  conversations: [],
  filtered: null,
  activeId: null,
  me: null,
  nearBottom: true,
  lastActiveTimestamp: 0,
  sending: false,
};

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
    try { msg = (await res.json()).message || msg; } catch {}
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

function messageRow(msg, prev, isGroup) {
  if (msg.direction === 'system') return null;

  const sameAuthorAsPrev =
    prev && prev.direction === msg.direction && prev.authorId === msg.authorId &&
    (msg.timestamp - prev.timestamp) < 3 * 60 * 1000;

  const row = el('div', {
    class: `msg-row ${msg.direction} ${sameAuthorAsPrev ? 'tight' : 'loose'}`,
  });

  // group sender label on incoming
  if (isGroup && msg.direction === 'incoming' && !sameAuthorAsPrev && msg.authorTitle) {
    const label = el('div', { class: 'msg-author', text: msg.authorTitle });
    label.style.color = colorFor(msg.authorId || msg.authorTitle);
    row.appendChild(label);
  }

  if (msg.deletedForEveryone) {
    row.appendChild(el('div', { class: 'bubble deleted', text: 'This message was deleted' }));
    return row;
  }

  const bubble = el('div', { class: 'bubble' });

  for (const att of msg.attachments) {
    const icon = att.kind === 'image' ? '🖼️' : att.kind === 'video' ? '🎬'
      : att.kind === 'voice' ? '🎤' : att.kind === 'audio' ? '🎵' : '📎';
    const label = att.fileName || (att.kind === 'image' ? 'Photo' : att.kind === 'video' ? 'Video'
      : att.kind === 'voice' ? 'Voice message' : att.kind === 'audio' ? 'Audio' : 'Attachment');
    bubble.appendChild(el('div', { class: 'attachment-chip' }, [
      el('span', { class: 'att-icon', text: icon }),
      el('span', { text: label }),
    ]));
  }

  if (msg.isViewOnce) {
    bubble.appendChild(el('div', { text: '👁 View-once media' }));
  } else if (msg.text) {
    bubble.appendChild(document.createTextNode(msg.text));
  }
  if (!bubble.childNodes.length) bubble.appendChild(document.createTextNode(' '));
  row.appendChild(bubble);

  if (msg.reactions && msg.reactions.length) {
    const counts = {};
    for (const r of msg.reactions) counts[r.emoji] = (counts[r.emoji] || 0) + 1;
    const rx = el('div', { class: 'reactions' });
    for (const [emoji, n] of Object.entries(counts)) {
      rx.appendChild(el('span', { class: 'reaction-pill', text: n > 1 ? `${emoji} ${n}` : emoji }));
    }
    row.appendChild(rx);
  }

  const meta = el('div', { class: 'msg-meta' }, [fmtMsgTime(msg.timestamp)]);
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

function renderMessages(data) {
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

let openToken = 0;
async function openConversation(id) {
  if (state.activeId !== id) {
    state.activeId = id;
    renderConversations(); // update active highlight
  }
  $('#emptyState').classList.add('hidden');
  $('#conversationView').classList.remove('hidden');

  const conv = state.conversations.find((c) => c.id === id);
  if (conv) {
    renderThreadHeader(conv);
    state.lastActiveTimestamp = conv.timestamp;
  }

  const token = ++openToken;
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
function scheduleRefreshActive() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshActiveMessages, 150);
}
async function refreshActiveMessages() {
  if (!state.activeId) return;
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
  if (force || state.nearBottom) m.scrollTop = m.scrollHeight;
}

// ---------- composer ----------
async function sendMessage() {
  const input = $('#composerInput');
  const text = input.value.trim();
  if (!text || !state.activeId || state.sending) return;
  const id = state.activeId;
  state.sending = true;
  input.value = '';
  autoGrow();

  // optimistic echo
  const inner = $('#messagesInner');
  const optimistic = messageRow(
    { direction: 'outgoing', text, attachments: [], reactions: [], timestamp: Date.now(), status: 'sending', authorId: 'me' },
    null, false,
  );
  optimistic.classList.add('optimistic');
  inner.appendChild(optimistic);
  scrollToBottom(true);

  try {
    const r = await api(`/api/conversations/${encodeURIComponent(id)}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) throw new Error(r.error || 'send failed');
    scheduleRefreshActive();
  } catch (err) {
    toast('Failed to send: ' + err.message, true);
    optimistic.querySelector('.tick')?.replaceWith(
      Object.assign(document.createElement('span'), { className: 'tick error', textContent: '⚠' }),
    );
  } finally {
    state.sending = false;
  }
}

function autoGrow() {
  const input = $('#composerInput');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
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
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  $('#sendBtn').addEventListener('click', sendMessage);

  $('#messages').addEventListener('scroll', () => {
    const m = $('#messages');
    state.nearBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 120;
  });

  $('#loadOlder').addEventListener('click', async () => {
    if (!state.activeId) return;
    try {
      const m = $('#messages');
      const prevH = m.scrollHeight;
      const data = await api(`/api/conversations/${encodeURIComponent(state.activeId)}/messages?older=1`);
      renderMessages(data);
      m.scrollTop = m.scrollHeight - prevH; // keep viewport anchored
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
