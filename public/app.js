let socket = null;
let currentUser = null;
let activeChatUser = null; // Пользователь, с которым открыт чат

// WebRTC Переменные
let peerConnection = null;
let localStream = null;
let currentCallTarget = null;
let isVideoCall = false;

const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

// ══════════════════════════════ 1. АВТОРИЗАЦИЯ ══════════════════════════════

let isLoginMode = true;

function switchAuthTab(mode) {
  isLoginMode = mode === 'login';
  document.getElementById('loginTabBtn').classList.toggle('active', isLoginMode);
  document.getElementById('regTabBtn').classList.toggle('active', !isLoginMode);
  document.getElementById('authEmail').style.display = isLoginMode ? 'none' : 'block';
  document.getElementById('authSubmitBtn').innerText = isLoginMode ? 'Войти' : 'Зарегистрироваться';
}

async function handleAuth(e) {
  e.preventDefault();
  const username = document.getElementById('authUsername').value;
  const password = document.getElementById('authPassword').value;
  const email = document.getElementById('authEmail').value;

  const endpoint = isLoginMode ? '/api/login' : '/api/register';
  const body = isLoginMode ? { username, password } : { username, email, password };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();

    if (!res.ok) return alert(data.error || 'Ошибка входа');

    currentUser = data.user;
    document.getElementById('authContainer').style.display = 'none';
    document.getElementById('appContainer').style.display = 'flex';
    document.getElementById('myUsername').innerText = currentUser.username;
    if (currentUser.avatar_url) document.getElementById('myAvatar').src = currentUser.avatar_url;

    initSocket();
    loadContacts();
  } catch (err) {
    alert('Ошибка сервера при авторизации');
  }
}

// ══════════════════════════════ 2. SOCKET.IO & ЧАТ ══════════════════════════

function initSocket() {
  socket = io({ path: '/socket.io/' });

  socket.on('connect', () => {
    socket.emit('user_connected', currentUser.id);
  });

  socket.on('receive_message', (msg) => {
    if (
      (activeChatUser && (msg.from === activeChatUser.id || msg.to === activeChatUser.id)) ||
      msg.from === currentUser.id
    ) {
      appendMessage(msg);
    }
  });

  // WebRTC Сигналинг
  socket.on('call_incoming', handleIncomingCall);
  socket.on('call_answered', handleCallAnswered);
  socket.on('ice_candidate', handleNewICECandidate);
  socket.on('call_ended', closeCallUI);
  socket.on('call_rejected', (data) => {
    alert('Вызов отклонен или пользователь оффлайн');
    closeCallUI();
  });
}

async function loadContacts() {
  const res = await fetch(`/api/contacts/${currentUser.id}`);
  const contacts = await res.json();
  const list = document.getElementById('contactsList');
  list.innerHTML = '';

  contacts.forEach(c => {
    const div = document.createElement('div');
    div.className = 'contact-item';
    div.innerText = c.nickname || c.username;
    div.onclick = () => openChat(c);
    list.appendChild(div);
  });
}

async function openChat(user) {
  activeChatUser = user;
  document.getElementById('chatHeader').style.display = 'flex';
  document.getElementById('chatFooter').style.display = 'flex';
  document.getElementById('chatUserName').innerText = user.username;
  document.getElementById('chatUserAvatar').src = user.avatar_url || '/uploads/avatars/default.png';

  document.getElementById('messagesContainer').innerHTML = '';

  const res = await fetch(`/api/messages/dm/${currentUser.id}/${user.id}`);
  const messages = await res.json();
  messages.forEach(appendMessage);
}

function appendMessage(msg) {
  const box = document.getElementById('messagesContainer');
  const div = document.createElement('div');
  div.className = `message ${msg.from === currentUser.id ? 'outgoing' : 'incoming'}`;

  if (msg.messageType === 'voice') {
    div.innerHTML = `<audio controls src="${msg.content}"></audio>`;
  } else if (msg.messageType === 'videonote') {
    div.innerHTML = `<video class="circle-video-msg" controls src="${msg.content}"></video>`;
  } else {
    div.innerText = msg.content;
  }

  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function sendMessage() {
  const input = document.getElementById('messageInput');
  const content = input.value.trim();
  if (!content || !activeChatUser) return;

  socket.emit('send_message', {
    from: currentUser.id,
    to: activeChatUser.id,
    type: 'dm',
    content: content,
    messageType: 'text'
  });

  input.value = '';
}

function handleKeyPress(e) {
  if (e.key === 'Enter') sendMessage();
}

async function searchUsers(q) {
  if (!q.trim()) return document.getElementById('searchResults').innerHTML = '';
  const res = await fetch(`/api/users/search?query=${q}&currentUserId=${currentUser.id}`);
  const users = await res.json();
  const resDiv = document.getElementById('searchResults');
  resDiv.innerHTML = '';

  users.forEach(u => {
    const d = document.createElement('div');
    d.innerText = u.username;
    d.onclick = async () => {
      await fetch('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser.id, contactId: u.id })
      });
      loadContacts();
      openChat(u);
      resDiv.innerHTML = '';
    };
    resDiv.appendChild(d);
  });
}

// ══════════════════════════════ 3. WebRTC ЗВОНКИ ══════════════════════════════

async function startCall(video) {
  if (!activeChatUser) return;
  isVideoCall = video;
  currentCallTarget = activeChatUser.id;

  setupWebRTC();
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: isVideoCall });
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  document.getElementById('localVideo').srcObject = localStream;
  document.getElementById('activeCallScreen').style.display = 'flex';

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  socket.emit('call_user', {
    to: currentCallTarget,
    callerUsername: currentUser.username,
    callerAvatar: currentUser.avatar_url,
    isVideo: isVideoCall,
    offer: offer
  });
}

let incomingOfferData = null;

function handleIncomingCall(data) {
  incomingOfferData = data;
  document.getElementById('callerName').innerText = `${data.callerUsername} вызывает...`;
  document.getElementById('callerAvatar').src = data.callerAvatar || '/uploads/avatars/default.png';
  document.getElementById('incomingCallModal').style.display = 'flex';
}

async function acceptCall() {
  document.getElementById('incomingCallModal').style.display = 'none';
  currentCallTarget = incomingOfferData.from;
  isVideoCall = incomingOfferData.isVideo;

  setupWebRTC();
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: isVideoCall });
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  document.getElementById('localVideo').srcObject = localStream;
  document.getElementById('activeCallScreen').style.display = 'flex';

  await peerConnection.setRemoteDescription(new RTCSessionDescription(incomingOfferData.offer));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);

  socket.emit('answer_call', { to: currentCallTarget, answer: answer });
}

function rejectCall() {
  document.getElementById('incomingCallModal').style.display = 'none';
  socket.emit('call_reject', { to: incomingOfferData.from });
}

async function handleCallAnswered(data) {
  await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
}

function setupWebRTC() {
  peerConnection = new RTCPeerConnection(rtcConfig);

  peerConnection.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('ice_candidate', { to: currentCallTarget, candidate: e.candidate });
    }
  };

  peerConnection.ontrack = (e) => {
    document.getElementById('remoteVideo').srcObject = e.streams[0];
  };
}

function handleNewICECandidate(data) {
  if (peerConnection) {
    peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
  }
}

function endCall() {
  socket.emit('end_call', { to: currentCallTarget });
  closeCallUI();
}

function closeCallUI() {
  if (peerConnection) peerConnection.close();
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  peerConnection = null;
  localStream = null;

  document.getElementById('activeCallScreen').style.display = 'none';
  document.getElementById('incomingCallModal').style.display = 'none';
}

// ════════════════════════ 4. ГОЛОСОВЫЕ И КРУЖОЧКИ ════════════════════════

let mediaRecorder = null;
let audioChunks = [];

// Запись Voice
document.getElementById('voiceBtn').addEventListener('click', async () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    document.getElementById('voiceBtn').classList.remove('recording');
    return;
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaRecorder = new MediaRecorder(stream);
  audioChunks = [];

  mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
  mediaRecorder.onstop = async () => {
    const blob = new Blob(audioChunks, { type: 'audio/webm' });
    const formData = new FormData();
    formData.append('audio', blob, 'voice.webm');

    const res = await fetch('/api/upload/voice', { method: 'POST', body: formData });
    const data = await res.json();

    if (data.url && activeChatUser) {
      socket.emit('send_message', {
        from: currentUser.id,
        to: activeChatUser.id,
        type: 'dm',
        content: data.url,
        messageType: 'voice'
      });
    }
    stream.getTracks().forEach(t => t.stop());
  };

  mediaRecorder.start();
  document.getElementById('voiceBtn').classList.add('recording');
});

// Запись Видео-Кружочка
document.getElementById('videoNoteBtn').addEventListener('click', async () => {
  const modal = document.getElementById('videoNoteModal');
  const preview = document.getElementById('videoNotePreview');
  modal.style.display = 'flex';

  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  preview.srcObject = stream;

  let vRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
  let chunks = [];

  vRecorder.ondataavailable = e => chunks.push(e.data);
  vRecorder.onstop = async () => {
    const blob = new Blob(chunks, { type: 'video/webm' });
    const formData = new FormData();
    formData.append('video', blob, 'note.webm');

    const res = await fetch('/api/upload/videonote', { method: 'POST', body: formData });
    const data = await res.json();

    if (data.url && activeChatUser) {
      socket.emit('send_message', {
        from: currentUser.id,
        to: activeChatUser.id,
        type: 'dm',
        content: data.url,
        messageType: 'videonote'
      });
    }
    stream.getTracks().forEach(t => t.stop());
    modal.style.display = 'none';
  };

  vRecorder.start();

  document.getElementById('stopVideoNoteBtn').onclick = () => {
    vRecorder.stop();
  };
});
