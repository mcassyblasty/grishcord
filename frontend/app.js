const $ = (id) => document.getElementById(id);
const state = {
  me: null,
  lastId: 0,
  redeemId: null,
  ws: null,
  channels: [],
  users: [],
  mode: 'channel',
  activeChannelId: null,
  activeDmPeerId: null
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
  const meta = document.createElement('div'); meta.className='meta';
  meta.textContent = `${m.display_name || m.username || 'user'} · ${fmtTs(m.created_at)}`;
  const body = document.createElement('div');
  const full = m.body || '';
  const short = full.length > 2000 ? full.slice(0,2000) : full;
  body.textContent = short;
  wrap.append(meta, body);
  if (full.length > 2000){
    const b = document.createElement('button'); b.textContent='Read more';
    b.onclick = () => { body.textContent = full.slice(0,10000); b.remove(); };
    wrap.appendChild(b);
  }
  $('msgs').appendChild(wrap);
}

function isCurrentTarget(m){
  if (state.mode === 'channel') return Number(m.channel_id) === Number(state.activeChannelId);
  return Number(m.dm_peer_id) === Number(state.activeDmPeerId);
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

async function refreshAdmin(){
  if (!state.me || state.me.username !== 'mcassyblasty') {
    $('openAdminBtn').classList.add('hidden');
    return;
  }
  $('openAdminBtn').classList.remove('hidden');
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
      const btn = document.createElement('button'); btn.textContent = u.disabled ? 'Unfreeze' : 'Freeze';
      btn.onclick = async()=>{ await api(`/api/admin/users/${u.id}/disable`,'POST',{disabled: !u.disabled}); await refreshAdmin(); };
      row.appendChild(btn);
    }
    userList.appendChild(row);
  }
}

function renderNavLists(){
  const cl = $('channelList'); cl.textContent='';
  for (const c of state.channels){
    const b = document.createElement('button');
    b.className = `channel ${state.mode==='channel' && state.activeChannelId===c.id ? 'active':''}`;
    b.textContent = `# ${c.name}`;
    b.onclick = async()=>{
      state.mode='channel';
      state.activeChannelId = c.id;
      state.activeDmPeerId = null;
      text($('chatHeader'), `# ${c.name}`);
      renderNavLists();
      await loadMessages();
    };
    cl.appendChild(b);
  }

  const dl = $('dmList'); dl.textContent='';
  for (const u of state.users){
    const b = document.createElement('button');
    b.className = `channel ${state.mode==='dm' && state.activeDmPeerId===u.id ? 'active':''}`;
    b.textContent = `${u.display_name} (@${u.username})`;
    b.style.opacity='0.96';
    b.onclick = async()=>{
      state.mode='dm';
      state.activeDmPeerId = u.id;
      state.activeChannelId = null;
      text($('chatHeader'), `DM: ${u.display_name}`);
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
  state.users = await api('/api/users');

  state.mode = 'channel';
  state.activeChannelId = state.channels[0]?.id || null;
  state.activeDmPeerId = null;
  text($('chatHeader'), `# ${state.channels[0]?.name || 'general'}`);

  showApp();
  renderNavLists();
  await loadMessages();
  connectWs();
  await refreshAdmin();
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
    state.me = null;
    text($('meLabel'), 'Not logged in');
    $('adminOverlay').classList.add('hidden');
    showAuth('Logged out.', 'ok');
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
    const body = $('msgInput').value.trim();
    if(!body) return;
    try {
      await api('/api/messages','POST',{body,channelId: state.mode==='channel' ? state.activeChannelId : null, dmPeerId: state.mode==='dm' ? state.activeDmPeerId : null});
      $('msgInput').value='';
    } catch(err){
      alert(`Send failed: ${humanError(err)}`);
    }
  };

  $('createInviteBtn').onclick = async()=>{
    try {
      const ttl = Number($('ttlDays').value || 7);
      const r = await api('/api/admin/invites','POST',{ttlDays:ttl});
      text($('inviteOut'), r.inviteUrl || '');
      await refreshAdmin();
    } catch(err){ alert(`Invite generation failed: ${humanError(err)}`); }
  };

  $('genRecoveryBtn').onclick = async()=>{
    try {
      const r = await api('/api/admin/recovery','POST',{username:$('recoveryUser').value.trim()});
      text($('recoveryOut'), r.recoveryUrl || '');
    } catch(err){ alert(`Recovery generation failed: ${humanError(err)}`); }
  };

  $('spamLevel').onchange = ()=> setSpamEffective(Number($('spamLevel').value));
  $('saveSettingsBtn').onclick = async()=>{
    try {
      const r = await api('/api/admin/settings','POST',{antiSpamLevel:Number($('spamLevel').value),voiceBitrate:Number($('voiceBitrate').value)});
      setSpamEffective(Number(r.antiSpamLevel));
    } catch(err){ alert(`Settings save failed: ${humanError(err)}`); }
  };

  try { await afterAuth(); }
  catch { showAuth('Please log in.', 'ok'); }
}

boot();
