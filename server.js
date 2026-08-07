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
const io = new Server(server, {
  maxHttpBufferSize: 100 * 1024 * 1024,
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// ─── Multer (аватарки и файлы) ──────────────────────────────────────────────
const mkDir = d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); };

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => { const d = path.join(__dirname, 'uploads', 'avatars'); mkDir(d); cb(null, d); },
  filename:    (req, file, cb) => cb(null, `ava_${uuidv4()}${path.extname(file.originalname)}`)
});
const uploadAvatar = multer({ storage: avatarStorage, limits: { fileSize: 10 * 1024 * 1024 } });

// ─── MySQL ───────────────────────────────────────────────────────────────────
let pool;

async function initDB() {
  const root = await mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'root',
    multipleStatements: true
  });
  await root.execute(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME || 'messenger_db'}\``);
  await root.end();

  pool = await mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'root',
    database: process.env.DB_NAME || 'messenger_db',
    waitForConnections: true, connectionLimit: 20, multipleStatements: true
  });

  // ── Таблицы ─────────────────────────────────────────────────────────────────
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
    CREATE TABLE IF NOT EXISTS saved_messages (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      user_id    INT NOT NULL,
      content    TEXT NOT NULL,
      saved_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Auto-migrate
  const patches = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS status_emoji VARCHAR(10) DEFAULT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS status_text VARCHAR(140) DEFAULT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS theme VARCHAR(20) DEFAULT 'dark'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen DATETIME DEFAULT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS age INT DEFAULT NULL`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS nickname VARCHAR(80) DEFAULT NULL`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS is_blocked TINYINT(1) DEFAULT 0`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS is_muted TINYINT(1) DEFAULT 0`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS pinned TINYINT(1) DEFAULT 0`,
    `ALTER TABLE servers ADD COLUMN IF NOT EXISTS invite_code VARCHAR(16) DEFAULT NULL`,
    `ALTER TABLE servers ADD COLUMN IF NOT EXISTS banner_url TEXT DEFAULT NULL`,
    `ALTER TABLE channels ADD COLUMN IF NOT EXISTS topic VARCHAR(200) DEFAULT NULL`,
    `ALTER TABLE channels ADD COLUMN IF NOT EXISTS position INT DEFAULT 0`,
    `ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_nsfw TINYINT(1) DEFAULT 0`,
  ];
  for (const q of patches) {
    try { await pool.execute(q); } catch (e) { /* already exists */ }
  }

  // Generate invite codes for servers that don't have one
  await pool.execute(`UPDATE servers SET invite_code = SUBSTRING(MD5(id), 1, 8) WHERE invite_code IS NULL`);

  console.log('[DB] ✅ База данных готова');
}

// ═══════════════════════════════ REST API ════════════════════════════════════

const safeUser = `id, username, email, is_verified, is_banned, avatar_url, bio, age, status_text, status_emoji, last_seen, created_at`;

// POST /api/register
app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'Заполните все поля' });
  if (username.length < 2)  return res.status(400).json({ error: 'Имя минимум 2 символа' });
  if (password.length < 4)  return res.status(400).json({ error: 'Пароль минимум 4 символа' });

  try {
    const hash = await bcrypt.hash(password, 12);
    const [r] = await pool.execute(
      `INSERT INTO users (username, email, password_hash) VALUES (?,?,?)`,
      [username.trim(), email.trim().toLowerCase(), hash]
    );
    const [rows] = await pool.execute(`SELECT ${safeUser} FROM users WHERE id=?`, [r.insertId]);
    console.log(`[REGISTER] + ${username}`);
    res.json({ user: rows[0] });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Пользователь или email уже занят' });
    console.error('[REGISTER]', err.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /api/login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });
  try {
    const [rows] = await pool.execute(
      `SELECT id, username, email, password_hash, is_verified, is_banned, avatar_url, bio, age, status_text, status_emoji FROM users WHERE username=?`,
      [username.trim()]
    );
    if (!rows.length) return res.status(401).json({ error: 'Пользователь не найден' });
    const u = rows[0];
    if (!await bcrypt.compare(password, u.password_hash)) return res.status(401).json({ error: 'Неверный пароль' });
    delete u.password_hash;
    await pool.execute(`UPDATE users SET last_seen=NOW() WHERE id=?`, [u.id]);
    console.log(`[LOGIN] ${username}`);
    res.json({ user: u });
  } catch (err) {
    console.error('[LOGIN]', err.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /api/users/me/:id — live status polling
app.get('/api/users/me/:id', async (req, res) => {
  try {
    const [r] = await pool.execute(`SELECT ${safeUser} FROM users WHERE id=?`, [req.params.id]);
    if (!r.length) return res.status(404).json({ error: 'Не найден' });
    res.json(r[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/users/profile — FIXED: принимает userId, все поля
app.post('/api/users/profile', async (req, res) => {
  const { userId, avatar_url, bio, age, status_text, status_emoji } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId обязателен' });
  try {
    await pool.execute(
      `UPDATE users SET avatar_url=?, bio=?, age=?, status_text=?, status_emoji=? WHERE id=?`,
      [avatar_url || null, bio || null, age ? parseInt(age) : null, status_text || null, status_emoji || null, userId]
    );
    const [rows] = await pool.execute(`SELECT ${safeUser} FROM users WHERE id=?`, [userId]);
    res.json({ user: rows[0] });
  } catch (err) {
    console.error('[PROFILE UPDATE]', err.message);
    res.status(500).json({ error: 'Ошибка обновления профиля' });
  }
});

// POST /api/users/upload-avatar
app.post('/api/users/upload-avatar', uploadAvatar.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  res.json({ avatar_url: `/uploads/avatars/${req.file.filename}` });
});

// POST /api/users/change-password
app.post('/api/users/change-password', async (req, res) => {
  const { userId, oldPassword, newPassword } = req.body;
  if (!userId || !oldPassword || !newPassword) return res.status(400).json({ error: 'Заполните все поля' });
  if (newPassword.length < 4) return res.status(400).json({ error: 'Пароль минимум 4 символа' });
  try {
    const [rows] = await pool.execute(`SELECT password_hash FROM users WHERE id=?`, [userId]);
    if (!rows.length) return res.status(404).json({ error: 'Не найден' });
    if (!await bcrypt.compare(oldPassword, rows[0].password_hash)) return res.status(401).json({ error: 'Старый пароль неверен' });
    const hash = await bcrypt.hash(newPassword, 12);
    await pool.execute(`UPDATE users SET password_hash=? WHERE id=?`, [hash, userId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/users/search
app.get('/api/users/search', async (req, res) => {
  const { query, currentUserId } = req.query;
  if (!query) return res.json([]);
  try {
    const [r] = await pool.execute(
      `SELECT id, username, is_verified, avatar_url, status_text, status_emoji FROM users WHERE (username LIKE ? OR email LIKE ?) AND id!=? LIMIT 20`,
      [`%${query}%`, `%${query}%`, currentUserId || 0]
    );
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/users/:id — public profile
app.get('/api/users/:id', async (req, res) => {
  try {
    const [r] = await pool.execute(`SELECT ${safeUser} FROM users WHERE id=?`, [req.params.id]);
    if (!r.length) return res.status(404).json({ error: 'Не найден' });
    res.json(r[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/contacts/:userId
app.get('/api/contacts/:userId', async (req, res) => {
  try {
    const [r] = await pool.execute(
      `SELECT u.id, u.username, u.is_verified, u.is_banned, u.avatar_url, u.status_text, u.status_emoji, u.last_seen,
              c.nickname, c.is_blocked, c.is_muted, c.pinned
       FROM contacts c JOIN users u ON u.id=c.contact_id
       WHERE c.user_id=? ORDER BY c.pinned DESC, u.username ASC`,
      [req.params.userId]
    );
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/contacts
app.post('/api/contacts', async (req, res) => {
  const { userId, contactId } = req.body;
  if (!userId || !contactId || userId == contactId) return res.status(400).json({ error: 'Некорректные данные' });
  try {
    await pool.execute(`INSERT IGNORE INTO contacts (user_id, contact_id) VALUES (?,?)`, [userId, contactId]);
    await pool.execute(`INSERT IGNORE INTO contacts (user_id, contact_id) VALUES (?,?)`, [contactId, userId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/contacts/:userId/:contactId — обновить контакт (блок, мут, пин, никнейм)
app.patch('/api/contacts/:userId/:contactId', async (req, res) => {
  const { nickname, is_blocked, is_muted, pinned } = req.body;
  try {
    const fields = [];
    const vals = [];
    if (nickname   !== undefined) { fields.push('nickname=?');   vals.push(nickname); }
    if (is_blocked !== undefined) { fields.push('is_blocked=?'); vals.push(is_blocked ? 1 : 0); }
    if (is_muted   !== undefined) { fields.push('is_muted=?');   vals.push(is_muted ? 1 : 0); }
    if (pinned     !== undefined) { fields.push('pinned=?');     vals.push(pinned ? 1 : 0); }
    if (!fields.length) return res.status(400).json({ error: 'Нет данных' });
    vals.push(req.params.userId, req.params.contactId);
    await pool.execute(`UPDATE contacts SET ${fields.join(',')} WHERE user_id=? AND contact_id=?`, vals);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/contacts/:userId/:contactId
app.delete('/api/contacts/:userId/:contactId', async (req, res) => {
  try {
    await pool.execute(`DELETE FROM contacts WHERE user_id=? AND contact_id=?`, [req.params.userId, req.params.contactId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/servers/user/:userId
app.get('/api/servers/user/:userId', async (req, res) => {
  try {
    const [r] = await pool.execute(
      `SELECT s.* FROM servers s JOIN server_members sm ON sm.server_id=s.id WHERE sm.user_id=? ORDER BY s.created_at ASC`,
      [req.params.userId]
    );
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/servers
app.post('/api/servers', async (req, res) => {
  const { name, ownerId, description } = req.body;
  if (!name || !ownerId) return res.status(400).json({ error: 'Укажите название' });
  try {
    const inviteCode = uuidv4().replace(/-/g,'').substring(0,8);
    const [r] = await pool.execute(
      `INSERT INTO servers (name, owner_id, description, invite_code) VALUES (?,?,?,?)`,
      [name.trim(), ownerId, description || null, inviteCode]
    );
    const sid = r.insertId;
    await pool.execute(`INSERT INTO server_members (server_id, user_id, role) VALUES (?,?,'owner')`, [sid, ownerId]);
    await pool.execute(`INSERT INTO channels (server_id, name, type, position) VALUES (?,?,?,?)`, [sid, 'общий', 'text', 0]);
    await pool.execute(`INSERT INTO channels (server_id, name, type, position) VALUES (?,?,?,?)`, [sid, 'объявления', 'announcement', 1]);
    console.log(`[SERVER] создан: ${name}`);
    res.json({ id: sid, invite_code: inviteCode });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/servers/join-invite
app.post('/api/servers/join-invite', async (req, res) => {
  const { inviteCode, userId } = req.body;
  if (!inviteCode || !userId) return res.status(400).json({ error: 'Неверные данные' });
  try {
    const [servers] = await pool.execute(`SELECT * FROM servers WHERE invite_code=?`, [inviteCode]);
    if (!servers.length) return res.status(404).json({ error: 'Сервер не найден по коду' });
    const s = servers[0];
    await pool.execute(`INSERT IGNORE INTO server_members (server_id, user_id) VALUES (?,?)`, [s.id, userId]);
    res.json({ server: s });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/servers/:serverId/members
app.get('/api/servers/:serverId/members', async (req, res) => {
  try {
    const [r] = await pool.execute(
      `SELECT u.id, u.username, u.avatar_url, u.is_verified, sm.role FROM server_members sm JOIN users u ON u.id=sm.user_id WHERE sm.server_id=?`,
      [req.params.serverId]
    );
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/servers/:serverId/channels
app.get('/api/servers/:serverId/channels', async (req, res) => {
  try {
    const [r] = await pool.execute(
      `SELECT * FROM channels WHERE server_id=? ORDER BY position ASC, created_at ASC`,
      [req.params.serverId]
    );
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/servers/:serverId/channels
app.post('/api/servers/:serverId/channels', async (req, res) => {
  const { name, type } = req.body;
  if (!name) return res.status(400).json({ error: 'Укажите название' });
  try {
    const [r] = await pool.execute(
      `INSERT INTO channels (server_id, name, type) VALUES (?,?,?)`,
      [req.params.serverId, name.trim(), type || 'text']
    );
    res.json({ id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Saved Messages
app.get('/api/saved/:userId', async (req, res) => {
  try {
    const [r] = await pool.execute(`SELECT * FROM saved_messages WHERE user_id=? ORDER BY saved_at DESC`, [req.params.userId]);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/saved', async (req, res) => {
  const { userId, content } = req.body;
  if (!userId || !content) return res.status(400).json({ error: 'Неверные данные' });
  try {
    await pool.execute(`INSERT INTO saved_messages (user_id, content) VALUES (?,?)`, [userId, content]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════ SOCKET.IO ═══════════════════════════════════
const online = new Map();   // userId -> socketId
const sockToUser = new Map(); // socketId -> userId

io.on('connection', (socket) => {
  console.log(`[WS] connect: ${socket.id}`);

  socket.on('user_connected', (userId) => {
    online.set(String(userId), socket.id);
    sockToUser.set(socket.id, String(userId));
    io.emit('user_online', { userId: String(userId) });
  });

  socket.on('join_channel', (chId) => socket.join(`ch_${chId}`));
  socket.on('leave_channel', (chId) => socket.leave(`ch_${chId}`));

  // ── DM ──────────────────────────────────────────────────────────────────────
  socket.on('dm', (data) => {
    const msg = { id: uuidv4(), ...data, ts: Date.now() };
    socket.emit('dm', msg);
    const rs = online.get(String(data.to));
    if (rs) io.to(rs).emit('dm', msg);
  });

  // ── Channel Message ──────────────────────────────────────────────────────────
  socket.on('ch_msg', (data) => {
    const msg = { id: uuidv4(), ...data, ts: Date.now() };
    io.to(`ch_${data.chId}`).emit('ch_msg', msg);
  });

  // ── Typing ───────────────────────────────────────────────────────────────────
  socket.on('typing', (data) => {
    if (data.type === 'dm') {
      const rs = online.get(String(data.to));
      if (rs) io.to(rs).emit('typing', { from: data.from, fromName: data.fromName });
    } else {
      socket.to(`ch_${data.chId}`).emit('typing', { from: data.from, fromName: data.fromName });
    }
  });
  socket.on('stop_typing', (data) => {
    if (data.type === 'dm') {
      const rs = online.get(String(data.to));
      if (rs) io.to(rs).emit('stop_typing', { from: data.from });
    } else {
      socket.to(`ch_${data.chId}`).emit('stop_typing', { from: data.from });
    }
  });

  // ── Read receipts ─────────────────────────────────────────────────────────────
  socket.on('read', (data) => {
    const rs = online.get(String(data.to));
    if (rs) io.to(rs).emit('read', { from: data.from, msgId: data.msgId });
  });

  // ── Reactions ────────────────────────────────────────────────────────────────
  socket.on('react', async (data) => {
    try {
      await pool.execute(
        `INSERT IGNORE INTO saved_messages (user_id, content) VALUES (?,?)`,
        // We reuse this just to log; in production you'd have a reactions table
        [data.from, `REACT:${data.msgId}:${data.emoji}`]
      );
    } catch(e) {}
    const payload = { msgId: data.msgId, from: data.from, emoji: data.emoji };
    socket.emit('react', payload);
    if (data.type === 'dm') {
      const rs = online.get(String(data.to));
      if (rs) io.to(rs).emit('react', payload);
    } else {
      io.to(`ch_${data.chId}`).emit('react', payload);
    }
  });

  // ── Edit / Delete ─────────────────────────────────────────────────────────────
  socket.on('edit_msg', (data) => {
    socket.emit('edit_msg', data);
    if (data.type === 'dm') {
      const rs = online.get(String(data.to));
      if (rs) io.to(rs).emit('edit_msg', data);
    } else {
      io.to(`ch_${data.chId}`).emit('edit_msg', data);
    }
  });

  socket.on('delete_msg', (data) => {
    socket.emit('delete_msg', data);
    if (data.type === 'dm') {
      const rs = online.get(String(data.to));
      if (rs) io.to(rs).emit('delete_msg', data);
    } else {
      io.to(`ch_${data.chId}`).emit('delete_msg', data);
    }
  });

  // ── WebRTC ───────────────────────────────────────────────────────────────────
  socket.on('call_user', (d) => {
    const rs = online.get(String(d.to));
    if (rs) io.to(rs).emit('call_incoming', { ...d, from: sockToUser.get(socket.id) });
    else socket.emit('call_rejected', { reason: 'offline' });
  });

  socket.on('call_accept', (d) => {
    const rs = online.get(String(d.to));
    if (rs) io.to(rs).emit('call_accepted', d);
  });

  socket.on('call_reject', (d) => {
    const rs = online.get(String(d.to));
    if (rs) io.to(rs).emit('call_rejected', { reason: 'declined' });
  });

  socket.on('rtc_offer',     (d) => { const s = online.get(String(d.to)); if(s) io.to(s).emit('rtc_offer',     { ...d, from: sockToUser.get(socket.id) }); });
  socket.on('rtc_answer',    (d) => { const s = online.get(String(d.to)); if(s) io.to(s).emit('rtc_answer',    d); });
  socket.on('rtc_ice',       (d) => { const s = online.get(String(d.to)); if(s) io.to(s).emit('rtc_ice',       d); });
  socket.on('call_end',      (d) => { const s = online.get(String(d.to)); if(s) io.to(s).emit('call_ended'); });

  // ── Disconnect ───────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const uid = sockToUser.get(socket.id);
    if (uid) {
      online.delete(uid);
      sockToUser.delete(socket.id);
      io.emit('user_offline', { userId: uid });
      pool.execute(`UPDATE users SET last_seen=NOW() WHERE id=?`, [uid]).catch(() => {});
    }
    console.log(`[WS] disconnect: ${socket.id}`);
  });
});

// ═══════════════════════════════ START ═══════════════════════════════════════
const PORT = process.env.PORT || 3000;

initDB().then(() => {
  server.listen(PORT, () => {
    console.log('');
    console.log('  ┌─────────────────────────────────────────┐');
    console.log(`  │  ego Messenger — запущен                │`);
    console.log(`  │  http://localhost:${PORT}                  │`);
    console.log('  └─────────────────────────────────────────┘');
    console.log('');
  });
}).catch(err => {
  console.error('');
  console.error('  ❌ ОШИБКА ПОДКЛЮЧЕНИЯ К БАЗЕ ДАННЫХ');
  console.error(`     ${err.message}`);
  console.error('  Убедитесь что MySQL запущен на localhost:3306');
  console.error('');
  process.exit(1);
});
