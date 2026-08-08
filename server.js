require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

app.set('trust proxy', 1);

const io = new Server(server, {
  maxHttpBufferSize: 100 * 1024 * 1024,
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  allowEIO3: true
});

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

const mkDir = (d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
};
mkDir(path.join(__dirname, 'uploads', 'avatars'));
mkDir(path.join(__dirname, 'uploads', 'voice'));
mkDir(path.join(__dirname, 'uploads', 'videonotes'));

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads', 'avatars')),
  filename: (req, file, cb) => cb(null, `ava_${uuidv4()}${path.extname(file.originalname)}`)
});
const uploadAvatar = multer({ storage: avatarStorage, limits: { fileSize: 10 * 1024 * 1024 } });

const voiceStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads', 'voice')),
  filename: (req, file, cb) => cb(null, `voice_${uuidv4()}${path.extname(file.originalname) || '.webm'}`)
});
const uploadVoice = multer({ storage: voiceStorage, limits: { fileSize: 25 * 1024 * 1024 } });

const videoNoteStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads', 'videonotes')),
  filename: (req, file, cb) => cb(null, `vnote_${uuidv4()}${path.extname(file.originalname) || '.webm'}`)
});
const uploadVideoNote = multer({ storage: videoNoteStorage, limits: { fileSize: 50 * 1024 * 1024 } });

let pool;

async function initDB() {
  const dbHost = process.env.DB_HOST || 'mysql-ab4929f-stopdolp-032b.g.aivencloud.com';
  const dbPort = process.env.DB_PORT || 25504;
  const dbUser = process.env.DB_USER || 'avnadmin';
  const dbPassword = process.env.DB_PASSWORD || '';
  const dbName = process.env.DB_NAME || 'defaultdb';

  pool = mysql.createPool({
    host: dbHost,
    port: dbPort,
    user: dbUser,
    password: dbPassword,
    database: dbName,
    waitForConnections: true,
    connectionLimit: 20,
    multipleStatements: true,
    ssl: { rejectUnauthorized: false }
  });

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      username        VARCHAR(80)  NOT NULL UNIQUE,
      email           VARCHAR(120) NOT NULL UNIQUE,
      password_hash   VARCHAR(255) NOT NULL,
      is_verified     TINYINT(1)   DEFAULT 0,
      is_banned       TINYINT(1)   DEFAULT 0,
      avatar_url      TEXT         DEFAULT NULL,
      bio             TEXT         DEFAULT NULL,
      age             INT          DEFAULT NULL,
      status_text     VARCHAR(140) DEFAULT NULL,
      status_emoji    VARCHAR(10)  DEFAULT NULL,
      theme           VARCHAR(20)  DEFAULT 'dark',
      last_seen       DATETIME     DEFAULT NULL,
      created_at      DATETIME     DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS contacts (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      user_id     INT NOT NULL,
      contact_id  INT NOT NULL,
      nickname    VARCHAR(80) DEFAULT NULL,
      is_blocked  TINYINT(1)  DEFAULT 0,
      is_muted    TINYINT(1)  DEFAULT 0,
      pinned      TINYINT(1)  DEFAULT 0,
      created_at  DATETIME    DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_ct (user_id, contact_id),
      FOREIGN KEY (user_id)    REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (contact_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS servers (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      name        VARCHAR(100) NOT NULL,
      description TEXT         DEFAULT NULL,
      icon_url    TEXT         DEFAULT NULL,
      banner_url  TEXT         DEFAULT NULL,
      owner_id    INT          NOT NULL,
      invite_code VARCHAR(16)  DEFAULT NULL UNIQUE,
      created_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS server_members (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      server_id  INT NOT NULL,
      user_id    INT NOT NULL,
      role       VARCHAR(30)  DEFAULT 'member',
      nickname   VARCHAR(80)  DEFAULT NULL,
      joined_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_mb (server_id, user_id),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS channels (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      server_id   INT NOT NULL,
      name        VARCHAR(80)  NOT NULL,
      topic       VARCHAR(200) DEFAULT NULL,
      type        ENUM('text','voice','announcement') DEFAULT 'text',
      position    INT          DEFAULT 0,
      is_nsfw     TINYINT(1)   DEFAULT 0,
      created_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      sender_id     INT NOT NULL,
      recipient_id  INT NULL,
      channel_id    INT NULL,
      content       LONGTEXT NOT NULL,
      message_type  VARCHAR(30) DEFAULT 'text',
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sender_id)    REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id)   REFERENCES channels(id) ON DELETE CASCADE,
      INDEX idx_dm (sender_id, recipient_id),
      INDEX idx_ch (channel_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS saved_messages (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      user_id    INT NOT NULL,
      content    TEXT NOT NULL,
      saved_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  console.log(`[DB] ✅ База данных подключена и проверена (${dbName} @ ${dbHost})`);
}

const safeUser = `id, username, email, is_verified, is_banned, avatar_url, bio, age, status_text, status_emoji, last_seen, created_at`;

function formatMessageRow(row, sender) {
  return {
    id: row.id,
    from: row.sender_id,
    to: row.recipient_id,
    channelId: row.channel_id,
    content: row.content,
    messageType: row.message_type,
    username: sender?.username || 'User',
    is_verified: sender?.is_verified || 0,
    avatar_url: sender?.avatar_url || null,
    ts: new Date(row.created_at).getTime(),
    type: row.channel_id ? 'channel' : 'dm'
  };
}

async function getSenderInfo(userId) {
  const [rows] = await pool.execute(`SELECT username, is_verified, avatar_url FROM users WHERE id=?`, [userId]);
  return rows[0] || null;
}

async function saveMessage(data) {
  const senderId = data.from;
  const recipientId = data.type === 'dm' ? data.to : null;
  const channelId = data.type === 'channel' ? data.channelId : null;
  const messageType = data.messageType || 'text';

  const [result] = await pool.execute(
    `INSERT INTO messages (sender_id, recipient_id, channel_id, content, message_type) VALUES (?,?,?,?,?)`,
    [senderId, recipientId, channelId, data.content, messageType]
  );

  const sender = await getSenderInfo(senderId);
  return formatMessageRow({
    id: result.insertId,
    sender_id: senderId,
    recipient_id: recipientId,
    channel_id: channelId,
    content: data.content,
    message_type: messageType,
    created_at: new Date()
  }, sender);
}

// REST API
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'Заполните все поля' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const [r] = await pool.execute(`INSERT INTO users (username, email, password_hash) VALUES (?,?,?)`, [username.trim(), email.trim().toLowerCase(), hash]);
    const [rows] = await pool.execute(`SELECT ${safeUser} FROM users WHERE id=?`, [r.insertId]);
    res.json({ user: rows[0] });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Имя или email уже заняты' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });
  try {
    const [rows] = await pool.execute(`SELECT id, username, email, password_hash, is_verified, is_banned, avatar_url, bio, age, status_text, status_emoji FROM users WHERE username=?`, [username.trim()]);
    if (!rows.length) return res.status(401).json({ error: 'Пользователь не найден' });
    const u = rows[0];
    if (!await bcrypt.compare(password, u.password_hash)) return res.status(401).json({ error: 'Неверный пароль' });
    delete u.password_hash;
    await pool.execute(`UPDATE users SET last_seen=NOW() WHERE id=?`, [u.id]);
    res.json({ user: u });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/me/:id', async (req, res) => {
  try {
    const [r] = await pool.execute(`SELECT ${safeUser} FROM users WHERE id=?`, [req.params.id]);
    if (!r.length) return res.status(404).json({ error: 'Не найден' });
    res.json(r[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users/profile', async (req, res) => {
  const { userId, avatar_url, bio, age, status_text, status_emoji } = req.body;
  try {
    await pool.execute(`UPDATE users SET avatar_url=?, bio=?, age=?, status_text=?, status_emoji=? WHERE id=?`, [avatar_url || null, bio || null, age ? parseInt(age) : null, status_text || null, status_emoji || null, userId]);
    const [rows] = await pool.execute(`SELECT ${safeUser} FROM users WHERE id=?`, [userId]);
    res.json({ user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users/upload-avatar', uploadAvatar.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  res.json({ avatar_url: `/uploads/avatars/${req.file.filename}` });
});

app.post('/api/upload/voice', uploadVoice.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Аудиофайл не загружен' });
  res.json({ url: `/uploads/voice/${req.file.filename}` });
});

app.post('/api/upload/videonote', uploadVideoNote.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Видеофайл не загружен' });
  res.json({ url: `/uploads/videonotes/${req.file.filename}` });
});

app.post('/api/users/change-password', async (req, res) => {
  const { userId, oldPassword, newPassword } = req.body;
  try {
    const [rows] = await pool.execute(`SELECT password_hash FROM users WHERE id=?`, [userId]);
    if (!rows.length) return res.status(404).json({ error: 'Не найден' });
    if (!await bcrypt.compare(oldPassword, rows[0].password_hash)) return res.status(401).json({ error: 'Старый пароль неверен' });
    const hash = await bcrypt.hash(newPassword, 12);
    await pool.execute(`UPDATE users SET password_hash=? WHERE id=?`, [hash, userId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users/search', async (req, res) => {
  const { query, currentUserId } = req.query;
  if (!query) return res.json([]);
  try {
    const [r] = await pool.execute(`SELECT id, username, is_verified, avatar_url, status_text, status_emoji FROM users WHERE (username LIKE ? OR email LIKE ?) AND id!=? LIMIT 20`, [`%${query}%`, `%${query}%`, currentUserId || 0]);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users/:id', async (req, res) => {
  try {
    const [r] = await pool.execute(`SELECT ${safeUser} FROM users WHERE id=?`, [req.params.id]);
    if (!r.length) return res.status(404).json({ error: 'Не найден' });
    res.json(r[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/contacts/:userId', async (req, res) => {
  try {
    const [r] = await pool.execute(`
      SELECT u.id, u.username, u.is_verified, u.is_banned, u.avatar_url, u.status_text, u.status_emoji, u.last_seen,
              c.nickname, c.is_blocked, c.is_muted, c.pinned
       FROM contacts c JOIN users u ON u.id=c.contact_id
       WHERE c.user_id=? ORDER BY c.pinned DESC, u.username ASC
    `, [req.params.userId]);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/contacts', async (req, res) => {
  const { userId, contactId } = req.body;
  if (!userId || !contactId || userId == contactId) return res.status(400).json({ error: 'Некорректно' });
  try {
    await pool.execute(`INSERT IGNORE INTO contacts (user_id, contact_id) VALUES (?,?)`, [userId, contactId]);
    await pool.execute(`INSERT IGNORE INTO contacts (user_id, contact_id) VALUES (?,?)`, [contactId, userId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/contacts/:userId/:contactId', async (req, res) => {
  const { nickname, is_blocked, is_muted, pinned } = req.body;
  try {
    const fields = []; const vals = [];
    if (nickname !== undefined) { fields.push('nickname=?'); vals.push(nickname); }
    if (is_blocked !== undefined) { fields.push('is_blocked=?'); vals.push(is_blocked ? 1 : 0); }
    if (is_muted !== undefined) { fields.push('is_muted=?'); vals.push(is_muted ? 1 : 0); }
    if (pinned !== undefined) { fields.push('pinned=?'); vals.push(pinned ? 1 : 0); }
    if (!fields.length) return res.status(400).json({ error: 'Нет данных' });
    vals.push(req.params.userId, req.params.contactId);
    await pool.execute(`UPDATE contacts SET ${fields.join(',')} WHERE user_id=? AND contact_id=?`, vals);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/contacts/:userId/:contactId', async (req, res) => {
  try {
    await pool.execute(`DELETE FROM contacts WHERE user_id=? AND contact_id=?`, [req.params.userId, req.params.contactId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/messages/dm/:userId/:contactId', async (req, res) => {
  try {
    const { userId, contactId } = req.params;
    const [rows] = await pool.execute(`
      SELECT m.*, u.username, u.is_verified, u.avatar_url
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.channel_id IS NULL AND ((m.sender_id=? AND m.recipient_id=?) OR (m.sender_id=? AND m.recipient_id=?))
       ORDER BY m.created_at ASC LIMIT 200
    `, [userId, contactId, contactId, userId]);
    res.json(rows.map(r => formatMessageRow(r, r)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/messages/channel/:channelId', async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT m.*, u.username, u.is_verified, u.avatar_url
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.channel_id=? ORDER BY m.created_at ASC LIMIT 200
    `, [req.params.channelId]);
    res.json(rows.map(r => formatMessageRow(r, r)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/servers/user/:userId', async (req, res) => {
  try {
    const [r] = await pool.execute(`SELECT s.* FROM servers s JOIN server_members sm ON sm.server_id=s.id WHERE sm.user_id=? ORDER BY s.created_at ASC`, [req.params.userId]);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/servers', async (req, res) => {
  const { name, ownerId, description } = req.body;
  if (!name || !ownerId) return res.status(400).json({ error: 'Укажите название' });
  try {
    const inviteCode = uuidv4().replace(/-/g, '').substring(0, 8);
    const [r] = await pool.execute(`INSERT INTO servers (name, owner_id, description, invite_code) VALUES (?,?,?,?)`, [name.trim(), ownerId, description || null, inviteCode]);
    const sid = r.insertId;
    await pool.execute(`INSERT INTO server_members (server_id, user_id, role) VALUES (?,?,'owner')`, [sid, ownerId]);
    await pool.execute(`INSERT INTO channels (server_id, name, type, position) VALUES (?,?,?,?)`, [sid, 'общий', 'text', 0]);
    await pool.execute(`INSERT INTO channels (server_id, name, type, position) VALUES (?,?,?,?)`, [sid, 'объявления', 'announcement', 1]);
    res.json({ id: sid, invite_code: inviteCode });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/servers/join-invite', async (req, res) => {
  const { inviteCode, userId } = req.body;
  try {
    const [servers] = await pool.execute(`SELECT * FROM servers WHERE invite_code=?`, [inviteCode]);
    if (!servers.length) return res.status(404).json({ error: 'Сервер не найден' });
    const s = servers[0];
    await pool.execute(`INSERT IGNORE INTO server_members (server_id, user_id) VALUES (?,?)`, [s.id, userId]);
    res.json({ server: s });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/servers/:serverId/members', async (req, res) => {
  try {
    const [r] = await pool.execute(`SELECT u.id, u.username, u.avatar_url, u.is_verified, sm.role FROM server_members sm JOIN users u ON u.id=sm.user_id WHERE sm.server_id=?`, [req.params.serverId]);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/servers/:serverId/channels', async (req, res) => {
  try {
    const [r] = await pool.execute(`SELECT * FROM channels WHERE server_id=? ORDER BY position ASC, created_at ASC`, [req.params.serverId]);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/servers/:serverId/channels', async (req, res) => {
  const { name, type } = req.body;
  try {
    const [r] = await pool.execute(`INSERT INTO channels (server_id, name, type) VALUES (?,?,?)`, [req.params.serverId, name.trim(), type || 'text']);
    res.json({ id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/saved/:userId', async (req, res) => {
  try {
    const [r] = await pool.execute(`SELECT * FROM saved_messages WHERE user_id=? ORDER BY saved_at DESC`, [req.params.userId]);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/saved', async (req, res) => {
  const { userId, content } = req.body;
  try {
    await pool.execute(`INSERT INTO saved_messages (user_id, content) VALUES (?,?)`, [userId, content]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Socket.io
const online = new Map();
const sockToUser = new Map();

function emitToUser(userId, event, payload) {
  const sId = online.get(String(userId));
  if (sId) io.to(sId).emit(event, payload);
}

io.on('connection', (socket) => {
  console.log(`[WS] Connected: ${socket.id}`);

  socket.on('user_connected', (userId) => {
    if (!userId) return;
    const uid = String(userId);
    online.set(uid, socket.id);
    sockToUser.set(socket.id, uid);
    io.emit('user_online', { userId: uid });
  });

  socket.on('join_channel', (chId) => socket.join(`ch_${chId}`));
  socket.on('leave_channel', (chId) => socket.leave(`ch_${chId}`));

  socket.on('dm', async (data) => {
    try {
      const senderId = sockToUser.get(socket.id) || String(data.from);
      const msg = await saveMessage({ ...data, from: senderId, type: 'dm' });
      socket.emit('dm', msg);
      if (data.to) emitToUser(data.to, 'dm', msg);
    } catch (e) { console.error('[DM ERROR]', e); }
  });

  socket.on('ch_msg', async (data) => {
    try {
      const senderId = sockToUser.get(socket.id) || String(data.from);
      const msg = await saveMessage({ ...data, from: senderId, type: 'channel', channelId: data.chId });
      socket.emit('ch_msg', msg);
      if (data.chId) socket.to(`ch_${data.chId}`).emit('ch_msg', msg);
    } catch (e) { console.error('[CH MSG ERROR]', e); }
  });

  socket.on('typing', (d) => {
    if (d.type === 'dm') emitToUser(d.to, 'typing', d);
    else socket.to(`ch_${d.chId}`).emit('typing', d);
  });
  socket.on('stop_typing', (d) => {
    if (d.type === 'dm') emitToUser(d.to, 'stop_typing', d);
    else socket.to(`ch_${d.chId}`).emit('stop_typing', d);
  });

  socket.on('read', (d) => emitToUser(d.to, 'read', d));
  socket.on('react', (d) => {
    socket.emit('react', d);
    if (d.type === 'dm') emitToUser(d.to, 'react', d);
    else io.to(`ch_${d.chId}`).emit('react', d);
  });
  socket.on('edit_msg', (d) => {
    socket.emit('edit_msg', d);
    if (d.type === 'dm') emitToUser(d.to, 'edit_msg', d);
    else io.to(`ch_${d.chId}`).emit('edit_msg', d);
  });
  socket.on('delete_msg', (d) => {
    socket.emit('delete_msg', d);
    if (d.type === 'dm') emitToUser(d.to, 'delete_msg', d);
    else io.to(`ch_${d.chId}`).emit('delete_msg', d);
  });

  // WebRTC Signaling
  socket.on('call_user', (d) => {
    const from = sockToUser.get(socket.id);
    const targetSocket = online.get(String(d.to));
    if (!targetSocket) { socket.emit('call_rejected', { reason: 'offline' }); return; }
    io.to(targetSocket).emit('call_incoming', { ...d, from });
  });
  socket.on('call_accept', (d) => emitToUser(d.to, 'call_accepted', d));
  socket.on('call_reject', (d) => emitToUser(d.to, 'call_rejected', d));
  socket.on('rtc_offer', (d) => emitToUser(d.to, 'rtc_offer', d));
  socket.on('rtc_answer', (d) => emitToUser(d.to, 'rtc_answer', d));
  socket.on('rtc_ice', (d) => emitToUser(d.to, 'rtc_ice', d));
  socket.on('call_end', (d) => emitToUser(d.to, 'call_ended', d));

  socket.on('disconnect', () => {
    const uid = sockToUser.get(socket.id);
    if (uid) {
      online.delete(uid);
      sockToUser.delete(socket.id);
      io.emit('user_offline', { userId: uid });
      pool.execute(`UPDATE users SET last_seen=NOW() WHERE id=?`, [uid]).catch(() => {});
    }
  });
});

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`🚀 ego Messenger запущен на порту ${PORT}`);
  });
}).catch(err => {
  console.error('❌ Ошибка инициализации БД:', err);
  process.exit(1);
});
