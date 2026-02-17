const $ = (id) => document.getElementById(id);
const state = {
  me: null,
  lastId: 0,
  redeemId: null,
  ws: null,
  channels: [],
  users: [],
  sidebarView: 'server',
  mode: 'channel',
  activeChannelId: null,
  activeDmPeerId: null,
  voice: {
    room: null,
    stream: null,
    peers: new Map(),
    muted: false
  },
  adminMode: false,
  replyTo: null,
  allChannels: [],
  pendingImageFile: null,
  pendingImagePreviewUrl: '',
  dmSearchQuery: '',
  notifications: [],
  unreadNotifications: 0
};

const spamMap = {1:{burst:3,sustained:10,cooldown:120},3:{burst:5,sustained:15,cooldown:60},5:{burst:8,sustained:25,cooldown:30},7:{burst:12,sustained:40,cooldown:15},10:{burst:20,sustained:80,cooldown:5}};

function text(el, v){ el.textContent = v; }
function clearNotice(){ const n=$('authMsg'); n.classList.remove('error','ok'); n.classList.add('hidden'); text(n,''); }
function setNotice(msg, kind='error'){ const n=$('authMsg'); n.classList.remove('hidden','error','ok'); if(kind) n.classList.add(kind); text(n,msg); }
function showAuth(msg='', kind=''){ $('authView').classList.remove('hidden'); $('appView').classList.add('hidden'); $('settingsMenuWrap').classList.add('hidden'); $('notifMenuWrap').classList.add('hidden'); if(msg) setNotice(msg,kind); else clearNotice(); }
function showApp(){ $('authView').classList.add('hidden'); $('appView').classList.remove('hidden'); $('settingsMenuWrap').classList.remove('hidden'); $('notifMenuWrap').classList.remove('hidden'); clearNotice(); }
function fmtTs(v){ try { return new Date(v).toLocaleString(); } catch { return String(v||''); } }
function setBusy(btn, busy){ if(!btn) return; btn.disabled = busy; btn.textContent = busy ? 'Working...' : (btn.dataset.label || btn.textContent); }

function humanError(err){
  const msg = String(err?.message || 'unknown_error');
  if (msg === 'invalid_credentials') return 'Wrong username or password.';
  if (msg === 'session_expired' || msg === 'unauthorized') return 'Your session is not active. Please log in again.';
  if (msg === 'invalid_invite') return 'Invite token is invalid, expired, revoked, or already used.';
  if (msg === 'target_required') return 'Pick a channel or DM target first.';
  if (msg === 'name_required') return 'Channel name is required.';
  if (msg === 'invalid_kind') return 'Channel type must be text or voice.';
  if (msg === 'invalid_position') return 'Position must be a positive number.';
  if (msg === 'confirm_checkbox_required') return 'You must check the permanent-delete confirmation box.';
  if (msg === 'confirm_username_mismatch') return 'Typed username does not match exactly (case-sensitive).';
  if (msg === 'cannot_delete_admin') return 'The admin user cannot be deleted.';
  if (msg === 'display_name_required') return 'Display name is required.';
  if (msg === 'invalid_color') return 'Display color must be a hex color like #AABBCC.';
  if (msg === 'invalid_reply_target') return 'Cannot reply to a message outside the current conversation.';
  if (msg === 'empty_body') return 'Message cannot be empty.';
  if (msg === 'forbidden') return 'You do not have permission for that action.';
  return msg;
}

function messageAuthorLabel(m) {
  return m.display_name || m.username || 'user';
}

function setReplyTarget(m) {
  state.replyTo = m ? { id: m.id, body: m.body || '', author: messageAuthorLabel(m) } : null;
  const box = $('replyPreview');
  if (!state.replyTo) {
    box.classList.add('hidden');
    box.textContent = '';
    return;
  }
  box.classList.remove('hidden');
  box.textContent = `Replying to ${state.replyTo.author}: ${(state.replyTo.body || '').slice(0, 140)}`;
  const cancel = document.createElement('button');
  cancel.textContent = '×';
  cancel.style.marginLeft = '.5rem';
  cancel.onclick = () => setReplyTarget(null);
  box.appendChild(cancel);
}

function clearPendingImage() {
  state.pendingImageFile = null;
  if (state.pendingImagePreviewUrl) {
    URL.revokeObjectURL(state.pendingImagePreviewUrl);
    state.pendingImagePreviewUrl = '';
  }
  const box = $('pendingImage');
  box.classList.add('hidden');
  box.textContent = '';
  $('attachFile').value = '';
}

function setPendingImage(file) {
  if (!file) return clearPendingImage();
  clearPendingImage();
  state.pendingImageFile = file;
  state.pendingImagePreviewUrl = URL.createObjectURL(file);
  const box = $('pendingImage');
  box.classList.remove('hidden');
  const img = document.createElement('img');
  img.src = state.pendingImagePreviewUrl;
  img.alt = 'Pending image';
  const meta = document.createElement('div');
  meta.className = 'small';
  meta.textContent = `${file.name || 'clipboard-image'} (${Math.round(file.size / 1024)} KB)`;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = 'Remove';
  remove.onclick = clearPendingImage;
  box.append(img, meta, remove);
}

function openLightbox(url) {
  const wrap = $('imageLightbox');
  $('lightboxImg').src = url;
  wrap.classList.remove('hidden');
}

function closeLightbox() {
  const wrap = $('imageLightbox');
  wrap.classList.add('hidden');
  $('lightboxImg').src = '';
}

async function api(path, method='GET', body){
  const res = await fetch(path,{method,credentials:'include',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  let data = {};
  try { data = await res.json(); } catch {}
  if(!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function renderMessage(m){
  const wrap = document.createElement('div'); wrap.className='msg';
  wrap.dataset.messageId = String(m.id);
  const meta = document.createElement('div'); meta.className='meta';
  meta.textContent = `${m.display_name || m.username || 'user'} · ${fmtTs(m.created_at)}`;
  if (m.display_color) meta.style.color = m.display_color;
  const body = document.createElement('div');
  if (messageMentionsMe(m.body)) wrap.classList.add('mentionPing');
  body.style.whiteSpace = 'pre-wrap';
  body.style.wordBreak = 'break-word';
  const full = m.body || '';
  const short = full.length > 2000 ? full.slice(0,2000) : full;
  if (m.reply_to) {
    const reply = document.createElement('div');
    reply.className = 'small';
    reply.style.borderLeft = '2px solid var(--line)';
    reply.style.paddingLeft = '.45rem';
    reply.style.marginBottom = '.25rem';
    reply.textContent = `↪ ${(m.reply_body || '').slice(0,120)}`;
    wrap.appendChild(reply);
  }
  body.textContent = short;
  wrap.append(meta, body);
  wrap.style.paddingTop = '.8rem';
  if (full.length > 2000){
    const b = document.createElement('button'); b.textContent='Read more';
    b.onclick = () => { body.textContent = full.slice(0,10000); b.remove(); };
    wrap.appendChild(b);
  }
  if (Array.isArray(m.uploads) && m.uploads.length) {
    const imgWrap = document.createElement('div');
    for (const up of m.uploads) {
      const ct = String(up.content_type || '');
      if (!ct.startsWith('image/')) continue;
      const img = document.createElement('img');
      img.className = 'msgImage';
      img.src = up.url;
      img.alt = 'Uploaded image';
      img.loading = 'lazy';
      img.onclick = () => openLightbox(up.url);
      imgWrap.appendChild(img);
    }
    if (imgWrap.children.length) wrap.appendChild(imgWrap);
  }
  const tools = document.createElement('div');
  tools.className = 'msgTools';

  const replyBtn = document.createElement('button');
  replyBtn.className = 'ghost';
  replyBtn.title = 'Reply';
  replyBtn.textContent = '↩';
  replyBtn.onclick = ()=> setReplyTarget(m);
  tools.appendChild(replyBtn);

  const canModerate = state.me?.username === 'mcassyblasty' && state.adminMode;
  const own = Number(m.author_id) === Number(state.me?.id);

  if (own) {
    const edit = document.createElement('button');
    edit.className = 'ghost';
    edit.title = 'Edit message';
    edit.textContent = '✏️';
    edit.onclick = async()=>{
      const next = prompt('Edit message', m.body || '');
      if (next === null) return;
      try {
        const r = await api(`/api/messages/${m.id}`, 'PATCH', { body: next });
        body.textContent = r.body || next;
      } catch (err) {
        alert(`Edit failed: ${humanError(err)}`);
      }
    };
    tools.appendChild(edit);
  }

  if (own || canModerate) {
    const del = document.createElement('button');
    del.className = 'ghost';
    del.title = 'Delete message';
    del.textContent = '🗑️';
    del.onclick = async () => {
      if (!confirm('Delete this message?')) return;
      try {
        await api(`/api/messages/${m.id}`, 'DELETE');
        wrap.remove();
      } catch (err) {
        alert(`Delete failed: ${humanError(err)}`);
      }
    };
    tools.appendChild(del);
  }

  if (tools.children.length) wrap.appendChild(tools);
  $('msgs').appendChild(wrap);
}

function isCurrentTarget(m){
  if (state.mode === 'channel') return Number(m.channel_id) === Number(state.activeChannelId);
  if (state.mode === 'dm') {
    const meId = Number(state.me?.id || 0);
    const peerId = Number(state.activeDmPeerId || 0);
    const a = Number(m.dm_user_a || 0);
    const b = Number(m.dm_user_b || 0);
    if (a && b) {
      return (a === meId && b === peerId) || (a === peerId && b === meId);
    }
    return Number(m.dm_peer_id) === peerId && Number(m.author_id) === peerId;
  }
  return false;
}

function normalizeHex(v, fallback = '#FFFFFF') {
  const s = String(v || '').trim();
  return /^#[0-9A-F]{6}$/i.test(s) ? s.toUpperCase() : fallback;
}


function normalizeMentionKey(v) {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, '');
}

function mentionCandidates() {
  const out = [];
  const seen = new Set();
  const add = (user) => {
    if (!user) return;
    const username = String(user.username || '').trim();
    const displayName = String(user.display_name || '').trim();
    if (username) {
      const key = normalizeMentionKey(username);
      if (!seen.has(key)) {
        out.push({ token: username, key, userId: Number(user.id || 0), label: `@${username}` });
        seen.add(key);
      }
    }
    if (displayName && !displayName.includes(' ')) {
      const key = normalizeMentionKey(displayName);
      if (!seen.has(key)) {
        out.push({ token: displayName, key, userId: Number(user.id || 0), label: `${displayName} (@${username || 'user'})` });
        seen.add(key);
      }
    }
  };
  add(state.me);
  for (const u of state.users) add(u);
  return out;
}

function currentMentionContext(input) {
  const cursor = Number(input.selectionStart || 0);
  const value = String(input.value || '');
  const left = value.slice(0, cursor);
  const match = left.match(/(^|\s)@([A-Za-z0-9_.-]*)$/);
  if (!match) return null;
  const typed = match[2] || '';
  const start = cursor - typed.length - 1;
  return { start, end: cursor, typed, cursor };
}

function updateMentionHint() {
  const hint = $('mentionHint');
  if (!hint) return;
  const input = $('msgInput');
  const ctx = currentMentionContext(input);
  if (!ctx) {
    hint.classList.add('hidden');
    hint.textContent = '';
    return;
  }
  const typedKey = normalizeMentionKey(ctx.typed);
  const filtered = mentionCandidates().filter((c) => !typedKey || c.key.startsWith(typedKey)).slice(0, 5);
  if (!filtered.length) {
    hint.classList.add('hidden');
    hint.textContent = '';
    return;
  }
  const primary = filtered[0];
  hint.textContent = `Tab to mention @${primary.token}${filtered.length > 1 ? ` (+${filtered.length - 1} more)` : ''}`;
  hint.classList.remove('hidden');
}

function applyMentionAutocomplete() {
  const input = $('msgInput');
  const ctx = currentMentionContext(input);
  if (!ctx) return false;
  const typedKey = normalizeMentionKey(ctx.typed);
  if (!typedKey) return false;
  const candidate = mentionCandidates().find((c) => c.key.startsWith(typedKey));
  if (!candidate) return false;
  const v = String(input.value || '');
  input.value = `${v.slice(0, ctx.start)}@${candidate.token} ${v.slice(ctx.end)}`;
  const pos = ctx.start + candidate.token.length + 2;
  input.setSelectionRange(pos, pos);
  updateMentionHint();
  return true;
}

function messageMentionsMe(body) {
  const textBody = String(body || '');
  if (!textBody) return false;
  const keys = new Set();
  const add = (v) => { const k = normalizeMentionKey(v); if (k) keys.add(k); };
  add(state.me?.username);
  add(state.me?.display_name);
  if (!keys.size) return false;
  const re = /(^|\s)@([A-Za-z0-9_.-]+)/g;
  let m;
  while ((m = re.exec(textBody)) !== null) {
    if (keys.has(normalizeMentionKey(m[2]))) return true;
  }
  return false;
}

function renderNotifications() {
  const badge = $('notifBadge');
  const list = $('notifList');
  if (!badge || !list) return;
  if (state.unreadNotifications > 0) {
    badge.classList.remove('hidden');
    badge.textContent = String(Math.min(99, state.unreadNotifications));
  } else {
    badge.classList.add('hidden');
    badge.textContent = '0';
  }
  list.textContent = '';
  if (!state.notifications.length) {
    const empty = document.createElement('div');
    empty.className = 'small';
    empty.textContent = 'No recent notifications yet.';
    list.appendChild(empty);
    return;
  }
  for (const n of state.notifications.slice(0, 30)) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'notifItem';
    const top = document.createElement('strong');
    top.textContent = n.title;
    const line = document.createElement('span');
    line.className = 'small';
    line.textContent = n.preview;
    const time = document.createElement('span');
    time.className = 'small';
    time.textContent = fmtTs(n.createdAt);
    item.append(top, line, time);
    item.onclick = () => openNotification(n);
    list.appendChild(item);
  }
}

function addNotificationFromMessage(m) {
  if (!state.me || Number(m.author_id) === Number(state.me.id)) return;
  const ping = messageMentionsMe(m.body);
  const isDm = Boolean(m.dm_user_a && m.dm_user_b);
  if (!ping && !isDm) return;
  const meId = Number(state.me.id || 0);
  const dmPeerId = isDm ? (Number(m.dm_user_a) === meId ? Number(m.dm_user_b) : Number(m.dm_user_a)) : null;
  const title = ping ? `Ping from ${messageAuthorLabel(m)}` : `DM from ${messageAuthorLabel(m)}`;
  const preview = (m.body || '').slice(0, 140) || '(attachment)';
  state.notifications.unshift({
    id: Number(m.id),
    mode: isDm ? 'dm' : 'channel',
    channelId: m.channel_id ? Number(m.channel_id) : null,
    dmPeerId,
    createdAt: m.created_at || new Date().toISOString(),
    title,
    preview
  });
  state.notifications = state.notifications.filter((v, i, arr) => i === arr.findIndex((x) => x.id === v.id));
  state.notifications = state.notifications.slice(0, 60);
  state.unreadNotifications += 1;
  renderNotifications();
}

function focusMessageById(messageId) {
  const id = Number(messageId);
  if (!id) return;
  const n = $('msgs').querySelector(`[data-message-id="${id}"]`);
  if (!n) return;
  n.scrollIntoView({ block: 'center', behavior: 'smooth' });
  n.classList.add('flash');
  setTimeout(() => n.classList.remove('flash'), 1800);
}

async function openNotification(n) {
  $('notifMenu').classList.add('hidden');
  state.notifications = state.notifications.filter((x) => Number(x.id) !== Number(n.id));
  renderNotifications();
  setReplyTarget(null);
  if (n.mode === 'dm' && n.dmPeerId) {
    switchSidebarView('dms');
    state.mode = 'dm';
    state.activeDmPeerId = n.dmPeerId;
    state.activeChannelId = null;
    const active = state.users.find((u) => Number(u.id) === Number(n.dmPeerId));
    text($('chatHeader'), `DM: ${active?.display_name || active?.username || 'Direct Message'}`);
  } else if (n.channelId) {
    switchSidebarView('server');
    state.mode = 'channel';
    state.activeChannelId = Number(n.channelId);
    state.activeDmPeerId = null;
    const active = state.channels.find((c) => Number(c.id) === Number(n.channelId));
    text($('chatHeader'), `# ${active?.name || 'channel'}`);
  }
  renderNavLists();
  await loadMessages();
  closeSidebarOnMobile();
  focusMessageById(n.id);
}


function closeSidebarIfMobileOutsideClick(e) {
  if (!document.body.classList.contains('showSidebar')) return;
  if (window.innerWidth > 960) return;
  const inSidebar = $('appView').contains(e.target) && $('appView').querySelector('.sidebar')?.contains(e.target);
  const drawerClicked = $('drawerBtn').contains(e.target);
  if (!inSidebar && !drawerClicked) document.body.classList.remove('showSidebar');
}

function closeSidebarOnMobile() {
  if (window.innerWidth <= 960) document.body.classList.remove('showSidebar');
}

async function uploadImageFile(file) {
  const fd = new FormData();
  fd.append('image', file);
  const res = await fetch('/api/upload-image', { method: 'POST', credentials: 'include', body: fd });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function loadMessages(){
  let q = '';
  if (state.mode === 'channel' && state.activeChannelId) q = `?channelId=${state.activeChannelId}`;
  if (state.mode === 'dm' && state.activeDmPeerId) q = `?dmPeerId=${state.activeDmPeerId}`;
  const rows = await api(`/api/messages/since/0${q}`);
  $('msgs').textContent = '';
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className='empty';
    empty.textContent = state.mode === 'channel' ? "No messages in this channel yet. Say hi." : "No DM messages yet.";
    $('msgs').appendChild(empty);
    state.lastId = 0;
    return;
  }
  state.lastId = 0;
  for (const m of rows){ renderMessage(m); state.lastId = Math.max(state.lastId, Number(m.id||0)); }
  $('msgs').scrollTop = $('msgs').scrollHeight;
}

function connectWs(){
  if(state.ws) state.ws.close();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if(msg.type === 'message' && msg.data){
      addNotificationFromMessage(msg.data);
    }
    if(msg.type === 'message' && msg.data && isCurrentTarget(msg.data)){
      const placeholder = $('msgs').querySelector('.empty');
      if (placeholder) placeholder.remove();
      renderMessage(msg.data);
      state.lastId = Math.max(state.lastId, Number(msg.data.id || 0));
      $('msgs').scrollTop = $('msgs').scrollHeight;
    }
    if (msg.type === 'message_deleted' && msg.data?.id) {
      const n = $('msgs').querySelector(`[data-message-id="${msg.data.id}"]`);
      if (n) n.remove();
    }
    if (msg.type === 'message_edited' && msg.data?.id) {
      const n = $('msgs').querySelector(`[data-message-id="${msg.data.id}"]`);
      if (n) {
        const bodies = [...n.children].filter((el) => el.tagName === 'DIV' && !el.classList.contains('meta') && !el.classList.contains('small') && !el.classList.contains('msgTools'));
        const body = bodies[bodies.length - 1];
        if (body) body.textContent = msg.data.body || '';
      }
    }
    if (msg.type === 'message' && msg.data?.dm_peer_id) {
      refreshDms().catch(() => {});
    }
    if (msg.type === 'user_deleted' && msg.data?.id) {
      if (state.activeDmPeerId === msg.data.id) {
        state.activeDmPeerId = null;
      }
      refreshDms().catch(() => {});
      if (state.me?.username === 'mcassyblasty') refreshAdmin().catch(() => {});
    }
    handleVoiceSignal(msg).catch((err) => console.warn('voice signal error', err));
  };
  state.ws.onclose = () => setTimeout(connectWs, 2000);
}

async function loadVersion(){
  try {
    const r = await api('/api/version');
    text($('versionLabel'), `v${r.version || '0.0.0'}`);
  } catch {
    text($('versionLabel'), 'vunknown');
  }
}

function applyTheme(theme){
  if(theme === 'discord') document.body.classList.add('discord');
  else document.body.classList.remove('discord');
}

function setSpamEffective(level){
  const p = spamMap[level] || spamMap[5];
  text($('spamEffective'), `Effective: burst ${p.burst}, sustained ${p.sustained}/min, cooldown ${p.cooldown}s`);
}

function defaultComposerPlaceholder() {
  return window.innerWidth <= 960 ? 'Plain-text message' : 'Plain-text message (Enter to send, Shift+Enter for new line)';
}

function setComposerEnabled(enabled, placeholder = null) {
  $('msgInput').disabled = !enabled;
  $('sendBtn').disabled = !enabled;
  $('msgInput').placeholder = placeholder ?? defaultComposerPlaceholder();
}

async function refreshAdmin(){
  if (!state.me || state.me.username !== 'mcassyblasty') {
    $('openAdminBtn').classList.add('hidden');
    return;
  }
  $('openAdminBtn').classList.remove('hidden');
  $('adminModeToggle').checked = state.adminMode;
  const s = await api('/api/admin/state');
  state.allChannels = s.channels || [];
  $('spamLevel').value = String(s.antiSpamLevel);
  $('voiceBitrate').value = String(s.voiceBitrate);
  setSpamEffective(Number(s.antiSpamLevel));

  const inviteList = $('inviteList'); inviteList.textContent='';
  for(const i of s.invites){
    const row = document.createElement('div'); row.className='row';
    const label = document.createElement('span');
    label.textContent = `#${i.id} exp:${fmtTs(i.expires_at)} used:${i.used_at ? 'yes' : 'no'} revoked:${i.revoked_at ? 'yes' : 'no'}`;
    row.appendChild(label);
    if(!i.used_at && !i.revoked_at){
      const btn = document.createElement('button'); btn.textContent='Revoke';
      btn.onclick = async()=>{ await api(`/api/admin/invites/${i.id}/revoke`,'POST',{}); await refreshAdmin(); };
      row.appendChild(btn);
    }
    inviteList.appendChild(row);
  }

  const userList = $('userList'); userList.textContent='';
  for(const u of s.users){
    const row = document.createElement('div'); row.className='row';
    const label = document.createElement('span'); label.textContent = `${u.username} (${u.display_name}) ${u.disabled ? '[frozen]' : ''}`;
    row.appendChild(label);
    if(u.username !== 'mcassyblasty'){
      const btn = document.createElement('button');
      btn.textContent = u.disabled ? 'Unfreeze' : 'Freeze';
      btn.onclick = async()=>{ await api(`/api/admin/users/${u.id}/disable`,'POST',{disabled: !u.disabled}); await refreshAdmin(); };

      const delBtn = document.createElement('button');
      delBtn.textContent = 'Delete User';
      delBtn.onclick = ()=>{
        const existing = row.querySelector('.deleteVerify');
        if (existing) {
          existing.remove();
          return;
        }
        const verify = document.createElement('div');
        verify.className = 'deleteVerify';
        verify.style.display = 'flex';
        verify.style.flexDirection = 'column';
        verify.style.gap = '.4rem';
        verify.style.width = '100%';
        verify.style.marginTop = '.35rem';

        const hint = document.createElement('div');
        hint.className = 'small';
        hint.textContent = `Type username exactly to delete: ${u.username}`;

        const input = document.createElement('input');
        input.placeholder = 'type exact username to confirm';

        const checkRow = document.createElement('label');
        checkRow.className = 'small';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkRow.append(checkbox, document.createTextNode(' I understand this permanently deletes this user account and related messages/uploads.'));

        const actions = document.createElement('div');
        actions.className = 'row';
        const confirm = document.createElement('button');
        confirm.textContent = 'Confirm Delete';
        confirm.onclick = async()=>{
          try {
            await api(`/api/admin/users/${u.id}/delete`, 'POST', { confirmUsername: input.value, confirmChecked: checkbox.checked });
            await refreshChannels();
            await refreshDms();
            await refreshAdmin();
            if (state.mode === 'dm' && state.activeDmPeerId === u.id) {
              state.activeDmPeerId = state.users[0]?.id || null;
              if (state.activeDmPeerId) {
                const active = state.users.find((x) => x.id === state.activeDmPeerId);
                if (active) text($('chatHeader'), `DM: ${active.display_name}`);
              } else {
                state.mode = 'channel';
                const fallback = state.channels.find((c) => c.kind !== 'voice');
                if (fallback) {
                  state.activeChannelId = fallback.id;
                  text($('chatHeader'), `# ${fallback.name}`);
                }
              }
              await loadMessages();
            }
          } catch (err) {
            alert(`Delete user failed: ${humanError(err)}`);
          }
        };
        const cancel = document.createElement('button');
        cancel.textContent = 'Cancel';
        cancel.onclick = ()=> verify.remove();
        actions.append(confirm, cancel);

        verify.append(hint, input, checkRow, actions);
        row.appendChild(verify);
      };

      row.append(btn, delBtn);
    }
    userList.appendChild(row);
  }
  renderChannelAdmin();
}

function switchSidebarView(view){
  state.sidebarView = view;
  const server = view === 'server';
  $('serverSections').classList.toggle('hidden', !server);
  $('dmSections').classList.toggle('hidden', server);
  $('serverViewBtn').classList.toggle('active', server);
  $('dmViewBtn').classList.toggle('active', !server);
}

function showVoicePlaceholder(name){
  state.mode = 'voice';
  state.activeChannelId = null;
  state.activeDmPeerId = null;
  text($('chatHeader'), `Voice: ${name}`);
  $('msgs').textContent = '';
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.textContent = `Joining voice room ${name}… allow microphone access if prompted.`;
  $('msgs').appendChild(empty);
  setComposerEnabled(false, `You are in ${name} voice. Text sending is disabled here.`);
}

function ensureVoiceStatus() {
  let box = $('voiceStatus');
  if (!box) {
    box = document.createElement('div');
    box.id = 'voiceStatus';
    box.className = 'small';
    $('chatHeader').insertAdjacentElement('afterend', box);
  }
  return box;
}

function updateVoiceStatus(extra = '') {
  const connected = state.voice.room ? `Connected: ${state.voice.room}` : 'Not connected to voice';
  const peers = `Peers: ${state.voice.peers.size}`;
  text(ensureVoiceStatus(), [connected, peers, extra].filter(Boolean).join(' · '));
}

async function leaveVoiceRoom() {
  if (state.voice.room) {
    try { state.ws?.send(JSON.stringify({ type: 'voice_leave' })); } catch {}
  }
  for (const peer of state.voice.peers.values()) {
    try { peer.pc.close(); } catch {}
  }
  state.voice.peers.clear();
  if (state.voice.stream) {
    for (const t of state.voice.stream.getTracks()) t.stop();
    state.voice.stream = null;
  }
  state.voice.room = null;
  state.voice.muted = false;
  setComposerEnabled(true);
  updateVoiceStatus('Left room');
  renderNavLists();
  if (state.mode === 'voice') {
    const fallback = state.channels.find((c) => c.kind !== 'voice');
    if (fallback) {
      state.mode = 'channel';
      state.activeChannelId = fallback.id;
      text($('chatHeader'), `# ${fallback.name}`);
      await loadMessages();
    }
  }
}

function peerConnectionFor(targetUserId) {
  if (state.voice.peers.has(targetUserId)) return state.voice.peers.get(targetUserId);
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
  });
  const audio = new Audio();
  audio.autoplay = true;
  audio.playsInline = true;
  const remote = new MediaStream();
  audio.srcObject = remote;

  pc.ontrack = (ev) => { for (const t of ev.streams[0].getTracks()) remote.addTrack(t); };
  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    state.ws?.send(JSON.stringify({ type: 'voice_ice', targetUserId, candidate: ev.candidate }));
  };

  const peer = { pc, audio };
  state.voice.peers.set(targetUserId, peer);
  for (const t of state.voice.stream?.getTracks?.() || []) pc.addTrack(t, state.voice.stream);
  updateVoiceStatus();
  return peer;
}

async function joinVoiceRoom(room) {
  const rejoiningSameRoom = state.voice.room === room;
  if (rejoiningSameRoom) {
    await leaveVoiceRoom();
    return;
  }
  await leaveVoiceRoom();
  showVoicePlaceholder(room);
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone access is unavailable on this browser/origin. Use HTTPS (or localhost) and allow mic permissions.');
    }
    state.voice.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    if (!state.voice.stream.getAudioTracks().length) {
      throw new Error('No microphone track was provided by the browser.');
    }
    state.voice.room = room;
    state.ws?.send(JSON.stringify({ type: 'voice_join', room }));
    const btnRow = document.createElement('div');
    btnRow.className = 'row';
    const mute = document.createElement('button');
    mute.textContent = 'Mute';
    mute.onclick = () => {
      state.voice.muted = !state.voice.muted;
      for (const t of state.voice.stream.getAudioTracks()) t.enabled = !state.voice.muted;
      mute.textContent = state.voice.muted ? 'Unmute' : 'Mute';
      updateVoiceStatus(state.voice.muted ? 'Muted' : 'Unmuted');
    };
    const leave = document.createElement('button');
    leave.textContent = 'Leave Voice';
    leave.onclick = () => leaveVoiceRoom();
    btnRow.append(mute, leave);
    $('msgs').appendChild(btnRow);
    updateVoiceStatus('Connected (microphone active)');
    renderNavLists();
  } catch (err) {
    if (state.voice.stream) {
      for (const t of state.voice.stream.getTracks()) t.stop();
      state.voice.stream = null;
    }
    state.voice.room = null;
    renderNavLists();
    updateVoiceStatus('Mic permission denied or unavailable');
    alert(`Voice join failed: ${err.message || err}`);
  }
}

async function handleVoiceSignal(msg) {
  if (!msg || !msg.type) return;
  if (!['voice_peer_joined', 'voice_offer', 'voice_answer', 'voice_ice', 'voice_peer_left'].includes(msg.type)) return;
  const data = msg.data || {};
  if (!state.voice.room) return;

  if (msg.type === 'voice_peer_left') {
    const peer = state.voice.peers.get(Number(data.userId));
    if (peer) {
      try { peer.pc.close(); } catch {}
      state.voice.peers.delete(Number(data.userId));
      updateVoiceStatus();
    }
    return;
  }

  if (msg.type === 'voice_peer_joined') {
    const targetUserId = Number(data.userId);
    if (!targetUserId || targetUserId === state.me?.id) return;
    if (Number(state.me?.id) < targetUserId) {
      const peer = peerConnectionFor(targetUserId);
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      state.ws?.send(JSON.stringify({ type: 'voice_offer', targetUserId, sdp: offer }));
    }
    return;
  }

  const fromUserId = Number(data.fromUserId);
  if (!fromUserId) return;
  const peer = peerConnectionFor(fromUserId);

  if (msg.type === 'voice_offer' && data.sdp) {
    await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    state.ws?.send(JSON.stringify({ type: 'voice_answer', targetUserId: fromUserId, sdp: answer }));
    return;
  }

  if (msg.type === 'voice_answer' && data.sdp) {
    await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    return;
  }

  if (msg.type === 'voice_ice' && data.candidate) {
    try { await peer.pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {}
  }
}

function canInlineChannelAdmin() {
  return state.me?.username === 'mcassyblasty' && state.adminMode;
}

async function createChannelFromSidebar(kind) {
  if (!canInlineChannelAdmin()) return;
  const raw = prompt(`New ${kind} channel name:`);
  const name = String(raw || '').trim();
  if (!name) return;
  try {
    await api('/api/admin/channels', 'POST', { name, kind });
    await refreshChannels();
  } catch (err) {
    alert(`Channel add failed: ${humanError(err)}`);
  }
}

function closeAnyChannelMenus(root = document) {
  for (const menu of root.querySelectorAll('.channelActionsMenu')) menu.remove();
}

function renderChannelActionMenu(anchorBtn, channel, onDone) {
  closeAnyChannelMenus();
  const menu = document.createElement('div');
  menu.className = 'menuCard channelActionsMenu';
  menu.style.right = '2rem';
  menu.style.top = 'calc(100% - .2rem)';
  const rename = document.createElement('button');
  rename.textContent = 'Rename';
  rename.onclick = async () => {
    const next = prompt('Rename channel', channel.name || '');
    const name = String(next || '').trim();
    if (!name) return;
    await api(`/api/admin/channels/${channel.id}`, 'PATCH', { name });
    closeAnyChannelMenus();
    await onDone();
  };
  const toggle = document.createElement('button');
  toggle.textContent = channel.archived ? 'Enable' : 'Hide';
  toggle.onclick = async () => {
    await api(`/api/admin/channels/${channel.id}`, 'PATCH', { archived: !channel.archived });
    closeAnyChannelMenus();
    await onDone();
  };
  const archive = document.createElement('button');
  archive.textContent = 'Archive';
  archive.onclick = async () => {
    if (!confirm(`Archive ${channel.kind} channel ${channel.name}?`)) return;
    await api(`/api/admin/channels/${channel.id}`, 'DELETE');
    closeAnyChannelMenus();
    await onDone();
  };
  menu.append(rename, toggle, archive);
  anchorBtn.parentElement.appendChild(menu);
}

async function persistChannelOrder(kind, container) {
  const rows = [...container.querySelectorAll('.chanRow')];
  for (let i = 0; i < rows.length; i += 1) {
    const id = Number(rows[i].dataset.channelId || 0);
    if (!id) continue;
    await api(`/api/admin/channels/${id}`, 'PATCH', { position: i + 1 });
  }
  await refreshChannels();
}

function renderNavLists(){
  const canAdmin = canInlineChannelAdmin();
  $('addTextChannelBtn')?.classList.toggle('hidden', !canAdmin);
  $('addVoiceChannelBtn')?.classList.toggle('hidden', !canAdmin);

  const cl = $('channelList'); cl.textContent='';
  const textChannels = state.channels.filter((x) => x.kind !== 'voice');
  for (const c of textChannels){
    const row = document.createElement('div');
    row.className = 'chanRow';
    row.dataset.channelId = String(c.id);
    row.draggable = canAdmin;

    const b = document.createElement('button');
    b.className = `channel ${state.mode==='channel' && state.activeChannelId===c.id ? 'active':''}`;
    b.textContent = `# ${c.name}`;
    b.onclick = async()=>{
      state.mode='channel';
      setReplyTarget(null);
      switchSidebarView('server');
      state.activeChannelId = c.id;
      state.activeDmPeerId = null;
      text($('chatHeader'), `# ${c.name}`);
      setComposerEnabled(true);
      renderNavLists();
      await loadMessages();
      closeSidebarOnMobile();
    };
    row.appendChild(b);

    if (canAdmin) {
      const menuBtn = document.createElement('button');
      menuBtn.className = 'ghost chanMenuBtn';
      menuBtn.textContent = '⋯';
      menuBtn.title = 'Channel actions';
      menuBtn.onclick = async (e) => {
        e.stopPropagation();
        try {
          await renderChannelActionMenu(menuBtn, c, async () => { await refreshChannels(); renderNavLists(); });
        } catch (err) {
          alert(`Channel action failed: ${humanError(err)}`);
        }
      };
      row.appendChild(menuBtn);

      row.addEventListener('dragstart', (e) => {
        row.classList.add('dragging');
        e.dataTransfer.setData('text/plain', String(c.id));
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('dropTarget'); });
      row.addEventListener('dragleave', () => row.classList.remove('dropTarget'));
      row.addEventListener('drop', async (e) => {
        e.preventDefault();
        row.classList.remove('dropTarget');
        const draggedId = Number(e.dataTransfer.getData('text/plain') || 0);
        if (!draggedId || draggedId === c.id) return;
        const draggedRow = cl.querySelector(`.chanRow[data-channel-id="${draggedId}"]`);
        if (!draggedRow) return;
        cl.insertBefore(draggedRow, row);
        try { await persistChannelOrder('text', cl); } catch (err) { alert(`Reorder failed: ${humanError(err)}`); }
      });
    }

    cl.appendChild(row);
  }

  const vl = $('voiceList'); vl.textContent='';
  const voiceChannels = state.channels.filter((x) => x.kind === 'voice');
  $('voiceHeader')?.classList.toggle('hidden', voiceChannels.length === 0);
  $('voiceSpacer')?.classList.toggle('hidden', voiceChannels.length === 0);
  for (const c of voiceChannels) {
    const row = document.createElement('div');
    row.className = 'chanRow';
    row.dataset.channelId = String(c.id);
    row.draggable = canAdmin;

    const b = document.createElement('button');
    const activeVoice = state.voice.room === c.name;
    b.className = `channel ${activeVoice ? 'active' : ''}`;
    b.textContent = `${activeVoice ? '🔊 Leave' : '🔈 Join'} ${c.name}`;
    b.title = activeVoice ? `Leave ${c.name}` : `Join ${c.name}`;
    b.onclick = ()=> joinVoiceRoom(c.name);
    row.appendChild(b);

    if (canAdmin) {
      const menuBtn = document.createElement('button');
      menuBtn.className = 'ghost chanMenuBtn';
      menuBtn.textContent = '⋯';
      menuBtn.title = 'Channel actions';
      menuBtn.onclick = async (e) => {
        e.stopPropagation();
        try {
          await renderChannelActionMenu(menuBtn, c, async () => { await refreshChannels(); renderNavLists(); });
        } catch (err) {
          alert(`Channel action failed: ${humanError(err)}`);
        }
      };
      row.appendChild(menuBtn);

      row.addEventListener('dragstart', (e) => {
        row.classList.add('dragging');
        e.dataTransfer.setData('text/plain', String(c.id));
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('dropTarget'); });
      row.addEventListener('dragleave', () => row.classList.remove('dropTarget'));
      row.addEventListener('drop', async (e) => {
        e.preventDefault();
        row.classList.remove('dropTarget');
        const draggedId = Number(e.dataTransfer.getData('text/plain') || 0);
        if (!draggedId || draggedId === c.id) return;
        const draggedRow = vl.querySelector(`.chanRow[data-channel-id="${draggedId}"]`);
        if (!draggedRow) return;
        vl.insertBefore(draggedRow, row);
        try { await persistChannelOrder('voice', vl); } catch (err) { alert(`Reorder failed: ${humanError(err)}`); }
      });
    }

    vl.appendChild(row);
  }

  const dl = $('dmList'); dl.textContent='';
  const dmSearch = normalizeMentionKey(state.dmSearchQuery);
  const dmUsers = state.users.filter((u) => {
    if (!dmSearch) return true;
    return normalizeMentionKey(u.username).includes(dmSearch) || normalizeMentionKey(u.display_name).includes(dmSearch);
  });
  for (const u of dmUsers){
    const b = document.createElement('button');
    b.className = `channel ${state.mode==='dm' && state.activeDmPeerId===u.id ? 'active':''}`;
    b.textContent = `${u.display_name} (@${u.username})`;
    b.style.opacity='0.96';
    if (/^#[0-9A-F]{6}$/i.test(String(u.display_color || ''))) b.style.color = String(u.display_color).toUpperCase();
    b.onclick = async()=>{
      state.mode='dm';
      setReplyTarget(null);
      switchSidebarView('dms');
      state.activeDmPeerId = u.id;
      state.activeChannelId = null;
      text($('chatHeader'), `DM: ${u.display_name}`);
      setComposerEnabled(true);
      renderNavLists();
      await loadMessages();
      closeSidebarOnMobile();
    };
    dl.appendChild(b);
  }
}


async function afterAuth(){
  state.me = await api('/api/me');
  text($('meLabel'), `@${state.me.username}`);
  $('accountDisplayName').value = state.me.display_name || '';
  const color = normalizeHex(state.me.display_color, '#FFFFFF');
  $('accountDisplayColor').value = color;
  $('accountDisplayColorHex').value = color;
  state.channels = await api('/api/channels');
  state.users = await api('/api/dms');
  state.dmSearchQuery = '';
  state.notifications = [];
  state.unreadNotifications = 0;
  renderNotifications();
  if ($('dmSearchInput')) $('dmSearchInput').value = '';

  state.mode = 'channel';
  state.sidebarView = 'server';
  state.activeChannelId = state.channels.find((c) => c.kind !== 'voice')?.id || null;
  state.activeDmPeerId = null;
  text($('chatHeader'), `# ${(state.channels.find((c) => c.id === state.activeChannelId) || {}).name || 'general'}`);
  setComposerEnabled(true);

  showApp();
  switchSidebarView('server');
  renderNavLists();
  await loadMessages();
  connectWs();
  await refreshAdmin();
}

async function refreshDms(){
  const prev = state.activeDmPeerId;
  state.users = await api('/api/dms');
  if (state.mode === 'dm' && state.users.length && !state.users.some((u)=>u.id===prev)) {
    state.activeDmPeerId = state.users[0].id;
  }
  renderNavLists();
}

async function refreshChannels(){
  const prev = state.activeChannelId;
  state.channels = await api('/api/channels');
  if (!state.channels.some((c)=>c.id===prev && c.kind !== 'voice')) {
    state.activeChannelId = state.channels.find((c)=>c.kind !== 'voice')?.id || null;
  }
  renderNavLists();
  if (state.me?.username === 'mcassyblasty') refreshAdmin().catch(() => {});
}

function renderChannelAdmin(){
  const list = $('channelAdminList');
  if (!list) return;
  list.textContent = '';
  for (const c of (state.allChannels.length ? state.allChannels : state.channels)) {
    const row = document.createElement('div');
    row.className = 'row';
    const nameInput = document.createElement('input');
    nameInput.value = c.name;
    nameInput.style.minWidth = '160px';
    const save = document.createElement('button');
    save.textContent = 'Rename';
    save.onclick = async()=>{
      await api(`/api/admin/channels/${c.id}`, 'PATCH', { name: nameInput.value.trim() });
      await refreshChannels();
      renderChannelAdmin();
    };
    const up = document.createElement('button');
    up.textContent = '↑';
    up.onclick = async()=>{
      await api(`/api/admin/channels/${c.id}`, 'PATCH', { position: Math.max(1, Number(c.position) - 1) });
      await refreshChannels();
      renderChannelAdmin();
    };
    const down = document.createElement('button');
    down.textContent = '↓';
    down.onclick = async()=>{
      await api(`/api/admin/channels/${c.id}`, 'PATCH', { position: Number(c.position) + 1 });
      await refreshChannels();
      renderChannelAdmin();
    };
    const del = document.createElement('button');
    del.textContent = 'Archive';
    del.onclick = async()=>{
      if (!confirm(`Archive ${c.kind} channel ${c.name}?`)) return;
      await api(`/api/admin/channels/${c.id}`, 'DELETE');
      await refreshChannels();
      await refreshAdmin();
      renderChannelAdmin();
    };
    const hide = document.createElement('button');
    hide.textContent = c.archived ? 'Unhide' : 'Hide';
    hide.onclick = async()=>{
      await api(`/api/admin/channels/${c.id}`, 'PATCH', { archived: !c.archived });
      await refreshChannels();
      await refreshAdmin();
      renderChannelAdmin();
    };
    const label = document.createElement('span');
    label.textContent = `[${c.kind}] #${c.id}`;
    row.append(label, nameInput, save, up, down, hide, del);
    list.appendChild(row);
  }
}

async function boot(){
  for (const id of ['loginBtn','regBtn','redeemBtn','resetBtn']) {
    const b = $(id); if (b) b.dataset.label = b.textContent;
  }

  applyTheme(localStorage.getItem('grishcord_theme') || 'oled');
  await loadVersion();

  $('drawerBtn').onclick = ()=>document.body.classList.toggle('showSidebar');
  $('notifBtn').onclick = ()=> {
    const menu = $('notifMenu');
    const willOpen = menu.classList.contains('hidden');
    menu.classList.toggle('hidden');
    $('settingsMenu').classList.add('hidden');
    if (willOpen) {
      state.unreadNotifications = 0;
      renderNotifications();
    }
  };
  $('settingsBtn').onclick = ()=> {
    $('settingsMenu').classList.toggle('hidden');
    $('notifMenu').classList.add('hidden');
  };
  document.addEventListener('click', (e)=>{
    if (!$('settingsMenuWrap').contains(e.target)) $('settingsMenu').classList.add('hidden');
    if (!$('notifMenuWrap').contains(e.target)) $('notifMenu').classList.add('hidden');
    closeSidebarIfMobileOutsideClick(e);
    if (!e.target.closest('.chanMenuBtn') && !e.target.closest('.channelActionsMenu')) closeAnyChannelMenus();
  });

  window.addEventListener('resize', () => {
    if ($('msgInput').disabled) return;
    $('msgInput').placeholder = defaultComposerPlaceholder();
  });

  $('accountDisplayColor').addEventListener('input', ()=> {
    $('accountDisplayColorHex').value = normalizeHex($('accountDisplayColor').value);
  });
  $('accountDisplayColorHex').addEventListener('input', ()=> {
    const v = normalizeHex($('accountDisplayColorHex').value, $('accountDisplayColor').value || '#FFFFFF');
    $('accountDisplayColor').value = v;
  });

  $('saveAccountBtn').onclick = async()=>{
    try {
      const updated = await api('/api/me/profile', 'PATCH', {
        displayName: $('accountDisplayName').value.trim(),
        displayColor: normalizeHex($('accountDisplayColorHex').value, $('accountDisplayColor').value)
      });
      state.me = updated;
      text($('meLabel'), `@${state.me.username}`);
      $('accountDisplayName').value = updated.display_name || '';
      const color = normalizeHex(updated.display_color || '#FFFFFF');
      $('accountDisplayColor').value = color;
      $('accountDisplayColorHex').value = color;
      await loadMessages();
      setNotice('Account settings updated.', 'ok');
    } catch (err) {
      alert(`Account update failed: ${humanError(err)}`);
    }
  };

  $('attachBtn').ondblclick = ()=> $('attachFile').click();
  $('attachBtn').onclick = ()=> $('attachFile').click();
  $('attachFile').onchange = ()=> {
    const file = $('attachFile').files?.[0];
    if (!file) return;
    if (!String(file.type || '').startsWith('image/')) {
      alert('Please choose an image file.');
      return;
    }
    setPendingImage(file);
  };
  $('msgInput').addEventListener('paste', (e) => {
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) {
          setPendingImage(f);
          e.preventDefault();
          break;
        }
      }
    }
  });

  if ($('dmSearchInput')) $('dmSearchInput').addEventListener('input', () => {
    state.dmSearchQuery = $('dmSearchInput').value || '';
    renderNavLists();
  });

  $('msgInput').addEventListener('input', updateMentionHint);
  $('msgInput').addEventListener('click', updateMentionHint);

  $('imageLightbox').onclick = (e)=> { if (e.target === $('imageLightbox')) closeLightbox(); };

  $('themeBtn').onclick = ()=>{
    const next = document.body.classList.contains('discord') ? 'oled' : 'discord';
    localStorage.setItem('grishcord_theme', next);
    applyTheme(next);
  };

  $('openAdminBtn').onclick = async()=>{ await refreshAdmin(); $('adminOverlay').classList.remove('hidden'); };
  $('closeAdminBtn').onclick = ()=> $('adminOverlay').classList.add('hidden');
  $('adminOverlay').onclick = (e)=> { if (e.target === $('adminOverlay')) $('adminOverlay').classList.add('hidden'); };

  $('logoutBtn').onclick = async()=>{
    try { await api('/api/logout','POST',{}); } catch {}
    await leaveVoiceRoom();
    state.me = null;
    setReplyTarget(null);
    state.adminMode = false;
    state.notifications = [];
    state.unreadNotifications = 0;
    renderNotifications();
    text($('meLabel'), 'Not logged in');
    $('adminOverlay').classList.add('hidden');
    showAuth('Logged out.', 'ok');
  };

  $('serverViewBtn').onclick = async()=>{
    switchSidebarView('server');
    setReplyTarget(null);
    if (!state.activeChannelId && state.channels.length) state.activeChannelId = state.channels.find((c) => c.kind !== 'voice')?.id || null;
    state.mode = 'channel';
    const active = state.channels.find((c) => c.id === state.activeChannelId && c.kind !== 'voice') || state.channels.find((c) => c.kind !== 'voice');
    if (active) {
      state.activeChannelId = active.id;
      text($('chatHeader'), `# ${active.name}`);
      setComposerEnabled(true);
      renderNavLists();
      await loadMessages();
      closeSidebarOnMobile();
    }
  };

  $('dmViewBtn').onclick = async()=>{
    switchSidebarView('dms');
    setReplyTarget(null);
    state.mode = 'dm';
    if (!state.activeDmPeerId && state.users.length) state.activeDmPeerId = state.users[0].id;
    const active = state.users.find((u) => u.id === state.activeDmPeerId) || state.users[0];
    if (active) {
      state.activeDmPeerId = active.id;
      text($('chatHeader'), `DM: ${active.display_name}`);
      setComposerEnabled(true);
      renderNavLists();
      await loadMessages();
      closeSidebarOnMobile();
    }
  };

  $('adminModeToggle').onchange = ()=> {
    state.adminMode = $('adminModeToggle').checked;
    renderNavLists();
    loadMessages().catch(()=>{});
  };

  $('addTextChannelBtn').onclick = ()=> createChannelFromSidebar('text');
  $('addVoiceChannelBtn').onclick = ()=> createChannelFromSidebar('voice');

  $('authActionSelect').onchange = ()=> {
    const v = $('authActionSelect').value;
    $('registerPanel').classList.toggle('hidden', v !== 'register');
    $('recoveryPanel').classList.toggle('hidden', v !== 'recovery');
  };

  $('loginForm').onsubmit = async (e)=>{
    e.preventDefault();
    const btn = $('loginBtn');
    setBusy(btn, true);
    clearNotice();
    try {
      await api('/api/login','POST',{username:$('loginUser').value.trim(),password:$('loginPass').value});
      await afterAuth();
    } catch(err){
      setNotice(`Login failed: ${humanError(err)}`, 'error');
    } finally { setBusy(btn, false); }
  };

  $('registerForm').onsubmit = async (e)=>{
    e.preventDefault();
    const btn = $('regBtn');
    setBusy(btn, true);
    try {
      await api('/api/register','POST',{inviteToken:$('regInvite').value.trim(),username:$('regUser').value.trim(),displayName:$('regDisplay').value.trim(),password:$('regPass').value});
      setNotice('Registered. Log in now.', 'ok');
      $('registerPanel').classList.add('hidden');
      $('authActionSelect').value = 'none';
    } catch(err){
      setNotice(`Register failed: ${humanError(err)}`, 'error');
    } finally { setBusy(btn, false); }
  };

  $('redeemForm').onsubmit = async (e)=>{
    e.preventDefault();
    const btn = $('redeemBtn');
    setBusy(btn, true);
    try {
      const r = await api('/api/recovery/redeem','POST',{token:$('recoverToken').value.trim()});
      state.redeemId = r.redeemId;
      setNotice('Token redeemed. Set new password below.', 'ok');
    } catch(err){
      setNotice(`Redeem failed: ${humanError(err)}`, 'error');
    } finally { setBusy(btn, false); }
  };

  $('resetForm').onsubmit = async (e)=>{
    e.preventDefault();
    const btn = $('resetBtn');
    setBusy(btn, true);
    try {
      await api('/api/recovery/reset','POST',{redeemId:state.redeemId,password:$('newPass').value});
      setNotice('Password reset complete.', 'ok');
      $('recoveryPanel').classList.add('hidden');
      $('authActionSelect').value = 'none';
    } catch(err){
      setNotice(`Reset failed: ${humanError(err)}`, 'error');
    } finally { setBusy(btn, false); }
  };

  $('composerForm').onsubmit = async(e)=>{
    e.preventDefault();
    const rawBody = $('msgInput').value;
    if(!rawBody.trim() && !state.pendingImageFile) return;
    try {
      const replyToId = state.replyTo?.id || null;
      const uploadIds = [];
      if (state.pendingImageFile) {
        const up = await uploadImageFile(state.pendingImageFile);
        if (up.uploadId) uploadIds.push(up.uploadId);
      }
      await api('/api/messages','POST',{body: rawBody,replyToId,uploadIds,channelId: state.mode==='channel' ? state.activeChannelId : null, dmPeerId: state.mode==='dm' ? state.activeDmPeerId : null});
      $('msgInput').value='';
      updateMentionHint();
      setReplyTarget(null);
      clearPendingImage();
      if (state.mode === 'dm') await refreshDms();
    } catch(err){
      alert(`Send failed: ${humanError(err)}`);
    }
  };

  $('msgInput').addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      if (applyMentionAutocomplete()) {
        e.preventDefault();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('composerForm').requestSubmit();
    }
  });

  $('createInviteBtn').onclick = async()=>{
    try {
      const r = await api('/api/admin/invites','POST',{});
      const key = r.inviteKey || '';
      const url = r.inviteUrl || '';
      text($('inviteOut'), key ? `Invite key: ${key}${url ? `\nURL: ${url}` : ''}` : 'Invite generation returned no key.');
      await refreshAdmin();
    } catch(err){ alert(`Invite generation failed: ${humanError(err)}`); }
  };

  $('genRecoveryBtn').onclick = async()=>{
    try {
      const r = await api('/api/admin/recovery','POST',{username:$('recoveryUser').value.trim()});
      const key = r.recoveryKey || '';
      const url = r.recoveryUrl || '';
      text($('recoveryOut'), key ? `Recovery key: ${key}${url ? `\nURL: ${url}` : ''}` : 'Recovery generation returned no key.');
    } catch(err){ alert(`Recovery generation failed: ${humanError(err)}`); }
  };

  $('spamLevel').onchange = ()=> setSpamEffective(Number($('spamLevel').value));
  $('saveSettingsBtn').onclick = async()=>{
    try {
      const r = await api('/api/admin/settings','POST',{antiSpamLevel:Number($('spamLevel').value),voiceBitrate:Number($('voiceBitrate').value)});
      setSpamEffective(Number(r.antiSpamLevel));
    } catch(err){ alert(`Settings save failed: ${humanError(err)}`); }
  };

  $('addChannelBtn').onclick = async()=>{
    try {
      const name = $('newChannelName').value.trim();
      const kind = $('newChannelKind').value;
      await api('/api/admin/channels', 'POST', { name, kind });
      $('newChannelName').value = '';
      await refreshChannels();
      renderChannelAdmin();
    } catch (err) { alert(`Channel add failed: ${humanError(err)}`); }
  };

  try { await afterAuth(); }
  catch { showAuth('Please log in.', 'ok'); }

  setInterval(() => {
    if (!state.me) return;
    refreshDms().catch(() => {});
  }, 3000);
}

boot();
