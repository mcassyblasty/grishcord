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
  adminMode: false
};

const spamMap = {1:{burst:3,sustained:10,cooldown:120},3:{burst:5,sustained:15,cooldown:60},5:{burst:8,sustained:25,cooldown:30},7:{burst:12,sustained:40,cooldown:15},10:{burst:20,sustained:80,cooldown:5}};

function text(el, v){ el.textContent = v; }
function clearNotice(){ const n=$('authMsg'); n.classList.remove('error','ok'); n.classList.add('hidden'); text(n,''); }
function setNotice(msg, kind='error'){ const n=$('authMsg'); n.classList.remove('hidden','error','ok'); if(kind) n.classList.add(kind); text(n,msg); }
function showAuth(msg='', kind=''){ $('authView').classList.remove('hidden'); $('appView').classList.add('hidden'); $('settingsMenuWrap').classList.add('hidden'); if(msg) setNotice(msg,kind); else clearNotice(); }
function showApp(){ $('authView').classList.add('hidden'); $('appView').classList.remove('hidden'); $('settingsMenuWrap').classList.remove('hidden'); clearNotice(); }
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
  return msg;
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
  const body = document.createElement('div');
  body.style.whiteSpace = 'pre-wrap';
  body.style.wordBreak = 'break-word';
  const full = m.body || '';
  const short = full.length > 2000 ? full.slice(0,2000) : full;
  body.textContent = short;
  wrap.append(meta, body);
  if (full.length > 2000){
    const b = document.createElement('button'); b.textContent='Read more';
    b.onclick = () => { body.textContent = full.slice(0,10000); b.remove(); };
    wrap.appendChild(b);
  }
  if (state.me?.username === 'mcassyblasty' && state.adminMode) {
    const del = document.createElement('button');
    del.className = 'ghost';
    del.textContent = 'Delete';
    del.onclick = async () => {
      if (!confirm('Delete this message?')) return;
      try {
        await api(`/api/messages/${m.id}`, 'DELETE');
        wrap.remove();
      } catch (err) {
        alert(`Delete failed: ${humanError(err)}`);
      }
    };
    wrap.appendChild(del);
  }
  $('msgs').appendChild(wrap);
}

function isCurrentTarget(m){
  if (state.mode === 'channel') return Number(m.channel_id) === Number(state.activeChannelId);
  if (state.mode === 'dm') {
    return Number(m.dm_peer_id) === Number(state.activeDmPeerId) || Number(m.author_id) === Number(state.activeDmPeerId);
  }
  return false;
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

function setComposerEnabled(enabled, placeholder = 'Plain-text message (Enter to send, Shift+Enter for new line)') {
  $('msgInput').disabled = !enabled;
  $('sendBtn').disabled = !enabled;
  $('msgInput').placeholder = placeholder;
}

async function refreshAdmin(){
  if (!state.me || state.me.username !== 'mcassyblasty') {
    $('openAdminBtn').classList.add('hidden');
    return;
  }
  $('openAdminBtn').classList.remove('hidden');
  $('adminModeToggle').checked = state.adminMode;
  const s = await api('/api/admin/state');
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
  if (!state.voice.room) return;
  try { state.ws?.send(JSON.stringify({ type: 'voice_leave' })); } catch {}
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
  await leaveVoiceRoom();
  showVoicePlaceholder(room);
  try {
    state.voice.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
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
    leave.onclick = leaveVoiceRoom;
    btnRow.append(mute, leave);
    $('msgs').appendChild(btnRow);
    updateVoiceStatus('Connected');
  } catch (err) {
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

function renderNavLists(){
  const cl = $('channelList'); cl.textContent='';
  for (const c of state.channels.filter((x) => x.kind !== 'voice')){
    const b = document.createElement('button');
    b.className = `channel ${state.mode==='channel' && state.activeChannelId===c.id ? 'active':''}`;
    b.textContent = `# ${c.name}`;
    b.onclick = async()=>{
      state.mode='channel';
      switchSidebarView('server');
      state.activeChannelId = c.id;
      state.activeDmPeerId = null;
      text($('chatHeader'), `# ${c.name}`);
      setComposerEnabled(true);
      renderNavLists();
      await loadMessages();
    };
    cl.appendChild(b);
  }

  const vl = $('voiceList'); vl.textContent='';
  for (const c of state.channels.filter((x) => x.kind === 'voice')) {
    const b = document.createElement('button');
    b.className = 'channel';
    b.textContent = `🔈 ${c.name}`;
    b.onclick = ()=> joinVoiceRoom(c.name);
    vl.appendChild(b);
  }

  const dl = $('dmList'); dl.textContent='';
  for (const u of state.users){
    const b = document.createElement('button');
    b.className = `channel ${state.mode==='dm' && state.activeDmPeerId===u.id ? 'active':''}`;
    b.textContent = `${u.display_name} (@${u.username})`;
    b.style.opacity='0.96';
    b.onclick = async()=>{
      state.mode='dm';
      switchSidebarView('dms');
      state.activeDmPeerId = u.id;
      state.activeChannelId = null;
      text($('chatHeader'), `DM: ${u.display_name}`);
      setComposerEnabled(true);
      renderNavLists();
      await loadMessages();
    };
    dl.appendChild(b);
  }
}

async function afterAuth(){
  state.me = await api('/api/me');
  text($('meLabel'), `@${state.me.username}`);
  state.channels = await api('/api/channels');
  state.users = await api('/api/dms');

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
}

function renderChannelAdmin(){
  const list = $('channelAdminList');
  if (!list) return;
  list.textContent = '';
  for (const c of state.channels) {
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
      renderChannelAdmin();
    };
    const label = document.createElement('span');
    label.textContent = `[${c.kind}] #${c.id}`;
    row.append(label, nameInput, save, up, down, del);
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
  $('settingsBtn').onclick = ()=> $('settingsMenu').classList.toggle('hidden');
  document.addEventListener('click', (e)=>{ if (!$('settingsMenuWrap').contains(e.target)) $('settingsMenu').classList.add('hidden'); });

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
    state.adminMode = false;
    text($('meLabel'), 'Not logged in');
    $('adminOverlay').classList.add('hidden');
    showAuth('Logged out.', 'ok');
  };

  $('serverViewBtn').onclick = async()=>{
    switchSidebarView('server');
    if (!state.activeChannelId && state.channels.length) state.activeChannelId = state.channels.find((c) => c.kind !== 'voice')?.id || null;
    state.mode = 'channel';
    const active = state.channels.find((c) => c.id === state.activeChannelId && c.kind !== 'voice') || state.channels.find((c) => c.kind !== 'voice');
    if (active) {
      state.activeChannelId = active.id;
      text($('chatHeader'), `# ${active.name}`);
      setComposerEnabled(true);
      renderNavLists();
      await loadMessages();
    }
  };

  $('dmViewBtn').onclick = async()=>{
    switchSidebarView('dms');
    state.mode = 'dm';
    if (!state.activeDmPeerId && state.users.length) state.activeDmPeerId = state.users[0].id;
    const active = state.users.find((u) => u.id === state.activeDmPeerId) || state.users[0];
    if (active) {
      state.activeDmPeerId = active.id;
      text($('chatHeader'), `DM: ${active.display_name}`);
      setComposerEnabled(true);
      renderNavLists();
      await loadMessages();
    }
  };

  $('adminModeToggle').onchange = ()=> {
    state.adminMode = $('adminModeToggle').checked;
    renderNavLists();
    loadMessages().catch(()=>{});
  };

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
    if(!rawBody.trim()) return;
    try {
      await api('/api/messages','POST',{body: rawBody,channelId: state.mode==='channel' ? state.activeChannelId : null, dmPeerId: state.mode==='dm' ? state.activeDmPeerId : null});
      $('msgInput').value='';
      if (state.mode === 'dm') await refreshDms();
    } catch(err){
      alert(`Send failed: ${humanError(err)}`);
    }
  };

  $('msgInput').addEventListener('keydown', (e) => {
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
