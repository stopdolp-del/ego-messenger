let socket = null;
let currentUser = null;
let activeView = 'dm'; // 'dm' or 'server'
let activeServerId = null;
let activeChannelId = null;
let activeContactId = null;
let statusCheckInterval = null;

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  const savedUser = localStorage.getItem('messenger_user');
  if (savedUser) {
    currentUser = JSON.parse(savedUser);
    initAppSession();
  }
});

// Auth Tab Switcher
function switchAuthTab(tab) {
  const loginForm = document.getElementById('login-form');
  const regForm = document.getElementById('register-form');
  const loginBtn = document.getElementById('tab-login-btn');
  const regBtn = document.getElementById('tab-register-btn');

  if (tab === 'login') {
    loginForm.style.display = 'block';
    regForm.style.display = 'none';
    loginBtn.classList.add('active');
    regBtn.classList.remove('active');
  } else {
    loginForm.style.display = 'none';
    regForm.style.display = 'block';
    loginBtn.classList.remove('active');
    regBtn.classList.add('active');
  }
}

// User Registration Handler
async function handleRegister(e) {
  e.preventDefault();
  const username = document.getElementById('reg-username').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const errorDiv = document.getElementById('reg-error');
  errorDiv.style.display = 'none';

  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password })
    });
    const data = await res.json();

    if (!res.ok) {
      errorDiv.innerText = data.error || 'Ошибка регистрации';
      errorDiv.style.display = 'block';
      return;
    }

    currentUser = data.user;
    localStorage.setItem('messenger_user', JSON.stringify(currentUser));
    initAppSession();
  } catch (err) {
    errorDiv.innerText = 'Сервер недоступен. Проверьте запуск сервера в CMD.';
    errorDiv.style.display = 'block';
  }
}

// User Login Handler
async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errorDiv = document.getElementById('login-error');
  errorDiv.style.display = 'none';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (!res.ok) {
      if (data.is_banned) {
        showBannedOverlay();
        return;
      }
      errorDiv.innerText = data.error || 'Ошибка входа';
      errorDiv.style.display = 'block';
      return;
    }

    currentUser = data.user;
    localStorage.setItem('messenger_user', JSON.stringify(currentUser));
    initAppSession();
  } catch (err) {
    errorDiv.innerText = 'Сервер недоступен. Проверьте запуск сервера в CMD.';
    errorDiv.style.display = 'block';
  }
}

// Logout Handler
function handleLogout() {
  localStorage.removeItem('messenger_user');
  currentUser = null;
  if (socket) socket.disconnect();
  if (statusCheckInterval) clearInterval(statusCheckInterval);

  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('app-screen').style.display = 'none';
  document.getElementById('banned-overlay').style.display = 'none';
}

// Initialize Application Session & WebSockets
function initAppSession() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'flex';

  updateUserProfileUI();
  initSocketConnection();
  loadUserServers();
  loadUserContacts();

  // Periodic DB poll every 5 seconds to check if is_verified or is_banned changed in HeidiSQL
  if (statusCheckInterval) clearInterval(statusCheckInterval);
  statusCheckInterval = setInterval(checkUserStatusFromDB, 5000);
  checkUserStatusFromDB(); // Initial check
}

// Live DB check for is_banned & is_verified
async function checkUserStatusFromDB() {
  if (!currentUser) return;
  try {
    const res = await fetch(`/api/users/me/${currentUser.id}`);
    if (res.status === 403) {
      showBannedOverlay();
      return;
    }
    if (res.ok) {
      const dbUser = await res.json();
      if (dbUser.is_banned === 1) {
        showBannedOverlay();
        return;
      }
      // Update local verification flag if modified in HeidiSQL
      currentUser.is_verified = dbUser.is_verified;
      localStorage.setItem('messenger_user', JSON.stringify(currentUser));
      updateUserProfileUI();
      document.getElementById('banned-overlay').style.display = 'none';
    }
  } catch (err) {
    console.warn('Status check failed:', err);
  }
}

function showBannedOverlay() {
  document.getElementById('banned-overlay').style.display = 'flex';
}

function checkBanStatusAgain() {
  checkUserStatusFromDB();
}

// Render User Profile Footer
function updateUserProfileUI() {
  if (!currentUser) return;
  document.getElementById('current-username').innerHTML = renderUsernameWithBadge(currentUser.username, currentUser.is_verified);
  document.getElementById('user-avatar-initial').innerText = currentUser.username.charAt(0).toUpperCase();
}

// Helper to generate verified checkmark HTML
function renderUsernameWithBadge(username, isVerified) {
  const badgeHtml = (isVerified == 1 || isVerified === true) 
    ? `<span class="verified-badge" title="Подтвержденный профиль (is_verified = 1)">✓</span>` 
    : '';
  return `${escapeHTML(username)}${badgeHtml}`;
}

// WebSockets Connection
function initSocketConnection() {
  if (socket && socket.connected) return;

  socket = io();

  socket.on('connect', () => {
    console.log('[WEBSOCKET] Connected to server socket:', socket.id);
    socket.emit('user_connected', currentUser.id);
  });

  socket.on('user_banned', (data) => {
    showBannedOverlay();
  });

  socket.on('new_channel_message', (msg) => {
    if (activeView === 'server' && activeChannelId == msg.channel_id) {
      appendMessageToUI(msg);
    }
  });

  socket.on('new_dm_message', (msg) => {
    if (activeView === 'dm' && (activeContactId == msg.sender_id || activeContactId == msg.recipient_id)) {
      appendMessageToUI(msg);
    }
  });
}

// --- SERVER & CHANNEL MANAGEMENT ---

async function loadUserServers() {
  try {
    const res = await fetch(`/api/servers/user/${currentUser.id}`);
    const servers = await res.json();

    const listEl = document.getElementById('servers-list');
    listEl.innerHTML = '';

    servers.forEach(srv => {
      const srvEl = document.createElement('div');
      srvEl.className = `server-icon ${activeView === 'server' && activeServerId === srv.id ? 'active' : ''}`;
      srvEl.innerText = srv.name.charAt(0).toUpperCase();
      srvEl.title = srv.name;
      srvEl.onclick = () => selectServerView(srv);
      listEl.appendChild(srvEl);
    });
  } catch (err) {
    console.error('Failed to load servers:', err);
  }
}

function selectDMView() {
  activeView = 'dm';
  activeServerId = null;
  activeChannelId = null;
  
  // Highlight DM icon
  document.querySelectorAll('.server-icon').forEach(el => el.classList.remove('active'));
  document.querySelector('.dm-icon').classList.add('active');

  document.getElementById('sidebar-title').innerText = 'Сообщения';
  document.getElementById('channels-container').style.display = 'none';
  document.getElementById('contacts-container').style.display = 'block';

  resetChatPlaceholder('Выберите контакт из списка слева, чтобы начать переписку.');
  loadUserContacts();
}

function selectServerView(serverObj) {
  activeView = 'server';
  activeServerId = serverObj.id;
  activeContactId = null;

  // Highlight server icon
  document.querySelectorAll('.server-icon').forEach(el => el.classList.remove('active'));
  loadUserServers(); // re-render icons for active state

  document.getElementById('sidebar-title').innerText = serverObj.name;
  document.getElementById('channels-container').style.display = 'block';
  document.getElementById('contacts-container').style.display = 'none';

  loadServerChannels(serverObj.id);
  loadServerMembers(serverObj.id);
}

async function loadServerChannels(serverId) {
  try {
    const res = await fetch(`/api/servers/${serverId}/channels`);
    const channels = await res.json();

    const listEl = document.getElementById('channels-list');
    listEl.innerHTML = '';

    if (channels.length > 0) {
      channels.forEach((ch, idx) => {
        const item = document.createElement('div');
        item.className = `list-item ${activeChannelId === ch.id ? 'active' : ''}`;
        item.innerHTML = `<span class="list-item-icon">#</span> ${escapeHTML(ch.name)}`;
        item.onclick = () => selectChannel(ch);
        listEl.appendChild(item);

        // Auto select first channel if none selected
        if (idx === 0 && (!activeChannelId || !channels.some(c => c.id === activeChannelId))) {
          selectChannel(ch);
        }
      });
    } else {
      listEl.innerHTML = '<div class="section-title">Нет каналов</div>';
    }
  } catch (err) {
    console.error('Failed to load channels:', err);
  }
}

async function loadServerMembers(serverId) {
  try {
    const res = await fetch(`/api/servers/${serverId}/members`);
    const members = await res.json();

    const listEl = document.getElementById('members-list');
    listEl.innerHTML = '';

    members.forEach(mem => {
      const item = document.createElement('div');
      item.className = 'list-item';
      const roleBadge = mem.role === 'admin' ? '<span class="role-badge admin">Админ</span>' : '';
      item.innerHTML = `
        <span class="list-item-icon">👤</span> 
        ${renderUsernameWithBadge(mem.username, mem.is_verified)}
        ${roleBadge}
      `;
      listEl.appendChild(item);
    });
  } catch (err) {
    console.error('Failed to load server members:', err);
  }
}

function selectChannel(channelObj) {
  activeChannelId = channelObj.id;
  loadServerChannels(activeServerId); // update active class

  socket.emit('join_channel', channelObj.id);

  document.getElementById('chat-header-icon').innerText = '#';
  document.getElementById('chat-header-title').innerText = channelObj.name;
  document.getElementById('chat-header-badge').innerHTML = '';

  enableChatInput(true);
  loadChannelMessages(channelObj.id);
}

async function loadChannelMessages(channelId) {
  try {
    const res = await fetch(`/api/channels/${channelId}/messages`);
    const messages = await res.json();
    renderMessagesList(messages);
  } catch (err) {
    console.error('Failed to load channel messages:', err);
  }
}

// --- CONTACTS & DIRECT MESSAGES ---

async function loadUserContacts() {
  try {
    const res = await fetch(`/api/contacts/${currentUser.id}`);
    const contacts = await res.json();

    const listEl = document.getElementById('contacts-list');
    listEl.innerHTML = '';

    if (contacts.length === 0) {
      listEl.innerHTML = '<div class="section-title">Список контактов пуст. Нажмите +, чтобы найти пользователей.</div>';
      return;
    }

    contacts.forEach(contact => {
      const item = document.createElement('div');
      item.className = `list-item ${activeContactId === contact.id ? 'active' : ''}`;
      item.innerHTML = `
        <span class="list-item-icon">💬</span>
        ${renderUsernameWithBadge(contact.username, contact.is_verified)}
      `;
      item.onclick = () => selectContactDM(contact);
      listEl.appendChild(item);
    });
  } catch (err) {
    console.error('Failed to load contacts:', err);
  }
}

function selectContactDM(contactObj) {
  activeContactId = contactObj.id;
  loadUserContacts(); // update active state

  document.getElementById('chat-header-icon').innerText = '💬';
  document.getElementById('chat-header-title').innerText = contactObj.username;
  document.getElementById('chat-header-badge').innerHTML = renderUsernameWithBadge('', contactObj.is_verified);

  enableChatInput(true);
  loadDMMessages(contactObj.id);
}

async function loadDMMessages(contactId) {
  try {
    const res = await fetch(`/api/dms/${currentUser.id}/${contactId}`);
    const messages = await res.json();
    renderMessagesList(messages);
  } catch (err) {
    console.error('Failed to load DM messages:', err);
  }
}

// --- SENDING MESSAGES ---

function handleSendMessage(e) {
  e.preventDefault();
  const inputEl = document.getElementById('message-input');
  const content = inputEl.value.trim();
  if (!content) return;

  if (activeView === 'server' && activeChannelId) {
    socket.emit('send_channel_message', {
      channelId: activeChannelId,
      senderId: currentUser.id,
      content: content
    });
  } else if (activeView === 'dm' && activeContactId) {
    socket.emit('send_dm_message', {
      senderId: currentUser.id,
      recipientId: activeContactId,
      content: content
    });
  }

  inputEl.value = '';
}

// --- RENDER MESSAGES IN CHAT ---

function renderMessagesList(messages) {
  const container = document.getElementById('messages-list');
  const placeholder = document.getElementById('chat-placeholder');

  placeholder.style.display = 'none';
  container.innerHTML = '';

  messages.forEach(msg => {
    appendMessageToUI(msg);
  });

  scrollChatToBottom();
}

function appendMessageToUI(msg) {
  const container = document.getElementById('messages-list');
  const placeholder = document.getElementById('chat-placeholder');
  placeholder.style.display = 'none';

  const isOwn = msg.sender_id === currentUser.id;
  const msgEl = document.createElement('div');
  msgEl.className = `message-item ${isOwn ? 'own' : ''}`;

  const initial = (msg.username || 'U').charAt(0).toUpperCase();
  const timeStr = new Date(msg.created_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  msgEl.innerHTML = `
    <div class="message-avatar">${initial}</div>
    <div class="message-content-wrapper">
      <div class="message-meta">
        <span class="message-author">${renderUsernameWithBadge(msg.username || 'User', msg.is_verified)}</span>
        <span class="message-time">${timeStr}</span>
      </div>
      <div class="message-text">${escapeHTML(msg.content)}</div>
    </div>
  `;

  container.appendChild(msgEl);
  scrollChatToBottom();
}

function scrollChatToBottom() {
  const chatContainer = document.getElementById('messages-container');
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function enableChatInput(enabled) {
  document.getElementById('message-input').disabled = !enabled;
  document.getElementById('send-btn').disabled = !enabled;
}

function resetChatPlaceholder(text) {
  document.getElementById('messages-list').innerHTML = '';
  document.getElementById('chat-placeholder').style.display = 'block';
  document.getElementById('chat-header-title').innerText = 'Выберите чат';
  document.getElementById('chat-header-badge').innerHTML = '';
  enableChatInput(false);
}

// --- MODALS & SEARCH ---

function handleSubAddClick() {
  if (activeView === 'server') {
    openModal('add-channel-modal');
  } else {
    openModal('add-contact-modal');
  }
}

function openModal(id) {
  document.getElementById(id).style.display = 'flex';
}

function closeModal(id) {
  document.getElementById(id).style.display = 'none';
}

async function handleCreateServer() {
  const nameInput = document.getElementById('server-name-input');
  const name = nameInput.value.trim();
  if (!name) return;

  try {
    const res = await fetch('/api/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ownerId: currentUser.id })
    });

    if (res.ok) {
      const serverObj = await res.json();
      nameInput.value = '';
      closeModal('add-server-modal');
      await loadUserServers();
      selectServerView(serverObj);
    } else {
      const err = await res.json();
      alert(err.error || 'Ошибка создания сервера');
    }
  } catch (err) {
    alert('Не удалось создать сервер');
  }
}

async function handleCreateChannel() {
  const nameInput = document.getElementById('channel-name-input');
  const name = nameInput.value.trim();
  if (!name || !activeServerId) return;

  try {
    const res = await fetch(`/api/servers/${activeServerId}/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, userId: currentUser.id })
    });

    if (res.ok) {
      nameInput.value = '';
      closeModal('add-channel-modal');
      loadServerChannels(activeServerId);
    } else {
      const err = await res.json();
      alert(err.error || 'Ошибка создания канала');
    }
  } catch (err) {
    alert('Не удалось создать канал');
  }
}

let searchTimeout = null;
function handleSearchUsers(query) {
  clearTimeout(searchTimeout);
  if (!query.trim()) {
    document.getElementById('search-results-list').innerHTML = '';
    return;
  }

  searchTimeout = setTimeout(async () => {
    try {
      const res = await fetch(`/api/users/search?query=${encodeURIComponent(query)}&currentUserId=${currentUser.id}`);
      const users = await res.json();

      const resultsEl = document.getElementById('search-results-list');
      resultsEl.innerHTML = '';

      if (users.length === 0) {
        resultsEl.innerHTML = '<div class="section-title">Пользователи не найдены</div>';
        return;
      }

      users.forEach(u => {
        const item = document.createElement('div');
        item.className = 'search-item';
        item.innerHTML = `
          <span>${renderUsernameWithBadge(u.username, u.is_verified)}</span>
          <button class="btn btn-primary" style="width: auto; padding: 4px 10px; font-size: 12px;" onclick="handleAddContact(${u.id})">Добавить</button>
        `;
        resultsEl.appendChild(item);
      });
    } catch (err) {
      console.error('Search failed:', err);
    }
  }, 300);
}

async function handleAddContact(contactId) {
  try {
    const res = await fetch('/api/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser.id, contactId })
    });

    if (res.ok) {
      closeModal('add-contact-modal');
      loadUserContacts();
    }
  } catch (err) {
    alert('Ошибка добавления контакта');
  }
}

function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}
