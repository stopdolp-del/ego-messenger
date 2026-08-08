// ── EGO MESSENGER CLIENT SCRIPT ─────────────────────────────────────────────

const socket = io();
let me = null, isReg = false;
let target = { type: null, id: null, serverId: null, name: '', data: null };
let replyMsg = null, editMsg = null, ctxMsg = null;

// WebRTC
let pc = null, localStream = null, callTarget = null, incomingCall = null;
let callMuted = false, callCamOff = false;
const rtcCfg = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };

// Media Recorders
let vnRec = null, vnStream = null, vnChunks = [], vnTimer = null, vnSec = 0;
let vrRec = null, vrStream = null, vrChunks = [], vrTimer = null, vrSec = 0;

// IndexedDB for media caching
let idb = null;
function initIDB() {
  const r = indexedDB.open('ego_idb', 2);
  r.onupgradeneeded = e => {
    const db = e.target.result;
    if (!db.objectStoreNames.contains('vnotes')) db.createObjectStore('vnotes', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('voices')) db.createObjectStore('voices', { keyPath: 'id' });
  };
  r.onsuccess = e => { idb = e.target.result; };
}
function idbSave(store, id, data) {
  if (!idb) return;
  const tx = idb.transaction(store, 'readwrite');
  tx.objectStore(store).put({ id, data });
}
function idbGet(store, id, cb) {
  if (!idb) return cb(null);
  const tx = idb.transaction(store, 'readonly');
  const r = tx.objectStore(store).get(id);
  r.onsuccess = () => cb(r.result?.data || null);
}

// Canvas Background Particle Animation
function initCanvas() {
  const canvas = document.getElementById('bg-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let w = canvas.width = window.innerWidth;
  let h = canvas.height = window.innerHeight;
  window.addEventListener('resize', () => {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  });

  const particles = [];
  const count = 45;
  let mouse = { x: w / 2, y: h / 2 };

  window.addEventListener('mousemove', e => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  });

  for (let i = 0; i < count; i++) {
    particles.push({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.6,
      vy: (Math.random() - 0.5) * 0.6,
      r: Math.random() * 2.5 + 1,
      color: Math.random() > 0.5 ? '#6c5ce7' : '#00cec9'
    });
  }

  function render() {
    ctx.clearRect(0, 0, w, h);
    particles.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0) p.x = w; if (p.x > w) p.x = 0;
      if (p.y < 0) p.y = h; if (p.y > h) p.y = 0;

      // React slightly to mouse
      const dx = mouse.x - p.x;
      const dy = mouse.y - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 120) {
        p.x -= dx * 0.01;
        p.y -= dy * 0.01;
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = 0.4;
      ctx.fill();
    });
    requestAnimationFrame(render);
  }
  render();
}

// ── INIT ON LOAD ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initIDB();
  initCanvas();

  const saved = localStorage.getItem('ego_me');
  if (saved) {
    me = JSON.parse(saved);
    const t = localStorage.getItem('ego_target');
    if (t) target = JSON.parse(t);
    bootApp();
  }
});

// ── AUTH ─────────────────────────────────────────────────────────────────────
function toggleReg() {
  isReg = !isReg;
  document.getElementById('a-email-g').style.display = isReg ? 'block' : 'none';
  document.getElementById('a-btn').textContent = isReg ? 'Зарегистрироваться' : 'Войти';
  document.getElementById('a-switch').innerHTML = isReg ? 'Есть аккаунт? <b>Войти</b>' : 'Нет аккаунта? <b>Зарегистрироваться</b>';
  document.getElementById('auth-tag').textContent = isReg ? 'Создайте аккаунт в ego' : 'Войдите чтобы продолжить';
  document.getElementById('auth-err').style.display = 'none';
}

function showAuthErr(msg) {
  const el = document.getElementById('auth-err');
  el.textContent = msg; el.style.display = 'block';
}

async function doAuth() {
  const username = document.getElementById('a-user').value.trim();
  const password = document.getElementById('a-pass').value.trim();
  const email = document.getElementById('a-email').value.trim();
  if (!username || !password || (isReg && !email)) { showAuthErr('Заполните все поля'); return; }

  const ep = isReg ? '/api/register' : '/api/login';
  const body = isReg ? { username, email, password } : { username, password };

  try {
    const res = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await res.json();
    if (!res.ok) { showAuthErr(d.error || 'Ошибка'); return; }
    me = d.user;
    localStorage.setItem('ego_me', JSON.stringify(me));
    bootApp();
  } catch (e) { showAuthErr('Нет соединения с сервером'); }
}

function bootApp() {
  document.getElementById('auth').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  socket.emit('user_connected', me.id);
  updateUserCard();
  loadContacts();
  loadServersRail();
  setInterval(pollStatus, 5000);

  if (target.type === 'dm' && target.id) {
    // restored via contacts
  }
}

async function pollStatus() {
  if (!me) return;
  try {
    const r = await fetch(`/api/users/me/${me.id}`);
    if (r.ok) {
      const d = await r.json();
      Object.assign(me, d);
      localStorage.setItem('ego_me', JSON.stringify(me));
      updateUserCard();
    }
  } catch (e) {}
}

function updateUserCard() {
  document.getElementById('uc-name').textContent = me.username;
  document.getElementById('uc-vbadge').innerHTML = me.is_verified ? '<span class="vbadge">✓</span>' : '';
  document.getElementById('uc-sub').textContent = `${me.status_emoji || '🟢'} ${me.status_text || 'В сети'}`;
  setAva(document.getElementById('uc-ava'), me.avatar_url, me.username);
  updateInputState();
}

function updateInputState() {
  const ok = !me.is_banned && !!target.id;
  ['msg-input', 'send-btn', 'btn-attach', 'btn-voice', 'btn-vnote'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !ok;
  });
}

function setAva(el, url, name) {
  if (url) { el.style.backgroundImage = `url('${esc(url)}')`; el.textContent = ''; }
  else { el.style.backgroundImage = 'none'; el.textContent = (name || '?').charAt(0).toUpperCase(); }
}

// ── CONTACTS & DMs ───────────────────────────────────────────────────────────
let contactsCache = [];

async function loadContacts() {
  try {
    const r = await fetch(`/api/contacts/${me.id}`);
    contactsCache = await r.json();
    renderContacts(contactsCache);
    if (target.type === 'dm' && target.id) {
      const c = contactsCache.find(x => String(x.id) === String(target.id));
      if (c) selectDM(c, true);
    }
  } catch (e) {}
}

function renderContacts(list) {
  const el = document.getElementById('contacts-list');
  if (!list.length) {
    el.innerHTML = '<div style="padding:16px;color:var(--text-muted);font-size:12px;text-align:center">Ищите пользователей сверху для добавления в контакты</div>';
    return;
  }
  el.innerHTML = '';
  list.forEach(c => {
    const div = document.createElement('div');
    div.className = `ni ${target.type === 'dm' && String(target.id) === String(c.id) ? 'act' : ''}`;
    div.dataset.cid = c.id;

    const ava = document.createElement('div');
    ava.className = 'ava' + (c._online ? ' online' : '');
    setAva(ava, c.avatar_url, c.nickname || c.username);

    const name = document.createElement('div');
    name.className = 'ni-name';
    name.innerHTML = `${esc(c.nickname || c.username)}${c.is_verified ? '<span class="vbadge">✓</span>' : ''}`;

    div.appendChild(ava);
    div.appendChild(name);
    div.onclick = () => selectDM(c);
    el.appendChild(div);
  });
}

function selectDM(contact, skipNav) {
  target = { type: 'dm', id: contact.id, name: contact.nickname || contact.username, data: contact };
  localStorage.setItem('ego_target', JSON.stringify(target));

  document.querySelectorAll('.ni').forEach(el => el.classList.remove('act'));
  const el = document.querySelector(`.ni[data-cid="${contact.id}"]`);
  if (el) el.classList.add('act');

  document.getElementById('ch-sym').textContent = '@';
  document.getElementById('ch-name').textContent = contact.nickname || contact.username;
  document.getElementById('ch-vbadge').innerHTML = contact.is_verified ? '<span class="vbadge">✓</span>' : '';
  document.getElementById('ch-sub').textContent = contact.status_text || 'В сети';

  const chAva = document.getElementById('ch-ava');
  chAva.style.display = 'flex';
  setAva(chAva, contact.avatar_url, contact.username);

  document.getElementById('btn-audio').style.display = 'flex';
  document.getElementById('btn-video').style.display = 'flex';
  document.getElementById('btn-invite').style.display = 'none';

  clearMessages();
  loadDMMessages(contact.id);
  updateInputState();
  if (!skipNav) hideSidebar();
}

async function loadDMMessages(contactId) {
  try {
    const r = await fetch(`/api/messages/dm/${me.id}/${contactId}`);
    const msgs = await r.json();
    msgs.forEach(m => appendMsg(m));
  } catch (e) {}
}

// ── SERVERS / CHANNELS ─────────────────────────────────────────────────────────
let currentServer = null;

async function loadServersRail() {
  try {
    const r = await fetch(`/api/servers/user/${me.id}`);
    const servers = await r.json();
    const rail = document.getElementById('rail-servers');
    rail.innerHTML = '';
    servers.forEach(s => {
      const div = document.createElement('div');
      div.className = `ri ${target.type === 'channel' && String(target.serverId) === String(s.id) ? 'act' : ''}`;
      div.title = s.name;
      if (s.icon_url) { div.style.backgroundImage = `url('${esc(s.icon_url)}')`; div.textContent = ''; }
      else { div.textContent = s.name.substring(0, 2).toUpperCase(); }
      div.onclick = () => selectServer(s);
      rail.appendChild(div);
    });
  } catch (e) {}
}

function goToDMs() {
  document.querySelectorAll('.ri').forEach(el => el.classList.remove('act'));
  document.getElementById('rail-dm').classList.add('act');
  document.getElementById('dm-view').style.display = 'block';
  document.getElementById('ch-view').style.display = 'none';
  document.getElementById('sb-title').innerHTML = '<span>Сообщения</span>';
  document.getElementById('btn-invite').style.display = 'none';
  currentServer = null;
}

async function selectServer(s) {
  currentServer = s;
  document.querySelectorAll('.ri').forEach(el => el.classList.remove('act'));
  document.getElementById('dm-view').style.display = 'none';
  document.getElementById('ch-view').style.display = 'block';
  document.getElementById('sb-title').innerHTML = `<span>${esc(s.name)}</span>`;
  document.getElementById('btn-invite').style.display = 'flex';
  await loadChannels(s.id);
}

async function loadChannels(sid) {
  try {
    const r = await fetch(`/api/servers/${sid}/channels`);
    const chs = await r.json();
    const list = document.getElementById('channels-list');
    list.innerHTML = '';
    chs.forEach(ch => {
      const div = document.createElement('div');
      div.className = `ni ${target.type === 'channel' && String(target.id) === String(ch.id) ? 'act' : ''}`;
      div.dataset.chid = ch.id;
      div.innerHTML = `<span style="color:var(--neon-cyan)">#</span><div class="ni-name">${esc(ch.name)}</div>`;
      div.onclick = () => selectChannel(ch);
      list.appendChild(div);
    });
    if (chs.length && !target.id) selectChannel(chs[0]);
  } catch (e) {}
}

function selectChannel(ch, skipNav) {
  target = { type: 'channel', id: ch.id, serverId: ch.server_id, name: ch.name, data: ch };
  localStorage.setItem('ego_target', JSON.stringify(target));
  document.querySelectorAll('#channels-list .ni').forEach(el => el.classList.remove('act'));
  const el = document.querySelector(`#channels-list .ni[data-chid="${ch.id}"]`);
  if (el) el.classList.add('act');

  document.getElementById('ch-sym').textContent = '#';
  document.getElementById('ch-name').textContent = ch.name;
  document.getElementById('ch-vbadge').innerHTML = '';
  document.getElementById('ch-ava').style.display = 'none';
  document.getElementById('ch-sub').textContent = ch.topic || '';
  document.getElementById('btn-audio').style.display = 'none';
  document.getElementById('btn-video').style.display = 'none';

  socket.emit('join_channel', ch.id);
  clearMessages();
  loadChannelMessages(ch.id);
  updateInputState();
  if (!skipNav) hideSidebar();
}

async function loadChannelMessages(chid) {
  try {
    const r = await fetch(`/api/messages/channel/${chid}`);
    const msgs = await r.json();
    msgs.forEach(m => appendMsg(m));
  } catch (e) {}
}

// ── MESSAGING & RENDERING ───────────────────────────────────────────────────────
function clearMessages() {
  document.getElementById('msgs').innerHTML = `
    <div class="chat-welcome" id="chat-welcome">
      <div class="cw-icon">💬</div>
      <div class="cw">
        <h2>ego Messenger</h2>
        <p>Отправляйте сообщения, голосовые, видео-кружочки или звоните друзьям в один клик!</p>
      </div>
    </div>
  `;
}

function scrollToBottom() {
  const vp = document.getElementById('msgs');
  vp.scrollTop = vp.scrollHeight;
}

function appendMsg(msg) {
  const vp = document.getElementById('msgs');
  const welcome = document.getElementById('chat-welcome');
  if (welcome) welcome.remove();

  const isSelf = String(msg.from) === String(me.id);
  const isVnote = msg.content?.startsWith('[vnote:');
  const isVoice = msg.content?.startsWith('[voice:');
  const isImg = msg.content?.startsWith('[img:');

  const mg = document.createElement('div');
  mg.className = `mg ${isSelf ? 'me' : 'them'}`;

  if (!isSelf) {
    const head = document.createElement('div');
    head.className = 'mg-head';
    const sender = document.createElement('span');
    sender.className = 'mg-sender';
    sender.textContent = msg.username;
    head.appendChild(sender);
    mg.appendChild(head);
  }

  const bbl = document.createElement('div');
  bbl.className = 'bbl';

  if (isVnote) {
    const key = msg.content.replace('[vnote:', '').replace(/\]$/, '');
    const vid = document.createElement('video');
    vid.className = 'vnote';
    vid.autoplay = true; vid.loop = true; vid.muted = true; vid.setAttribute('playsinline', '');
    vid.onclick = () => { vid.muted = !vid.muted; };
    if (key.startsWith('data:video')) vid.src = key;
    else idbGet('vnotes', key, d => { if (d) vid.src = d; });
    bbl.appendChild(vid);
    bbl.style.background = 'transparent'; bbl.style.border = 'none'; bbl.style.padding = '0';
  } else if (isVoice) {
    const key = msg.content.replace('[voice:', '').replace(/\]$/, '');
    bbl.classList.add('voice-bbl');
    const play = document.createElement('div');
    play.className = 'voice-play';
    play.textContent = '▶';
    let aud = null;
    play.onclick = () => {
      if (!aud) {
        const playAudio = (data) => {
          aud = new Audio(data);
          aud.play();
          play.textContent = '⏸';
          aud.onended = () => { play.textContent = '▶'; aud = null; };
        };
        if (key.startsWith('data:audio')) playAudio(key);
        else idbGet('voices', key, d => { if (d) playAudio(d); });
      } else if (aud.paused) { aud.play(); play.textContent = '⏸'; }
      else { aud.pause(); play.textContent = '▶'; }
    };
    const wave = document.createElement('div');
    wave.className = 'voice-wave';
    for (let i = 0; i < 6; i++) {
      const bar = document.createElement('div');
      bar.className = 'wave-bar';
      wave.appendChild(bar);
    }
    bbl.appendChild(play); bbl.appendChild(wave);
  } else if (isImg) {
    const src = msg.content.replace('[img:', '').replace(/\]$/, '');
    const img = document.createElement('img');
    img.className = 'msg-img';
    img.src = src;
    img.onclick = () => window.open(src, '_blank');
    bbl.appendChild(img);
  } else {
    bbl.textContent = msg.content || '';
  }

  mg.appendChild(bbl);
  vp.appendChild(mg);
  scrollToBottom();
}

function sendMsg() {
  if (me.is_banned || !target.id) return;
  const inp = document.getElementById('msg-input');
  const content = inp.value.trim();
  if (!content) return;

  const payload = {
    from: me.id,
    username: me.username,
    is_verified: me.is_verified,
    avatar_url: me.avatar_url,
    content
  };

  if (target.type === 'dm') {
    socket.emit('dm', { ...payload, to: target.id });
  } else {
    socket.emit('ch_msg', { ...payload, chId: target.id });
  }

  inp.value = '';
  inp.style.height = 'auto';
}

socket.on('dm', (msg) => {
  if (target.type === 'dm' && (String(msg.from) === String(target.id) || String(msg.from) === String(me.id))) {
    appendMsg(msg);
  }
});

socket.on('ch_msg', (msg) => {
  if (target.type === 'channel' && String(msg.channelId) === String(target.id)) {
    appendMsg(msg);
  }
});

// ── VIDEO NOTES (КРУЖОЧКИ) ──────────────────────────────────────────────────────
async function openVnoteModal() {
  try {
    vnStream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 320, facingMode: 'user' }, audio: true });
    document.getElementById('vn-prev').srcObject = vnStream;
    openModal('m-vnote');
  } catch (e) { alert('Нет доступа к камере или микрофону'); }
}

function getSupportedMime(types) {
  return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

function startVnote() {
  vnChunks = [];
  const mime = getSupportedMime(['video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4']);
  try { vnRec = new MediaRecorder(vnStream, mime ? { mimeType: mime } : {}); }
  catch { vnRec = new MediaRecorder(vnStream); }

  vnRec.ondataavailable = e => { if (e.data && e.data.size > 0) vnChunks.push(e.data); };
  vnRec.onstop = sendVnote;
  vnRec.start(100);

  document.getElementById('vn-start').style.display = 'none';
  document.getElementById('vn-stop').style.display = 'inline-flex';
  document.getElementById('rec-badge').style.display = 'flex';
  vnSec = 0;
  vnTimer = setInterval(() => {
    vnSec++;
    document.getElementById('vn-timer').textContent = fmtSec(vnSec);
    if (vnSec >= 60) stopVnote();
  }, 1000);
}

function stopVnote() {
  if (vnRec && vnRec.state !== 'inactive') vnRec.stop();
  clearInterval(vnTimer);
}

function sendVnote() {
  const blob = new Blob(vnChunks, { type: vnRec.mimeType || 'video/webm' });
  const reader = new FileReader();
  reader.readAsDataURL(blob);
  reader.onloadend = () => {
    const data = reader.result;
    const key = 'vn_' + Date.now();
    idbSave('vnotes', key, data);
    const content = `[vnote:${data}]`;
    const payload = { from: me.id, username: me.username, is_verified: me.is_verified, avatar_url: me.avatar_url, content };
    if (target.type === 'dm') socket.emit('dm', { ...payload, to: target.id });
    else socket.emit('ch_msg', { ...payload, chId: target.id });
    closeVnoteModal();
  };
}

function closeVnoteModal() {
  if (vnStream) { vnStream.getTracks().forEach(t => t.stop()); vnStream = null; }
  clearInterval(vnTimer);
  vnChunks = [];
  document.getElementById('vn-start').style.display = 'inline-flex';
  document.getElementById('vn-stop').style.display = 'none';
  document.getElementById('rec-badge').style.display = 'none';
  document.getElementById('vn-timer').textContent = '00:00';
  closeModal('m-vnote');
}

// ── VOICE MESSAGES ────────────────────────────────────────────────────────────
async function openVoiceModal() {
  openModal('m-voice');
}

async function startVoice() {
  try {
    vrStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) { alert('Нет доступа к микрофону'); return; }

  vrChunks = [];
  const mime = getSupportedMime(['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg']);
  try { vrRec = new MediaRecorder(vrStream, mime ? { mimeType: mime } : {}); }
  catch { vrRec = new MediaRecorder(vrStream); }

  vrRec.ondataavailable = e => { if (e.data && e.data.size > 0) vrChunks.push(e.data); };
  vrRec.onstop = sendVoice;
  vrRec.start(100);

  document.getElementById('vr-start-btn').style.display = 'none';
  document.getElementById('vr-stop-btn').style.display = 'flex';
  vrSec = 0;
  vrTimer = setInterval(() => {
    vrSec++;
    document.getElementById('vr-timer').textContent = fmtSec(vrSec);
  }, 1000);
}

function stopVoice() {
  if (vrRec && vrRec.state !== 'inactive') vrRec.stop();
  clearInterval(vrTimer);
}

function sendVoice() {
  const blob = new Blob(vrChunks, { type: vrRec.mimeType || 'audio/webm' });
  const reader = new FileReader();
  reader.readAsDataURL(blob);
  reader.onloadend = () => {
    const data = reader.result;
    const key = 'vr_' + Date.now();
    idbSave('voices', key, data);
    const content = `[voice:${data}]`;
    const payload = { from: me.id, username: me.username, is_verified: me.is_verified, avatar_url: me.avatar_url, content };
    if (target.type === 'dm') socket.emit('dm', { ...payload, to: target.id });
    else socket.emit('ch_msg', { ...payload, chId: target.id });
    closeVoiceModal();
  };
  if (vrStream) { vrStream.getTracks().forEach(t => t.stop()); vrStream = null; }
}

function closeVoiceModal() {
  if (vrStream) { vrStream.getTracks().forEach(t => t.stop()); vrStream = null; }
  clearInterval(vrTimer);
  vrChunks = [];
  document.getElementById('vr-start-btn').style.display = 'flex';
  document.getElementById('vr-stop-btn').style.display = 'none';
  document.getElementById('vr-timer').textContent = '00:00';
  closeModal('m-voice');
}

// ── WebRTC CALLS ─────────────────────────────────────────────────────────────
async function startCall(isVideo) {
  if (!target.id || target.type !== 'dm') return;
  callTarget = target.id;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: isVideo });
    document.getElementById('vid-local').srcObject = localStream;
    document.getElementById('ca-title').textContent = isVideo ? '📹 Видеозвонок' : '📞 Аудиозвонок';
    document.getElementById('ca-status').textContent = 'Вызов...';
    openModal('m-call-act');
    initPC();
    socket.emit('call_user', { to: callTarget, from: me.id, callerUsername: me.username, isVideo });
  } catch (e) { alert('Нет доступа к камере или микрофону'); }
}

socket.on('call_incoming', d => {
  incomingCall = d;
  document.getElementById('ci-name').textContent = d.callerUsername;
  document.getElementById('ci-type').textContent = d.isVideo ? '📹 Видеозвонок' : '📞 Аудиозвонок';
  openModal('m-call-in');
});

async function acceptCall() {
  if (!incomingCall) return;
  closeModal('m-call-in');
  callTarget = incomingCall.from;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: incomingCall.isVideo });
    document.getElementById('vid-local').srcObject = localStream;
    document.getElementById('ca-title').textContent = incomingCall.isVideo ? '📹 Видеозвонок' : '📞 Аудиозвонок';
    document.getElementById('ca-status').textContent = 'Соединение...';
    openModal('m-call-act');
    initPC();
    socket.emit('call_accept', { to: callTarget, from: me.id });
  } catch (e) { alert('Ошибка доступа к устройствам'); }
}

function rejectCall() {
  if (incomingCall) socket.emit('call_reject', { to: incomingCall.from, from: me.id });
  closeModal('m-call-in');
  incomingCall = null;
}

socket.on('call_accepted', async () => {
  if (!pc) return;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('rtc_offer', { to: callTarget, offer });
});

socket.on('call_rejected', () => { alert('Вызов отклонён или абонент не в сети'); endCall(); });
socket.on('rtc_offer', async d => {
  if (!pc) initPC();
  await pc.setRemoteDescription(new RTCSessionDescription(d.offer));
  const ans = await pc.createAnswer();
  await pc.setLocalDescription(ans);
  socket.emit('rtc_answer', { to: d.from, answer: ans });
  document.getElementById('ca-status').textContent = 'Соединено ✅';
});
socket.on('rtc_answer', async d => { if (pc) await pc.setRemoteDescription(new RTCSessionDescription(d.answer)); });
socket.on('rtc_ice', async d => { try { if (pc && d.candidate) await pc.addIceCandidate(new RTCIceCandidate(d.candidate)); } catch {} });
socket.on('call_ended', () => endCall());

function initPC() {
  pc = new RTCPeerConnection(rtcCfg);
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.ontrack = e => {
    const rv = document.getElementById('vid-remote');
    if (rv.srcObject !== e.streams[0]) rv.srcObject = e.streams[0];
  };
  pc.onicecandidate = e => { if (e.candidate) socket.emit('rtc_ice', { to: callTarget, candidate: e.candidate }); };
  pc.onconnectionstatechange = () => {
    if (pc?.connectionState === 'connected') document.getElementById('ca-status').textContent = 'Соединено ✅';
    if (pc?.connectionState === 'disconnected' || pc?.connectionState === 'failed') endCall();
  };
}

function endCall() {
  if (pc) { pc.close(); pc = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (callTarget) { socket.emit('call_end', { to: callTarget }); callTarget = null; }
  closeModal('m-call-act');
  closeModal('m-call-in');
}

// ── PROFILE MODAL ─────────────────────────────────────────────────────────────
function openProfileModal() {
  document.getElementById('p-username').value = me.username;
  document.getElementById('p-bio').value = me.bio || '';
  document.getElementById('p-status').value = me.status_text || '';
  openModal('m-profile');
}

async function saveProfile() {
  const bio = document.getElementById('p-bio').value.trim() || null;
  const status_text = document.getElementById('p-status').value.trim() || null;
  const status_emoji = document.getElementById('p-emoji').value.trim() || '🟢';
  try {
    const r = await fetch('/api/users/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: me.id, bio, status_text, status_emoji })
    });
    const d = await r.json();
    if (!r.ok) { alert(d.error); return; }
    me = d.user;
    localStorage.setItem('ego_me', JSON.stringify(me));
    updateUserCard();
    closeModal('m-profile');
  } catch (e) { alert('Ошибка сохранения'); }
}

// ── MODALS & UTILS ────────────────────────────────────────────────────────────
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function hideSidebar() { if (window.innerWidth <= 768) document.getElementById('sidebar').classList.add('hidden'); }
function showSidebar() { document.getElementById('sidebar').classList.remove('hidden'); }
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function fmtSec(s) { const m = Math.floor(s / 60).toString().padStart(2, '0'); const ss = (s % 60).toString().padStart(2, '0'); return `${m}:${ss}`; }
function logout() { localStorage.clear(); location.reload(); }
