// ── GLOBALS ─────────────────────────────────────────────────────────────────
let socket = null;
let socketEventsBound = false;
let me = null, isReg = false;
let target = { type: null, id: null, serverId: null, name: '', data: null };
let replyMsg = null, editMsg = null, ctxMsg = null;

// WebRTC
let pc = null, localStream = null, callTarget = null, incomingCall = null;
let callMuted = false, callCamOff = false, callIsVideo = false;
let iceQueue = [], ringTimer = null;
const rtcCfg = { iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}] };

// Video note
let vnRec = null, vnStream = null, vnChunks = [], vnTimer = null, vnSec = 0;

// Voice
let vrRec = null, vrStream = null, vrChunks = [], vrTimer = null, vrSec = 0;

// IndexedDB
let idb = null;
function initIDB(){
  const r=indexedDB.open('ego_idb',2);
  r.onupgradeneeded=e=>{
    const db=e.target.result;
    if(!db.objectStoreNames.contains('vnotes')) db.createObjectStore('vnotes',{keyPath:'id'});
    if(!db.objectStoreNames.contains('voices')) db.createObjectStore('voices',{keyPath:'id'});
  };
  r.onsuccess=e=>{ idb=e.target.result; };
}
function idbSave(store,id,data){ if(!idb)return; const tx=idb.transaction(store,'readwrite'); tx.objectStore(store).put({id,data}); }
function idbGet(store,id,cb){ if(!idb)return cb(null); const tx=idb.transaction(store,'readonly'); const r=tx.objectStore(store).get(id); r.onsuccess=()=>cb(r.result?.data||null); }

// Typing debounce
let typTimer=null, isTyping=false;

// Messages in-memory store for search/edit
const msgMap = new Map(); // msgId -> {el, data}

// ── INIT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded',()=>{
  initIDB();
  buildWpGrid();
  buildEmojiPicker();
  setupStatusOpts();

  const wp = localStorage.getItem('ego_wp')||'wp-0';
  setWp(wp);

  const saved = localStorage.getItem('ego_me');
  if(saved){
    me = JSON.parse(saved);
    const t = localStorage.getItem('ego_target');
    if(t) target = JSON.parse(t);
    bootApp();
  }
});

// ── AUTH ─────────────────────────────────────────────────────────────────────
function toggleReg(){
  isReg=!isReg;
  document.getElementById('a-email-g').style.display=isReg?'block':'none';
  document.getElementById('a-btn').textContent=isReg?'Зарегистрироваться':'Войти';
  document.getElementById('a-switch').innerHTML=isReg?'Есть аккаунт? <b>Войти</b>':'Нет аккаунта? <b>Зарегистрироваться</b>';
  document.getElementById('auth-tag').textContent=isReg?'Создайте аккаунт':'Войдите чтобы продолжить';
  document.getElementById('auth-err').style.display='none';
}

function showAuthErr(msg){
  const el=document.getElementById('auth-err');
  el.textContent=msg; el.style.display='block';
}

async function doAuth(){
  const user=document.getElementById('a-user').value.trim();
  const pass=document.getElementById('a-pass').value.trim();
  const email=document.getElementById('a-email').value.trim();
  if(!user||!pass||(isReg&&!email)){showAuthErr('Заполните все поля');return;}

  const ep=isReg?'/api/register':'/api/login';
  const body=isReg?{username:user,email,password:pass}:{username:user,password:pass};

  try{
    const res=await fetch(ep,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await res.json();
    if(!res.ok){showAuthErr(d.error||'Ошибка');return;}
    me=d.user;
    localStorage.setItem('ego_me',JSON.stringify(me));
    bootApp();
  }catch(e){showAuthErr('Нет соединения с сервером');}
}

function initSocket(){
  if(!me?.id) return;
  if(socket){
    if(socket.connected) socket.emit('user_connected', me.id);
    return;
  }
  socket = io(window.location.origin, {
    path: '/socket.io/',
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    timeout: 20000
  });
  if(!socketEventsBound){
    setupSocketEvents();
    socketEventsBound = true;
  }
  socket.on('connect', () => {
    console.log('[Socket.IO] connected', socket.id);
    socket.emit('user_connected', me.id);
    if(target.type === 'channel' && target.id){
      socket.emit('join_channel', target.id);
    }
  });
  socket.on('disconnect', () => console.log('[Socket.IO] disconnected'));
  socket.on('connect_error', (err) => console.warn('[Socket.IO] error', err.message));
}

function bootApp(){
  document.getElementById('auth').style.display='none';
  document.getElementById('app').style.display='flex';
  initSocket();
  updateUserCard();
  loadContacts();
  loadServersRail();
  setInterval(pollStatus,5000);

  // Restore last chat
  if(target.type==='dm'&&target.id){
    // will restore after contacts load
  } else if(target.type==='channel'&&target.id){
    // will restore after server load
  }
}

async function pollStatus(){
  if(!me) return;
  try{
    const r=await fetch(`/api/users/me/${me.id}`);
    if(r.ok){
      const d=await r.json();
      Object.assign(me,d);
      localStorage.setItem('ego_me',JSON.stringify(me));
      updateUserCard();
    }
  }catch(e){}
}

function updateUserCard(){
  document.getElementById('uc-name').textContent=me.username;
  document.getElementById('uc-vbadge').innerHTML=me.is_verified?'<span class="vbadge">✓</span>':'';
  document.getElementById('uc-sub').textContent=me.status_text||'В сети';
  setAva(document.getElementById('uc-ava'),me.avatar_url,me.username);
  document.getElementById('banned-banner').style.display=me.is_banned?'block':'none';
  updateInputState();
}

function updateInputState(){
  const ok=!me.is_banned&&!!target.id;
  ['msg-input','send-btn','btn-attach','btn-voice','btn-vnote'].forEach(id=>{
    const el=document.getElementById(id);
    if(el) el.disabled=!ok;
  });
}

// ── AVATAR HELPER ─────────────────────────────────────────────────────────────
function setAva(el,url,name,size){
  if(url){el.style.backgroundImage=`url('${esc(url)}')`;el.textContent='';}
  else{el.style.backgroundImage='none';el.textContent=(name||'?').charAt(0).toUpperCase();}
}

// ── CONTACTS ─────────────────────────────────────────────────────────────────
let contactsCache=[];

async function loadContacts(){
  try{
    const r=await fetch(`/api/contacts/${me.id}`);
    contactsCache=await r.json();
    renderContacts(contactsCache);
    // Restore DM
    if(target.type==='dm'&&target.id){
      const c=contactsCache.find(x=>String(x.id)===String(target.id));
      if(c) selectDM(c,true);
    }
  }catch(e){}
}

function renderContacts(list){
  const el=document.getElementById('contacts-list');
  if(!list.length){
    el.innerHTML='<div style="padding:20px 12px;color:var(--t4);font-size:12px;text-align:center">Найдите пользователей выше чтобы добавить контакт</div>';
    return;
  }
  el.innerHTML='';
  list.forEach(c=>{
    const div=document.createElement('div');
    div.className=`ni ${target.type==='dm'&&String(target.id)===String(c.id)?'act':''}${c.is_muted?' ni-muted':''}`;
    div.dataset.cid=c.id;

    const ava=document.createElement('div');
    ava.className='ava'+(c._online?' online':'');
    setAva(ava,c.avatar_url,c.nickname||c.username);

    const nameWrap=document.createElement('div');
    nameWrap.className='ni-name';
    nameWrap.innerHTML=`${esc(c.nickname||c.username)}${c.is_verified?'<span class="vbadge">✓</span>':''}${c.pinned?'<span class="ni-pinned" title="Закреплён">📌</span>':''}`;

    div.appendChild(ava);
    div.appendChild(nameWrap);

    // Right-click contact menu
    div.addEventListener('contextmenu',e=>{
      e.preventDefault();
      showContactCtx(e,c);
    });

    div.addEventListener('click',()=>selectDM(c));
    el.appendChild(div);
  });
}

function selectDM(contact, skipNav){
  target={type:'dm',id:contact.id,name:contact.nickname||contact.username,data:contact};
  localStorage.setItem('ego_target',JSON.stringify(target));

  document.querySelectorAll('.ni').forEach(el=>el.classList.remove('act'));
  const el=document.querySelector(`.ni[data-cid="${contact.id}"]`);
  if(el) el.classList.add('act');

  document.getElementById('ch-sym').textContent='@';
  document.getElementById('ch-name').textContent=contact.nickname||contact.username;
  document.getElementById('ch-vbadge').innerHTML=contact.is_verified?'<span class="vbadge">✓</span>':'';

  const chAva=document.getElementById('ch-ava');
  chAva.style.display='flex';
  setAva(chAva,contact.avatar_url,contact.username);
  document.getElementById('ch-sub').textContent=contact.status_text||'';

  document.getElementById('btn-audio').style.display='flex';
  document.getElementById('btn-video').style.display='flex';
  document.getElementById('btn-invite').style.display='none';

  clearMessages();
  loadChatHistory();
  updateInputState();
  if(!skipNav) hideSidebar();

  // Click on header avatar → view profile
  document.getElementById('ch-ava').onclick=()=>viewProfile(contact.id);
}

// Contact right-click context menu
let contactCtxData=null;
function showContactCtx(e,c){
  contactCtxData=c;
  // Use a simple prompt-free context menu approach via a temp dropdown
  const existing=document.getElementById('contact-ctx-tmp');
  if(existing) existing.remove();

  const menu=document.createElement('div');
  menu.id='contact-ctx-tmp';
  menu.style.cssText=`position:fixed;left:${Math.min(e.clientX,window.innerWidth-180)}px;top:${Math.min(e.clientY,window.innerHeight-200)}px;background:var(--c3);border:1px solid var(--b2);border-radius:var(--r16);padding:6px;z-index:9001;min-width:170px;box-shadow:var(--sh-sm);animation:fadeIn .12s ease`;

  const actions=[
    {icon:'👤',label:'Профиль',fn:()=>viewProfile(c.id)},
    {icon:c.pinned?'📌 Открепить':'📌 Закрепить',label:c.pinned?'Открепить':'Закрепить',fn:()=>togglePin(c)},
    {icon:c.is_muted?'🔔':'🔕',label:c.is_muted?'Включить уведомления':'Отключить уведомления',fn:()=>toggleMute2(c)},
    {icon:'✏️',label:'Никнейм',fn:()=>setNickname(c)},
    {icon:'🚫',label:'Заблокировать',fn:()=>blockContact(c),danger:true},
    {icon:'🗑️',label:'Удалить контакт',fn:()=>deleteContact(c),danger:true},
  ];

  actions.forEach(a=>{
    const div=document.createElement('div');
    div.className='ctx-it'+(a.danger?' danger':'');
    div.textContent=`${a.icon} ${a.label}`;
    div.onclick=()=>{ a.fn(); menu.remove(); };
    menu.appendChild(div);
  });

  document.body.appendChild(menu);
  setTimeout(()=>document.addEventListener('click',()=>menu.remove(),{once:true}),50);
}

async function togglePin(c){
  await fetch(`/api/contacts/${me.id}/${c.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({pinned:!c.pinned})});
  loadContacts();
}
async function toggleMute2(c){
  await fetch(`/api/contacts/${me.id}/${c.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({is_muted:!c.is_muted})});
  loadContacts();
}
async function setNickname(c){
  const nick=window.prompt(`Никнейм для @${c.username}:`,c.nickname||'');
  if(nick===null) return;
  await fetch(`/api/contacts/${me.id}/${c.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({nickname:nick||null})});
  loadContacts();
}
async function blockContact(c){
  if(!confirm(`Заблокировать @${c.username}?`)) return;
  await fetch(`/api/contacts/${me.id}/${c.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({is_blocked:true})});
  loadContacts();
}
async function deleteContact(c){
  if(!confirm(`Удалить контакт @${c.username}?`)) return;
  await fetch(`/api/contacts/${me.id}/${c.id}`,{method:'DELETE'});
  loadContacts();
  if(String(target.id)===String(c.id)) clearChat();
}
function clearChat(){
  target={type:null,id:null};
  localStorage.removeItem('ego_target');
  clearMessages();
  document.getElementById('ch-name').textContent='ego';
  document.getElementById('ch-sym').textContent='💬';
  document.getElementById('ch-ava').style.display='none';
  document.getElementById('btn-audio').style.display='none';
  document.getElementById('btn-video').style.display='none';
  updateInputState();
}

// ── VIEW USER PROFILE ─────────────────────────────────────────────────────────
let vpUserId=null;
async function viewProfile(uid){
  try{
    const r=await fetch(`/api/users/${uid}`);
    const u=await r.json();
    vpUserId=uid;
    const ava=document.getElementById('vp-ava');
    setAva(ava,u.avatar_url,u.username);
    document.getElementById('vp-name').textContent=u.username;
    document.getElementById('vp-badge').innerHTML=u.is_verified?'<span class="vbadge">✓</span>':'';
    const meta=[];
    if(u.age) meta.push(`${u.age} лет`);
    if(u.last_seen) meta.push(`Был(а): ${new Date(u.last_seen).toLocaleDateString('ru')}`);
    document.getElementById('vp-meta').textContent=meta.join(' • ');
    const bioEl=document.getElementById('vp-bio');
    if(u.bio){bioEl.textContent=u.bio;bioEl.style.display='block';}else{bioEl.style.display='none';}
    const stat=[];
    if(u.status_text) stat.push(`<div class="pvs-item">${esc(u.status_text)}</div>`);
    document.getElementById('vp-stat').innerHTML=stat.join('');
    openModal('m-view-profile');
  }catch(e){}
}
function vpSendMessage(){
  const c=contactsCache.find(x=>String(x.id)===String(vpUserId));
  if(c){selectDM(c);closeModal('m-view-profile');}
}
function vpCall(){closeModal('m-view-profile');if(String(vpUserId)!==String(target.id)){const c=contactsCache.find(x=>String(x.id)===String(vpUserId));if(c)selectDM(c);}startCall(false);}
function vpBlock(){if(vpUserId){const c=contactsCache.find(x=>String(x.id)===String(vpUserId));if(c)blockContact(c);closeModal('m-view-profile');}}

// ── SERVERS / CHANNELS ─────────────────────────────────────────────────────────
let currentServer=null;
async function loadServersRail(){
  try{
    const r=await fetch(`/api/servers/user/${me.id}`);
    const servers=await r.json();
    const rail=document.getElementById('rail-servers');
    rail.innerHTML='';
    servers.forEach(s=>{
      const div=document.createElement('div');
      div.className=`ri ${target.type==='channel'&&String(target.serverId)===String(s.id)?'act':''}`;
      div.title=s.name;
      if(s.icon_url){div.style.backgroundImage=`url('${esc(s.icon_url)}')`;div.textContent='';}
      else div.textContent=s.name.substring(0,2).toUpperCase();
      div.onclick=()=>selectServer(s);
      rail.appendChild(div);
    });
  }catch(e){}
}
function goToDMs(){
  document.querySelectorAll('.ri').forEach(el=>el.classList.remove('act'));
  document.getElementById('rail-dm').classList.add('act');
  document.getElementById('dm-view').style.display='block';
  document.getElementById('ch-view').style.display='none';
  document.getElementById('sb-title').innerHTML='<span>Сообщения</span>';
  document.getElementById('btn-invite').style.display='none';
  currentServer=null;
}
async function selectServer(s){
  currentServer=s;
  document.querySelectorAll('.ri').forEach(el=>el.classList.remove('act'));

  document.getElementById('dm-view').style.display='none';
  document.getElementById('ch-view').style.display='block';
  document.getElementById('sb-title').innerHTML=`<span>${esc(s.name)}</span>`;
  document.getElementById('btn-invite').style.display='flex';

  await loadChannels(s.id);
  await loadMembersSidebar(s.id);
}
async function loadChannels(sid){
  try{
    const r=await fetch(`/api/servers/${sid}/channels`);
    const chs=await r.json();
    const list=document.getElementById('channels-list');
    list.innerHTML='';
    chs.forEach(ch=>{
      const typeIcon=ch.type==='announcement'?'📢':ch.type==='voice'?'🔊':'#';
      const div=document.createElement('div');
      div.className=`ni ${target.type==='channel'&&String(target.id)===String(ch.id)?'act':''}`;
      div.dataset.chid=ch.id;
      div.innerHTML=`<span style="color:var(--a);font-weight:900;font-size:14px">${typeIcon}</span><div class="ni-name">${esc(ch.name)}${ch.topic?`<span title="${esc(ch.topic)}" style="color:var(--t4);font-size:10px;margin-left:4px">•</span>`:''}`;
      div.onclick=()=>selectChannel(ch);
      list.appendChild(div);
    });
    if(chs.length&&!(target.type==='channel')){selectChannel(chs[0]);}
    if(target.type==='channel'&&target.id){
      const ch=chs.find(x=>String(x.id)===String(target.id));
      if(ch) selectChannel(ch,true);
    }
  }catch(e){}
}
function selectChannel(ch,skipNav){
  target={type:'channel',id:ch.id,serverId:ch.server_id,name:ch.name,data:ch};
  localStorage.setItem('ego_target',JSON.stringify(target));
  document.querySelectorAll('#channels-list .ni').forEach(el=>el.classList.remove('act'));
  const el=document.querySelector(`#channels-list .ni[data-chid="${ch.id}"]`);
  if(el) el.classList.add('act');
  document.getElementById('ch-sym').textContent=ch.type==='announcement'?'📢':'#';
  document.getElementById('ch-name').textContent=ch.name;
  document.getElementById('ch-vbadge').innerHTML='';
  document.getElementById('ch-ava').style.display='none';
  document.getElementById('ch-sub').textContent=ch.topic||'';
  document.getElementById('btn-audio').style.display='none';
  document.getElementById('btn-video').style.display='none';
  if(socket) socket.emit('join_channel',ch.id);
  clearMessages();
  loadChatHistory();
  updateInputState();
  if(!skipNav) hideSidebar();
}
async function loadChatHistory(){
  if(!me || !target.id) return;
  try{
    let url;
    if(target.type==='dm') url=`/api/messages/dm/${me.id}/${target.id}`;
    else if(target.type==='channel') url=`/api/messages/channel/${target.id}`;
    else return;
    const r=await fetch(url);
    if(!r.ok) return;
    const messages=await r.json();
    messages.forEach(msg=>appendMsg(msg, true));
    scrollToBottom();
  }catch(e){ console.warn('loadChatHistory', e); }
}
async function loadMembersSidebar(sid){
  try{
    const r=await fetch(`/api/servers/${sid}/members`);
    const members=await r.json();
    const el=document.getElementById('members-sidebar');
    el.innerHTML='';
    members.slice(0,5).forEach(m=>{
      const div=document.createElement('div');
      div.className='ni';
      div.style.padding='5px 10px';
      const ava=document.createElement('div');
      ava.className='ava';
      ava.style.width='26px';ava.style.height='26px';ava.style.fontSize='10px';
      setAva(ava,m.avatar_url,m.username);
      div.innerHTML=``;
      div.appendChild(ava);
      const name=document.createElement('span');
      name.style='font-size:12px;';
      name.textContent=m.username;
      div.appendChild(name);
      el.appendChild(div);
    });
    if(members.length>5){
      const more=document.createElement('div');
      more.style='padding:4px 10px;font-size:11px;color:var(--t4);cursor:pointer';
      more.textContent=`+${members.length-5} ещё...`;
      more.onclick=openMembersModal;
      el.appendChild(more);
    }
  }catch(e){}
}
async function openMembersModal(){
  if(!currentServer) return;
  try{
    const r=await fetch(`/api/servers/${currentServer.id}/members`);
    const members=await r.json();
    const list=document.getElementById('members-list');
    list.innerHTML='';
    const roleOrder={'owner':0,'admin':1,'member':2};
    members.sort((a,b)=>(roleOrder[a.role]||9)-(roleOrder[b.role]||9)).forEach(m=>{
      const div=document.createElement('div');
      div.className='member-row';
      const ava=document.createElement('div');
      ava.className='ava';
      setAva(ava,m.avatar_url,m.username);
      const name=document.createElement('span');
      name.style='flex:1;font-size:13px;font-weight:600;color:var(--t1)';
      name.textContent=m.username;
      if(m.is_verified) name.innerHTML+=`<span class="vbadge" style="margin-left:4px">✓</span>`;
      const role=document.createElement('span');
      role.className=`member-role role-${m.role}`;
      role.textContent=m.role==='owner'?'Владелец':m.role==='admin'?'Админ':'Участник';
      div.appendChild(ava);div.appendChild(name);div.appendChild(role);
      list.appendChild(div);
    });
    openModal('m-members');
  }catch(e){}
}

// ── CREATE SERVER / CHANNEL ───────────────────────────────────────────────────
async function createServer(){
  const name=document.getElementById('srv-name').value.trim();
  const desc=document.getElementById('srv-desc').value.trim();
  if(!name) return;
  try{
    await fetch('/api/servers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,description:desc,ownerId:me.id})});
    document.getElementById('srv-name').value='';
    document.getElementById('srv-desc').value='';
    closeModal('m-server');
    loadServersRail();
  }catch(e){}
}
async function joinByInvite(){
  const code=document.getElementById('invite-input').value.trim();
  if(!code) return;
  try{
    const r=await fetch('/api/servers/join-invite',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({inviteCode:code,userId:me.id})});
    const d=await r.json();
    if(!r.ok){alert(d.error);return;}
    document.getElementById('invite-input').value='';
    closeModal('m-server');
    loadServersRail();
    alert(`Вы вступили на сервер: ${d.server.name}`);
  }catch(e){}
}
async function createChannel(){
  if(!currentServer) return;
  const name=document.getElementById('ch-name-inp').value.trim();
  const topic=document.getElementById('ch-topic-inp').value.trim();
  const type=document.getElementById('ch-type-inp').value;
  if(!name) return;
  await fetch(`/api/servers/${currentServer.id}/channels`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,topic,type,userId:me.id})});
  document.getElementById('ch-name-inp').value='';
  document.getElementById('ch-topic-inp').value='';
  closeModal('m-channel');
  loadChannels(currentServer.id);
}

// Invite code
async function openInviteModal(){
  if(!currentServer){
    const r=await fetch(`/api/servers/user/${me.id}`);
    const servers=await r.json();
    if(!servers.length) return;
  }
  document.getElementById('invite-display').textContent=currentServer?.invite_code||'--------';
  document.getElementById('invite-copied').textContent='';
  openModal('m-invite');
}
function copyInvite(){
  const code=document.getElementById('invite-display').textContent;
  navigator.clipboard.writeText(code).then(()=>{
    document.getElementById('invite-copied').textContent='✅ Скопировано!';
    setTimeout(()=>document.getElementById('invite-copied').textContent='',2000);
  });
}

// ── MESSAGES ─────────────────────────────────────────────────────────────────
function clearMessages(){
  const vp=document.getElementById('msgs');
  vp.innerHTML='<div class="chat-welcome" id="chat-welcome"><div class="cw-icon"><svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" fill="none" stroke="white" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></div><div class="cw"><h2>Начало беседы</h2><p>Отправьте первое сообщение, видеокружочек или голосовое!</p></div></div>';
  msgMap.clear();
}

function scrollToBottom(){
  const vp=document.getElementById('msgs');
  vp.scrollTop=vp.scrollHeight;
}

function appendMsg(msg, skipScroll){
  const vp=document.getElementById('msgs');
  const welcome=document.getElementById('chat-welcome');
  if(welcome) welcome.remove();

  if(msgMap.has(String(msg.id))) return;

  const isSelf=String(msg.from)===String(me.id);
  const isVnote=msg.content?.startsWith('[vnote:');
  const isVoice=msg.content?.startsWith('[voice:');
  const isImg  =msg.content?.startsWith('[img:');
  const isDel  =msg.content?.startsWith('[deleted]');
  const isFwd  =msg.content?.startsWith('[fwd:');

  const mg=document.createElement('div');
  mg.className=`mg ${isSelf?'me':'them'}`;
  mg.dataset.msgId=msg.id;

  // Sender header (only for them)
  if(!isSelf){
    const head=document.createElement('div');
    head.className='mg-head';
    const ava=document.createElement('div');
    ava.className='ava';
    ava.style.width='26px';ava.style.height='26px';ava.style.fontSize='10px';
    setAva(ava,msg.avatar_url,msg.username);
    ava.style.cursor='pointer';
    ava.onclick=()=>viewProfile(msg.from);
    const sender=document.createElement('span');
    sender.className='mg-sender';
    sender.innerHTML=esc(msg.username)+(msg.is_verified?'<span class="vbadge">✓</span>':'');
    head.appendChild(ava);head.appendChild(sender);
    const ts=document.createElement('span');
    ts.className='mg-ts';
    ts.textContent=fmt(msg.ts);
    head.appendChild(ts);
    mg.appendChild(head);
  }

  const bbl=document.createElement('div');
  bbl.className='bbl';
  if(isDel) bbl.classList.add('bbl-deleted');

  // Reply quote
  if(msg.reply){
    const q=document.createElement('div');
    q.className='reply-q';
    q.innerHTML=`<strong>${esc(msg.reply.username)}</strong> ${esc((msg.reply.content||'').substring(0,70))}`;
    bbl.appendChild(q);
  }

  // Forwarded
  if(isFwd&&!isDel){
    const orig=msg.content.replace('[fwd:','').replace(/\]$/,'');
    const fwdMark=document.createElement('div');
    fwdMark.style='font-size:10px;color:var(--al);margin-bottom:4px;font-weight:700';
    fwdMark.textContent='↪ Переслано';
    bbl.appendChild(fwdMark);
    const txt=document.createElement('span');
    txt.textContent=orig;
    bbl.appendChild(txt);
  } else if(isVnote&&!isDel){
    const key=msg.content.replace('[vnote:','').replace(/\]$/,'');
    const vid=document.createElement('video');
    vid.className='vnote';
    vid.autoplay=true;vid.loop=true;vid.muted=true;
    vid.setAttribute('playsinline','');
    vid.onclick=()=>{vid.muted=!vid.muted;};
    if(key.startsWith('data:video')||key.startsWith('http')||key.startsWith('/uploads')) vid.src=key;
    else idbGet('vnotes',key,d=>{if(d)vid.src=d;});
    bbl.appendChild(vid);
    bbl.style.background='transparent';bbl.style.border='none';bbl.style.padding='0';
  } else if(isVoice&&!isDel){
    const key=msg.content.replace('[voice:','').replace(/\]$/,'');
    bbl.classList.add('voice-bbl');
    const play=document.createElement('div');
    play.className='voice-play';
    play.innerHTML='▶';
    let aud=null;
    play.onclick=()=>{
      if(!aud){
        const loadAndPlay=(data)=>{aud=new Audio(data);aud.play();play.innerHTML='⏸';aud.onended=()=>{play.innerHTML='▶';aud=null;};};
        if(key.startsWith('data:audio')||key.startsWith('http')||key.startsWith('/uploads')) loadAndPlay(key);
        else idbGet('voices',key,d=>{if(d)loadAndPlay(d);});
      }else if(aud.paused){aud.play();play.innerHTML='⏸';}
      else{aud.pause();play.innerHTML='▶';}
    };
    const wave=document.createElement('div');
    wave.className='voice-wave';
    for(let i=0;i<6;i++){
      const b=document.createElement('div');
      b.className='wave-bar';
      b.style.height=`${[6,12,20,16,24,10][i]}px`;
      wave.appendChild(b);
    }
    const dur=document.createElement('span');
    dur.className='voice-dur';
    dur.textContent=msg.voice_dur||'0:00';
    bbl.appendChild(play);bbl.appendChild(wave);bbl.appendChild(dur);
  } else if(isImg&&!isDel){
    const src=msg.content.replace('[img:','').replace(/\]$/,'');
    const img=document.createElement('img');
    img.className='msg-img';
    img.src=src;img.loading='lazy';
    img.onclick=()=>window.open(src,'_blank');
    bbl.appendChild(img);
  } else if(isDel){
    bbl.textContent='🗑 Сообщение удалено';
  } else {
    // Plain text with basic formatting
    bbl.textContent=msg.content||'';
  }

  // Timestamp + read status (only for self, non-media)
  if(isSelf&&!isVnote){
    const foot=document.createElement('div');
    foot.className='bbl-foot';
    const time=document.createElement('span');
    time.className='bbl-time';
    time.textContent=fmt(msg.ts);
    foot.appendChild(time);
    if(msg.edited){const ed=document.createElement('span');ed.className='bbl-time';ed.textContent=' (ред.)';foot.appendChild(ed);}
    const status=document.createElement('span');
    status.className='bbl-status';
    status.id=`status-${msg.id}`;
    status.textContent='✓';
    foot.appendChild(status);
    bbl.appendChild(foot);
  }

  mg.appendChild(bbl);

  // Reactions
  const reacts=document.createElement('div');
  reacts.className='reacts';
  reacts.id=`r-${msg.id}`;
  mg.appendChild(reacts);

  // Context menu events
  bbl.addEventListener('contextmenu',e=>{e.preventDefault();ctxMsg=msg;showCtx(e.clientX,e.clientY,isSelf);});
  let pressT;
  bbl.addEventListener('touchstart',e=>{pressT=setTimeout(()=>{ctxMsg=msg;const t=e.touches[0];showCtx(t.clientX,t.clientY,isSelf);},500);});
  bbl.addEventListener('touchend',()=>clearTimeout(pressT));

  vp.appendChild(mg);
  msgMap.set(String(msg.id),{el:mg,data:msg});
  if(!skipScroll) scrollToBottom();
}

function isMessageForCurrentChat(msg){
  if(!target?.id) return false;
  if(target.type === 'dm'){
    const from = String(msg.from);
    const to = String(msg.to || '');
    const tid = String(target.id);
    const mid = String(me.id);
    return (from === tid && to === mid) || (from === mid && to === tid);
  }
  if(target.type === 'channel'){
    return String(msg.channelId) === String(target.id);
  }
  return false;
}

function markContactOnline(userId, online){
  const el = document.querySelector(`.ni[data-cid="${userId}"] .ava`);
  if(el) el.classList.toggle('online', online);
  const c = contactsCache.find(x => String(x.id) === String(userId));
  if(c) c._online = online;
}

// ── SOCKET EVENTS ─────────────────────────────────────────────────────────────
function setupSocketEvents(){
  if(!socket) return;

  socket.on('receive_message',(msg)=>{
    if(isMessageForCurrentChat(msg)){
      appendMsg(msg);
      if(String(msg.from) === String(target.id) && target.type === 'dm'){
        socket.emit('read',{to:target.id,from:me.id,msgId:msg.id});
      }
    }
    if(String(msg.from) !== String(me.id)) playNotifSound();
  });

  socket.on('online_users',({users})=>{
    (users || []).forEach(uid => markContactOnline(uid, true));
  });

  socket.on('user_connected',d=>{
    markContactOnline(d.userId, true);
  });

  socket.on('user_disconnected',d=>{
    markContactOnline(d.userId, false);
  });

  socket.on('typing',d=>{
    if((target.type==='dm'&&String(d.from)===String(target.id))||(target.type==='channel')){
      document.getElementById('typing-name').textContent=d.fromName;
      document.getElementById('typing-ind').style.display='block';
    }
  });

  socket.on('stop_typing',()=>{ document.getElementById('typing-ind').style.display='none'; });

  socket.on('read',d=>{
    const el=document.getElementById(`status-${d.msgId}`);
    if(el) el.textContent='👁';
  });

  socket.on('react',d=>{
    const el=document.getElementById(`r-${d.msgId}`);
    if(!el) return;
    let chip=el.querySelector(`[data-emoji="${d.emoji}"]`);
    if(!chip){
      chip=document.createElement('div');
      chip.className=`react-chip${String(d.from)===String(me.id)?' mine':''}`;
      chip.dataset.emoji=d.emoji;chip.dataset.count='1';
      chip.innerHTML=`${d.emoji}<span>1</span>`;
      el.appendChild(chip);
    } else {
      const cnt=parseInt(chip.dataset.count)+1;
      chip.dataset.count=cnt;
      chip.querySelector('span').textContent=cnt;
    }
  });

  socket.on('edit_msg',d=>{
    const entry=msgMap.get(String(d.msgId));
    if(!entry) return;
    entry.data.content=d.newContent;entry.data.edited=true;
    const bbl=entry.el.querySelector('.bbl');
    if(bbl){
      Array.from(bbl.childNodes).forEach(n=>{if(n.nodeType===3)bbl.removeChild(n);});
      bbl.insertBefore(document.createTextNode(d.newContent),bbl.firstChild);
      const foot=bbl.querySelector('.bbl-foot');
      if(foot){const ed=document.createElement('span');ed.className='bbl-time';ed.textContent=' (ред.)';foot.appendChild(ed);}
    }
  });

  socket.on('delete_msg',d=>{
    const entry=msgMap.get(String(d.msgId));
    if(!entry) return;
    const bbl=entry.el.querySelector('.bbl');
    if(bbl){bbl.innerHTML='🗑 Сообщение удалено';bbl.classList.add('bbl-deleted');}
  });

  setupWebRTCEvents();
}

// ── SEND MESSAGE ─────────────────────────────────────────────────────────────
function buildMessagePayload(content, extra={}){
  const payload={
    from:me.id,
    username:me.username,
    is_verified:me.is_verified,
    avatar_url:me.avatar_url,
    content,
    reply:replyMsg?{id:replyMsg.id,content:replyMsg.content,username:replyMsg.username}:null,
    ...extra
  };
  if(target.type==='dm'){
    payload.type='dm';
    payload.to=target.id;
  }else{
    payload.type='channel';
    payload.channelId=target.id;
  }
  return payload;
}

function sendMsg(){
  if(me.is_banned||!target.id) return;
  const inp=document.getElementById('msg-input');
  const content=inp.value.trim();
  if(!content) return;

  if(editMsg){
    // Edit existing
    const d={msgId:editMsg.id,newContent:content,type:target.type,to:target.id,chId:target.id};
    socket.emit('edit_msg',d);
    cancelEdit();
    inp.value='';inp.style.height='auto';
    stopTypingEmit();
    return;
  }

  const payload=buildMessagePayload(content);
  if(socket) socket.emit('send_message', payload);

  cancelReply();
  inp.value='';inp.style.height='auto';
  stopTypingEmit();
}

function sendImageAttachment(e){
  const file=e.target.files[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=ev=>{
    const payload=buildMessagePayload(`[img:${ev.target.result}]`, { messageType: 'image' });
    if(socket) socket.emit('send_message', payload);
  };
  reader.readAsDataURL(file);
  e.target.value='';
}

// ── TYPING ───────────────────────────────────────────────────────────────────
function onTyping(){
  if(!target.id) return;
  if(!isTyping){
    isTyping=true;
    socket.emit('typing',{type:target.type,from:me.id,to:target.id,chId:target.id,fromName:me.username});
  }
  clearTimeout(typTimer);
  typTimer=setTimeout(stopTypingEmit,2500);
}
function stopTypingEmit(){
  if(isTyping){
    isTyping=false;
    socket.emit('stop_typing',{type:target.type,from:me.id,to:target.id,chId:target.id});
  }
}

// ── REPLY / EDIT ─────────────────────────────────────────────────────────────
function setReply(msg){
  replyMsg=msg;cancelEdit();
  document.getElementById('reply-bar').style.display='flex';
  document.getElementById('reply-sender').textContent=msg.username+': ';
  document.getElementById('reply-preview').textContent=(msg.content||'').substring(0,80);
  document.getElementById('msg-input').focus();
}
function cancelReply(){replyMsg=null;document.getElementById('reply-bar').style.display='none';}

function setEdit(msg){
  editMsg=msg;cancelReply();
  document.getElementById('edit-bar').style.display='flex';
  const inp=document.getElementById('msg-input');
  inp.value=msg.content||'';inp.focus();autoResize(inp);
}
function cancelEdit(){editMsg=null;document.getElementById('edit-bar').style.display='none';document.getElementById('msg-input').value='';document.getElementById('msg-input').style.height='auto';}

// ── CONTEXT MENU ─────────────────────────────────────────────────────────────
function showCtx(x,y,isSelf){
  const m=document.getElementById('ctx');
  document.getElementById('ctx-edit').style.display=isSelf?'flex':'none';
  document.getElementById('ctx-del').style.display=isSelf?'flex':'none';
  m.style.display='block';
  m.style.left=Math.min(x,window.innerWidth-190)+'px';
  m.style.top =Math.min(y,window.innerHeight-240)+'px';
}
function hideCtx(){document.getElementById('ctx').style.display='none';}
document.addEventListener('click',hideCtx);
document.addEventListener('touchstart',hideCtx);

function ctxDo(action){
  if(!ctxMsg) return;
  hideCtx();
  switch(action){
    case 'reply': setReply(ctxMsg); break;
    case 'react': openModal('m-react'); break;
    case 'copy':  navigator.clipboard.writeText(ctxMsg.content||''); break;
    case 'save':  saveMessage(ctxMsg); break;
    case 'edit':  setEdit(ctxMsg); break;
    case 'forward': forwardMessage(ctxMsg); break;
    case 'delete':
      if(confirm('Удалить сообщение?')){
        const d={msgId:ctxMsg.id,type:target.type,to:target.id,chId:target.id};
        socket.emit('delete_msg',d);
      }
      break;
  }
}

async function saveMessage(msg){
  await fetch('/api/saved',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:me.id,content:msg.content||''})});
  showToast('Сообщение сохранено 📌');
}
function forwardMessage(msg){
  // Simple forward: paste [fwd:...] to current input
  document.getElementById('msg-input').value=`[fwd:${msg.content}]`;
  document.getElementById('msg-input').focus();
}

// ── SEARCH IN MESSAGES ────────────────────────────────────────────────────────
function toggleSearchPanel(){
  const p=document.getElementById('search-panel');
  p.style.display=p.style.display==='none'?'block':'none';
  if(p.style.display==='block') document.getElementById('msg-srch').focus();
}
function searchMessages(q){
  const res=document.getElementById('msg-srch-res');
  res.innerHTML='';
  if(!q.trim()) return;
  const ql=q.toLowerCase();
  let count=0;
  msgMap.forEach((entry,id)=>{
    const c=entry.data.content||'';
    if(c.toLowerCase().includes(ql)){
      count++;
      const div=document.createElement('div');
      div.style='padding:6px 8px;border-radius:var(--r8);cursor:pointer;font-size:13px;color:var(--t2)';
      div.textContent=`${entry.data.username}: ${c.substring(0,80)}`;
      div.onmouseover=()=>div.style.background='var(--c3)';
      div.onmouseout=()=>div.style.background='';
      div.onclick=()=>{entry.el.scrollIntoView({behavior:'smooth',block:'center'});entry.el.style.outline='2px solid var(--p)';setTimeout(()=>entry.el.style.outline='',1500);};
      res.appendChild(div);
    }
  });
  if(!count) res.innerHTML='<div style="color:var(--t4);font-size:12px;padding:6px">Не найдено</div>';
}

// ── PROFILE ───────────────────────────────────────────────────────────────────
function openProfileModal(){
  document.getElementById('p-ava-url').value=me.avatar_url||'';
  document.getElementById('p-bio').value=me.bio||'';
  document.getElementById('p-age').value=me.age||'';
  document.getElementById('p-status').value=me.status_text||'';
  document.getElementById('p-username').value=me.username||'';
  document.getElementById('p-oldpass').value='';
  document.getElementById('p-newpass').value='';
  setAva(document.getElementById('p-ava-big'),me.avatar_url,me.username);
  // Highlight selected status
  document.querySelectorAll('.status-opt').forEach(el=>{
    el.classList.toggle('sel',el.dataset.v===me.status_text);
  });
  openModal('m-profile');
}

function setupStatusOpts(){
  document.querySelectorAll('.status-opt').forEach(el=>{
    el.onclick=()=>{
      document.querySelectorAll('.status-opt').forEach(x=>x.classList.remove('sel'));
      el.classList.add('sel');
      document.getElementById('p-status').value=el.dataset.v;
    };
  });
}

function handleAvaPick(e){
  const file=e.target.files[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=ev=>{
    document.getElementById('p-ava-url').value=ev.target.result;
    const big=document.getElementById('p-ava-big');
    big.style.backgroundImage=`url('${ev.target.result}')`;big.textContent='';
  };
  reader.readAsDataURL(file);
}

async function saveProfile(){
  const avatar_url=document.getElementById('p-ava-url').value.trim()||null;
  const bio=document.getElementById('p-bio').value.trim()||null;
  const age=document.getElementById('p-age').value.trim()||null;
  const status_text=document.getElementById('p-status').value.trim()||null;
  try{
    const r=await fetch('/api/users/profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:me.id,avatar_url,bio,age,status_text})});
    const d=await r.json();
    if(!r.ok){alert(d.error||'Ошибка');return;}
    me=d.user;
    localStorage.setItem('ego_me',JSON.stringify(me));
    updateUserCard();
    closeModal('m-profile');
    showToast('Профиль сохранён ✓');
  }catch(e){alert('Ошибка сети');}
}

async function changePassword(){
  const op=document.getElementById('p-oldpass').value.trim();
  const np=document.getElementById('p-newpass').value.trim();
  if(!op||!np){alert('Заполните оба поля');return;}
  const r=await fetch('/api/users/change-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:me.id,oldPassword:op,newPassword:np})});
  const d=await r.json();
  if(!r.ok){alert(d.error);return;}
  alert('Пароль изменён!');
  document.getElementById('p-oldpass').value='';document.getElementById('p-newpass').value='';
}

// ── SEARCH USERS ─────────────────────────────────────────────────────────────
async function doSearch(q){
  const res=document.getElementById('srch-res');
  if(!q.trim()){res.innerHTML='';return;}
  try{
    const r=await fetch(`/api/users/search?query=${encodeURIComponent(q)}&currentUserId=${me.id}`);
    const users=await r.json();
    res.innerHTML='';
    if(!users.length){res.innerHTML='<div style="padding:10px 12px;color:var(--t4);font-size:12px">Не найдено</div>';return;}
    users.forEach(u=>{
      const div=document.createElement('div');
      div.className='ni';div.style.justifyContent='space-between';
      const ava=document.createElement('div');ava.className='ava';setAva(ava,u.avatar_url,u.username);
      const name=document.createElement('div');
      name.className='ni-name';name.innerHTML=esc(u.username)+(u.is_verified?'<span class="vbadge">✓</span>':'');
      const add=document.createElement('div');
      add.style='font-size:11px;font-weight:800;color:var(--a);background:rgba(34,211,238,.12);padding:2px 8px;border-radius:var(--r99);white-space:nowrap;cursor:pointer';
      add.textContent='+ Добавить';
      div.appendChild(ava);div.appendChild(name);div.appendChild(add);
      div.onclick=async()=>{
        await fetch('/api/contacts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:me.id,contactId:u.id})});
        document.getElementById('srch-inp').value='';res.innerHTML='';
        loadContacts();showToast(`@${u.username} добавлен в контакты`);
      };
      res.appendChild(div);
    });
  }catch(e){}
}

// ── SAVED MESSAGES ────────────────────────────────────────────────────────────
async function openSaved(){
  try{
    const r=await fetch(`/api/saved/${me.id}`);
    const items=await r.json();
    const list=document.getElementById('saved-list');
    list.innerHTML='';
    if(!items.length){list.innerHTML='<div style="color:var(--t4);font-size:13px;text-align:center;padding:20px">Ничего не сохранено</div>';return;}
    items.forEach(item=>{
      const div=document.createElement('div');
      div.className='saved-item';
      div.innerHTML=`<div>${esc(item.content.substring(0,120))}</div><div class="saved-item-time">${new Date(item.saved_at).toLocaleString('ru')}</div>`;
      list.appendChild(div);
    });
    openModal('m-saved');
  }catch(e){}
}

// ── WALLPAPERS ────────────────────────────────────────────────────────────────
const WP=[
  {cls:'wp-0',label:'Тёмный'},
  {cls:'wp-1',label:'Точки'},
  {cls:'wp-2',label:'Сетка'},
  {cls:'wp-3',label:'Лес'},
  {cls:'wp-4',label:'Фиолет'},
  {cls:'wp-5',label:'Синий'},
  {cls:'wp-6',label:'Красный'},
  {cls:'wp-7',label:'Neon'},
  {cls:'wp-8',label:'Glow'},
  {cls:'wp-9',label:'Noir'},
  {cls:'wp-10',label:'Obsidian'},
];
function buildWpGrid(){
  const g=document.getElementById('wp-grid');
  g.innerHTML='';
  WP.forEach(w=>{
    const d=document.createElement('div');
    d.className=`wp-tile ${w.cls} ${localStorage.getItem('ego_wp')===w.cls?'sel':''}`;
    d.innerHTML=`<label>${w.label}</label>`;
    d.onclick=()=>{setWp(w.cls);document.querySelectorAll('.wp-tile').forEach(t=>t.classList.remove('sel'));d.classList.add('sel');};
    g.appendChild(d);
  });
}
function setWp(cls){const vp=document.getElementById('msgs');vp.className='msgs '+cls;localStorage.setItem('ego_wp',cls);}

// ── EMOJI PICKER ─────────────────────────────────────────────────────────────
const EMOJI_CATS={
  '😀 Смайлы':['😀','😂','😍','🥺','😎','🤣','😅','😊','😜','🤩','😢','😡','🤔','😴','🤗','😬','🥳','😱','🤯','😷'],
  '👍 Жесты':['👍','👎','🙏','👏','✌️','🤝','💪','🫶','🤜','🤛','☝️','🖐','👋','🤙','💅'],
  '❤️ Сердца':['❤️','🧡','💛','💚','💙','💜','🖤','🤍','💕','💞','💗','💓','💘','❣️'],
  '🔥 Символы':['🔥','⭐','✅','❌','💯','🎉','🚀','💎','🎵','🎮','🍕','💀','☠️','👀','🌈'],
};
function buildEmojiPicker(){
  const p=document.getElementById('emoji-popup');
  p.innerHTML='';
  Object.entries(EMOJI_CATS).forEach(([cat,ems])=>{
    const cl=document.createElement('div');cl.className='ep-cat';cl.textContent=cat;p.appendChild(cl);
    ems.forEach(em=>{
      const d=document.createElement('span');d.className='ep-em';d.textContent=em;
      d.onclick=()=>{const inp=document.getElementById('msg-input');inp.value+=em;inp.focus();toggleEmoji(false);};
      p.appendChild(d);
    });
  });
}
let emojiOpen=false;
function toggleEmoji(force){
  emojiOpen=force!==undefined?force:!emojiOpen;
  document.getElementById('emoji-popup').style.display=emojiOpen?'flex':'none';
}

// Build reaction picker
const REACTS=['❤️','😂','🔥','👍','😮','😢','😡','👎','💯','🎉','⭐','🚀','💎','🤔','💪','🤝','🥺','😎','😍','🙏','👀'];
function buildReactGrid(){
  const g=document.getElementById('react-grid');g.innerHTML='';
  REACTS.forEach(em=>{
    const d=document.createElement('span');d.className='rp-em';d.textContent=em;
    d.onclick=()=>{
      if(!ctxMsg) return;
      socket.emit('react',{msgId:ctxMsg.id,from:me.id,emoji:em,type:target.type,to:target.id,chId:target.id});
      closeModal('m-react');
    };
    g.appendChild(d);
  });
}

// ── VIDEO NOTE ────────────────────────────────────────────────────────────────
async function openVnoteModal(){
  try{
    vnStream=await navigator.mediaDevices.getUserMedia({video:{width:360,height:360,facingMode:'user'},audio:true});
    document.getElementById('vn-prev').srcObject=vnStream;
    openModal('m-vnote');
  }catch(e){alert('Нет доступа к камере или микрофону');}
}
function getMime(types){return types.find(t=>MediaRecorder.isTypeSupported(t))||'';}
function startVnote(){
  vnChunks=[];
  const mime=getMime(['video/webm;codecs=vp8,opus','video/webm;codecs=vp9,opus','video/webm','video/mp4']);
  try{vnRec=new MediaRecorder(vnStream,mime?{mimeType:mime}:{});}
  catch{vnRec=new MediaRecorder(vnStream);}
  vnRec.ondataavailable=e=>{if(e.data&&e.data.size>0)vnChunks.push(e.data);};
  vnRec.onstop=sendVnote;vnRec.start(100);
  document.getElementById('vn-start').style.display='none';
  document.getElementById('vn-stop').style.display='inline-flex';
  document.getElementById('rec-badge').style.display='flex';
  vnSec=0;
  vnTimer=setInterval(()=>{vnSec++;document.getElementById('vn-timer').textContent=fmtSec(vnSec);if(vnSec>=60)stopVnote();},1000);
}
function stopVnote(){if(vnRec&&vnRec.state!=='inactive')vnRec.stop();clearInterval(vnTimer);}
async function sendVnote(){
  const blob=new Blob(vnChunks,{type:vnRec?.mimeType||'video/webm'});
  try{
    const fd=new FormData();
    fd.append('video', blob, `vnote_${Date.now()}.webm`);
    const res=await fetch('/api/upload/videonote',{method:'POST',body:fd});
    const data=await res.json();
    if(!res.ok) throw new Error(data.error||'Upload failed');
    emitMsg(`[vnote:${data.url}]`,{messageType:'videonote'});
  }catch(e){
    alert('Не удалось отправить видеокружочек');
    console.error(e);
  }
  closeVnoteModal();
}
function closeVnoteModal(){
  if(vnStream){vnStream.getTracks().forEach(t=>t.stop());vnStream=null;}
  clearInterval(vnTimer);vnChunks=[];
  document.getElementById('vn-start').style.display='inline-flex';
  document.getElementById('vn-stop').style.display='none';
  document.getElementById('rec-badge').style.display='none';
  document.getElementById('vn-timer').textContent='00:00';
  closeModal('m-vnote');
}

// ── VOICE MESSAGE ─────────────────────────────────────────────────────────────
async function openVoiceModal(){
  openModal('m-voice');
}
async function startVoice(){
  try{
    vrStream=await navigator.mediaDevices.getUserMedia({audio:true});
  }catch(e){alert('Нет доступа к микрофону');return;}
  vrChunks=[];
  const mime=getMime(['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/ogg','audio/mp4']);
  try{vrRec=new MediaRecorder(vrStream,mime?{mimeType:mime}:{});}
  catch{vrRec=new MediaRecorder(vrStream);}
  vrRec.ondataavailable=e=>{if(e.data&&e.data.size>0)vrChunks.push(e.data);};
  vrRec.onstop=sendVoice;vrRec.start(100);
  document.getElementById('vr-start-btn').style.display='none';
  document.getElementById('vr-stop-btn').style.display='flex';
  vrSec=0;
  vrTimer=setInterval(()=>{vrSec++;document.getElementById('vr-timer').textContent=fmtSec(vrSec);},1000);
}
function stopVoice(){if(vrRec&&vrRec.state!=='inactive')vrRec.stop();clearInterval(vrTimer);}
async function sendVoice(){
  const blob=new Blob(vrChunks,{type:vrRec?.mimeType||'audio/webm'});
  if(vrStream){vrStream.getTracks().forEach(t=>t.stop());vrStream=null;}
  try{
    const fd=new FormData();
    fd.append('audio', blob, `voice_${Date.now()}.webm`);
    const res=await fetch('/api/upload/voice',{method:'POST',body:fd});
    const data=await res.json();
    if(!res.ok) throw new Error(data.error||'Upload failed');
    emitMsg(`[voice:${data.url}]`,{voice_dur:fmtSec(vrSec),messageType:'voice'});
  }catch(e){
    alert('Не удалось отправить голосовое сообщение');
    console.error(e);
  }
  closeVoiceModal();
}
function closeVoiceModal(){
  if(vrStream){vrStream.getTracks().forEach(t=>t.stop());vrStream=null;}
  clearInterval(vrTimer);vrChunks=[];
  document.getElementById('vr-start-btn').style.display='flex';
  document.getElementById('vr-stop-btn').style.display='none';
  document.getElementById('vr-timer').textContent='00:00';
  closeModal('m-voice');
}

function emitMsg(content,extra={}){
  if(!socket||!target.id) return;
  const payload=buildMessagePayload(content, extra);
  socket.emit('send_message', payload);
}

// ── WEBRTC CALLS ─────────────────────────────────────────────────────────────
function setupWebRTCEvents(){
  if(!socket) return;

  socket.on('call_incoming',d=>{
    incomingCall=d;
    const ava=document.getElementById('ci-ava');
    setAva(ava,d.callerAvatar,d.callerUsername);
    document.getElementById('ci-name').textContent=d.callerUsername;
    document.getElementById('ci-type').textContent=d.isVideo?'📹 Видеозвонок':'📞 Аудиозвонок';
    openModal('m-call-in');
    playRingSound();
  });

  socket.on('call_answered',async d=>{
    if(!pc||!d.answer) return;
    try{
      await pc.setRemoteDescription(new RTCSessionDescription(d.answer));
      await flushIceQueue();
      document.getElementById('ca-status').textContent='Соединено ✅';
    }catch(e){ console.warn('call_answered', e); }
  });

  socket.on('call_rejected',d=>{
    stopRing();
    alert(d?.reason==='offline'?'Пользователь не в сети':'Вызов отклонён');
    endCall();
  });

  socket.on('ice_candidate',async d=>{
    if(!pc||!d.candidate) return;
    if(pc.remoteDescription){
      try{ await pc.addIceCandidate(new RTCIceCandidate(d.candidate)); }
      catch(e){ console.warn('ICE error', e); }
    }else{
      iceQueue.push(d.candidate);
    }
  });

  socket.on('call_ended',()=> endCall());
}

async function flushIceQueue(){
  if(!pc||!pc.remoteDescription) return;
  while(iceQueue.length){
    const candidate = iceQueue.shift();
    try{ await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch(e){ console.warn('ICE flush', e); }
  }
}

function setCallVideoUI(isVideo){
  callIsVideo = isVideo;
  const localV = document.getElementById('localVideo');
  const localWrap = localV?.closest('.call-local');
  const camBtn = document.getElementById('btn-cam');
  if(localWrap) localWrap.style.display = isVideo ? 'block' : 'none';
  if(camBtn) camBtn.style.display = isVideo ? 'inline-flex' : 'none';
}

async function startCall(isVideo){
  if(!target.id||target.type!=='dm'||!socket) return;
  callTarget=target.id;
  iceQueue=[];
  try{
    localStream=await navigator.mediaDevices.getUserMedia({audio:true,video:isVideo});
    document.getElementById('localVideo').srcObject=localStream;
    setCallVideoUI(isVideo);
    document.getElementById('ca-title').textContent=isVideo?'📹 Видеозвонок':'📞 Аудиозвонок';
    document.getElementById('ca-status').textContent='Вызов...';
    openModal('m-call-act');
    initPC();
    const offer=await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('call_user',{
      to:callTarget,
      from:me.id,
      callerUsername:me.username,
      callerAvatar:me.avatar_url,
      isVideo,
      offer
    });
  }catch(e){alert('Нет доступа к медиаустройствам');}
}

async function acceptCall(){
  if(!incomingCall||!socket) return;
  stopRing();
  closeModal('m-call-in');
  callTarget=incomingCall.from;
  iceQueue=[];
  try{
    localStream=await navigator.mediaDevices.getUserMedia({audio:true,video:!!incomingCall.isVideo});
    document.getElementById('localVideo').srcObject=localStream;
    setCallVideoUI(!!incomingCall.isVideo);
    document.getElementById('ca-title').textContent=incomingCall.isVideo?'📹 Видеозвонок':'📞 Аудиозвонок';
    document.getElementById('ca-status').textContent='Соединение...';
    openModal('m-call-act');
    initPC();
    if(incomingCall.offer){
      await pc.setRemoteDescription(new RTCSessionDescription(incomingCall.offer));
      await flushIceQueue();
    }
    const answer=await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer_call',{to:callTarget,from:me.id,answer});
    document.getElementById('ca-status').textContent='Соединено ✅';
  }catch(e){alert('Нет доступа к устройствам');}
}

function rejectCall(){
  stopRing();
  if(incomingCall&&socket) socket.emit('call_reject',{to:incomingCall.from,from:me.id});
  closeModal('m-call-in');
  incomingCall=null;
}

function initPC(){
  if(pc) pc.close();
  iceQueue=[];
  pc=new RTCPeerConnection(rtcCfg);
  if(localStream) localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));
  pc.ontrack=e=>{
    const rv=document.getElementById('remoteVideo');
    if(rv&&e.streams[0]&&rv.srcObject!==e.streams[0]){
      rv.srcObject=e.streams[0];
      rv.play().catch(()=>{});
    }
  };
  pc.onicecandidate=e=>{
    if(e.candidate&&socket&&callTarget){
      socket.emit('ice_candidate',{to:callTarget,from:me.id,candidate:e.candidate});
    }
  };
  pc.onconnectionstatechange=()=>{
    const s=pc?.connectionState;
    if(s==='connected') document.getElementById('ca-status').textContent='Соединено ✅';
    if(s==='disconnected'||s==='failed') endCall();
  };
}

function endCall(){
  stopRing();
  if(pc){pc.close();pc=null;}
  if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null;}
  if(callTarget&&socket){socket.emit('end_call',{to:callTarget,from:me.id});}
  callTarget=null;
  incomingCall=null;
  iceQueue=[];
  closeModal('m-call-act');
  closeModal('m-call-in');
  callMuted=false;callCamOff=false;callIsVideo=false;
  const localV=document.getElementById('localVideo');
  const remoteV=document.getElementById('remoteVideo');
  if(localV) localV.srcObject=null;
  if(remoteV) remoteV.srcObject=null;
  setCallVideoUI(true);
  updateCallBtns();
}

function toggleMute(){
  if(!localStream) return;
  callMuted=!callMuted;
  localStream.getAudioTracks().forEach(t=>t.enabled=!callMuted);
  document.getElementById('btn-mute').textContent=callMuted?'🔇 Без звука':'🎙 Мут';
}
function toggleCamera(){
  if(!localStream) return;
  callCamOff=!callCamOff;
  localStream.getVideoTracks().forEach(t=>t.enabled=!callCamOff);
  document.getElementById('btn-cam').textContent=callCamOff?'📵 Камера выкл':'📷 Камера';
}
function updateCallBtns(){}

// ── MODAL SYSTEM ──────────────────────────────────────────────────────────────
function openModal(id){
  document.getElementById(id).classList.add('open');
  if(id==='m-react') buildReactGrid();
}
function closeModal(id){const el=document.getElementById(id);if(el)el.classList.remove('open');}
document.querySelectorAll('.mo').forEach(el=>{el.addEventListener('click',e=>{if(e.target===el)closeModal(el.id);});});

// ── MOBILE ────────────────────────────────────────────────────────────────────
function hideSidebar(){if(window.innerWidth<=768)document.getElementById('sidebar').classList.add('hidden');}
function showSidebar(){document.getElementById('sidebar').classList.remove('hidden');}

// ── UTILS ─────────────────────────────────────────────────────────────────────
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function fmt(ts){return new Date(ts).toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'});}
function fmtSec(s){const m=Math.floor(s/60).toString().padStart(2,'0');const ss=(s%60).toString().padStart(2,'0');return `${m}:${ss}`;}
function autoResize(el){el.style.height='auto';el.style.height=Math.min(el.scrollHeight,130)+'px';}
function logout(){localStorage.removeItem('ego_me');localStorage.removeItem('ego_target');location.reload();}

// Toast notification
function showToast(msg){
  let t=document.getElementById('toast');
  if(!t){t=document.createElement('div');t.id='toast';t.style.cssText='position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:var(--c4);border:1px solid var(--b2);color:var(--t1);padding:8px 18px;border-radius:var(--r99);font-size:13px;font-weight:600;z-index:99999;box-shadow:var(--sh-sm);transition:opacity .3s';document.body.appendChild(t);}
  t.textContent=msg;t.style.opacity='1';
  clearTimeout(t._timer);t._timer=setTimeout(()=>{t.style.opacity='0';},2500);
}

// Notification sound (simple beep via Web Audio)
let audioCtx=null;
function playNotifSound(){
  try{
    if(!audioCtx) audioCtx=new(window.AudioContext||window.webkitAudioContext)();
    const osc=audioCtx.createOscillator();
    const gain=audioCtx.createGain();
    osc.connect(gain);gain.connect(audioCtx.destination);
    osc.type='sine';osc.frequency.value=880;
    gain.gain.setValueAtTime(0.15,audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001,audioCtx.currentTime+0.3);
    osc.start();osc.stop(audioCtx.currentTime+0.3);
  }catch(e){}
}
function playRingSound(){
  stopRing();
  ringTimer=setInterval(()=>{
    try{
      if(!audioCtx) audioCtx=new(window.AudioContext||window.webkitAudioContext)();
      const osc=audioCtx.createOscillator();
      const gain=audioCtx.createGain();
      osc.connect(gain);gain.connect(audioCtx.destination);
      osc.type='sine';osc.frequency.value=660;
      gain.gain.setValueAtTime(0.2,audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001,audioCtx.currentTime+0.5);
      osc.start();osc.stop(audioCtx.currentTime+0.5);
    }catch(e){}
  },1200);
}
function stopRing(){
  if(ringTimer){clearInterval(ringTimer);ringTimer=null;}
}
