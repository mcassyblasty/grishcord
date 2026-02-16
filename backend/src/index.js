import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { fileTypeFromBuffer } from 'file-type';
import { Pool } from 'pg';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const uploadsDir = process.env.UPLOADS_DIR || '/mnt/grishcord/uploads';
await fsp.mkdir(uploadsDir, { recursive: true });

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'mcassyblasty';
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 15 * 1024 * 1024);
const RETENTION_THRESHOLD = Number(process.env.RETENTION_THRESHOLD_PCT || 90);
const RETENTION_INTERVAL_MS = Number(process.env.RETENTION_INTERVAL_MS || 120000);
const HOST_DATA_ROOT = process.env.HOST_DATA_ROOT || '/mnt/grishcord';

const versionFile = path.join(process.cwd(), '..', 'VERSION');
let APP_VERSION = process.env.APP_VERSION || '0.0.0';
try {
  APP_VERSION = (await fsp.readFile(versionFile, 'utf8')).trim() || APP_VERSION;
} catch {}
const spamPresets = {
  1: { burst: 3, sustained: 10, cooldown: 120 },
  3: { burst: 5, sustained: 15, cooldown: 60 },
  5: { burst: 8, sustained: 25, cooldown: 30 },
  7: { burst: 12, sustained: 40, cooldown: 15 },
  10: { burst: 20, sustained: 80, cooldown: 5 }
};

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES } });
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const token = (n = 32) => crypto.randomBytes(n).toString('hex');

async function runMigrations() {
  const sql = await fsp.readFile(path.join(process.cwd(), 'migrations', '001_init.sql'), 'utf8');
  await pool.query(sql);
}

function auth(req, res, next) {
  try {
    const raw = req.cookies.gc_session;
    if (!raw) return res.status(401).json({ error: 'unauthorized' });
    const data = jwt.verify(raw, JWT_SECRET);
    req.user = data;
    next();
  } catch {
    res.status(401).json({ error: 'unauthorized' });
  }
}

async function enforceSessionVersion(req, res, next) {
  const { rows } = await pool.query('SELECT id, session_version, disabled, username FROM users WHERE id = $1', [req.user.sub]);
  const user = rows[0];
  if (!user || user.disabled || user.session_version !== req.user.sv) return res.status(401).json({ error: 'session_expired' });
  req.userDb = user;
  next();
}

function adminOnly(req, res, next) {
  if (req.userDb.username !== ADMIN_USERNAME) return res.status(403).json({ error: 'admin_only' });
  next();
}

function sanitizeSpamLevel(v) {
  const n = Number(v);
  if ([1, 3, 5, 7, 10].includes(n)) return n;
  return null;
}

function sanitizeBitrate(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(16000, Math.min(64000, Math.round(n)));
}

app.get('/health', (_req, res) => res.json({ ok: true, version: APP_VERSION }));
app.get('/api/version', (_req, res) => res.json({ version: APP_VERSION }));

app.post('/api/register', async (req, res) => {
  const { inviteToken, username, displayName, password } = req.body;
  const h = sha(inviteToken || '');
  const { rows } = await pool.query('SELECT * FROM invites WHERE token_hash = $1 AND revoked_at IS NULL AND used_by IS NULL AND expires_at > now()', [h]);
  if (!rows[0]) return res.status(400).json({ error: 'invalid_invite' });
  const pw = await bcrypt.hash(password, 12);
  const user = await pool.query('INSERT INTO users (username, display_name, password_hash) VALUES ($1,$2,$3) RETURNING id', [username, displayName, pw]);
  await pool.query('UPDATE invites SET used_by = $1, used_at = now() WHERE id = $2', [user.rows[0].id, rows[0].id]);
  res.json({ ok: true });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const { rows } = await pool.query('SELECT id, username, password_hash, session_version, disabled FROM users WHERE username = $1', [username]);
  const user = rows[0];
  if (!user || user.disabled || !(await bcrypt.compare(password || '', user.password_hash))) return res.status(401).json({ error: 'invalid_credentials' });
  const session = jwt.sign({ sub: user.id, sv: user.session_version }, JWT_SECRET, { expiresIn: '7d' });
  const wantSecure = process.env.COOKIE_SECURE === 'true';
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie('gc_session', session, { httpOnly: true, sameSite: 'lax', secure: wantSecure && isHttps });
  res.json({ ok: true });
});

app.post('/api/logout', (_req, res) => {
  res.clearCookie('gc_session');
  res.json({ ok: true });
});

app.get('/api/me', auth, enforceSessionVersion, async (req, res) => {
  const { rows } = await pool.query('SELECT id, username, display_name FROM users WHERE id=$1', [req.user.sub]);
  res.json(rows[0]);
});

app.get('/api/admin/state', auth, enforceSessionVersion, adminOnly, async (_req, res) => {
  const invites = await pool.query('SELECT id, expires_at, created_at, used_at, revoked_at, used_by FROM invites ORDER BY id DESC LIMIT 50');
  const users = await pool.query('SELECT id, username, display_name, disabled, created_at FROM users ORDER BY id ASC');
  const settings = await pool.query('SELECT key, value FROM app_settings WHERE key IN ($1, $2)', ['anti_spam_level', 'voice_bitrate']);
  const settingMap = Object.fromEntries(settings.rows.map((r) => [r.key, r.value]));
  const level = Number(settingMap.anti_spam_level ?? 5);
  res.json({
    invites: invites.rows,
    users: users.rows,
    antiSpamLevel: level,
    antiSpamEffective: spamPresets[level] || spamPresets[5],
    voiceBitrate: Number(settingMap.voice_bitrate ?? 32000)
  });
});

app.post('/api/admin/invites', auth, enforceSessionVersion, adminOnly, async (req, res) => {
  const raw = token(24);
  const ttlDays = Number(req.body.ttlDays || process.env.INVITE_TTL_DAYS || 7);
  await pool.query('INSERT INTO invites(token_hash, expires_at) VALUES($1, now() + ($2 || " days")::interval)', [sha(raw), String(ttlDays)]);
  res.json({ inviteUrl: `${process.env.PUBLIC_BASE_URL}/register?token=${raw}` });
});

app.post('/api/admin/invites/:id/revoke', auth, enforceSessionVersion, adminOnly, async (req, res) => {
  await pool.query('UPDATE invites SET revoked_at = now() WHERE id = $1 AND used_at IS NULL', [Number(req.params.id)]);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/disable', auth, enforceSessionVersion, adminOnly, async (req, res) => {
  const disabled = req.body.disabled === true;
  await pool.query('UPDATE users SET disabled = $1 WHERE id = $2 AND username <> $3', [disabled, Number(req.params.id), ADMIN_USERNAME]);
  res.json({ ok: true });
});

app.post('/api/admin/settings', auth, enforceSessionVersion, adminOnly, async (req, res) => {
  const level = sanitizeSpamLevel(req.body.antiSpamLevel);
  const bitrate = sanitizeBitrate(req.body.voiceBitrate);
  if (level !== null) {
    await pool.query('INSERT INTO app_settings(key, value) VALUES ($1, $2::jsonb) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value', ['anti_spam_level', JSON.stringify(level)]);
  }
  if (bitrate !== null) {
    await pool.query('INSERT INTO app_settings(key, value) VALUES ($1, $2::jsonb) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value', ['voice_bitrate', JSON.stringify(bitrate)]);
  }
  const finalLevel = level ?? 5;
  res.json({ ok: true, antiSpamLevel: finalLevel, antiSpamEffective: spamPresets[finalLevel], voiceBitrate: bitrate ?? 32000 });
});

app.post('/api/admin/recovery', auth, enforceSessionVersion, adminOnly, async (req, res) => {
  const { username } = req.body;
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  const raw = token(24);
  await pool.query('INSERT INTO recovery_tokens(user_id, token_hash, expires_at) VALUES($1,$2, now() + interval "1 hour")', [rows[0].id, sha(raw)]);
  res.json({ recoveryUrl: `${process.env.PUBLIC_BASE_URL}/recover?token=${raw}` });
});

app.post('/api/recovery/redeem', async (req, res) => {
  const { token: raw } = req.body;
  const { rows } = await pool.query('SELECT * FROM recovery_tokens WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now()', [sha(raw || '')]);
  if (!rows[0]) return res.status(400).json({ error: 'invalid_token' });
  await pool.query('UPDATE users SET session_version = session_version + 1 WHERE id = $1', [rows[0].user_id]);
  await pool.query('UPDATE recovery_tokens SET clicked_at = now() WHERE id = $1 AND clicked_at IS NULL', [rows[0].id]);
  res.json({ redeemId: rows[0].id });
});

app.post('/api/recovery/reset', async (req, res) => {
  const { redeemId, password } = req.body;
  const { rows } = await pool.query('SELECT * FROM recovery_tokens WHERE id=$1 AND used_at IS NULL AND expires_at > now()', [redeemId]);
  if (!rows[0]) return res.status(400).json({ error: 'invalid_token' });
  const pw = await bcrypt.hash(password, 12);
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [pw, rows[0].user_id]);
  await pool.query('UPDATE recovery_tokens SET used_at = now() WHERE id=$1', [redeemId]);
  res.json({ ok: true });
});

app.post('/api/messages', auth, enforceSessionVersion, async (req, res) => {
  const { channelId = null, dmPeerId = null, body } = req.body;
  if (req.userDb.disabled) return res.status(403).json({ error: 'disabled' });
  const text = String(body || '').slice(0, 10000);
  const result = await pool.query('INSERT INTO messages(author_id, channel_id, dm_peer_id, body) VALUES($1,$2,$3,$4) RETURNING *', [req.user.sub, channelId, dmPeerId, text]);
  const msg = result.rows[0];
  const payload = JSON.stringify({ type: 'message', data: msg });
  for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
  res.json(msg);
});

app.get('/api/messages/since/:id', auth, enforceSessionVersion, async (req, res) => {
  const { rows } = await pool.query('SELECT m.id, m.body, m.created_at, u.username, u.display_name FROM messages m JOIN users u ON u.id=m.author_id WHERE m.id > $1 ORDER BY m.id ASC LIMIT 500', [Number(req.params.id)]);
  res.json(rows);
});

app.post('/api/upload-image', auth, enforceSessionVersion, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'missing_file' });
  const ft = await fileTypeFromBuffer(req.file.buffer);
  const allowed = new Map([
    ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'], ['image/webp', 'webp']
  ]);
  if (!ft || !allowed.has(ft.mime)) return res.status(400).json({ error: 'unsupported_image' });
  const id = uuidv4();
  const filePath = path.join(uploadsDir, `${id}.${allowed.get(ft.mime)}`);
  await fsp.writeFile(filePath, req.file.buffer);
  const r = await pool.query('INSERT INTO uploads(storage_name, content_type, byte_size, owner_id) VALUES($1,$2,$3,$4) RETURNING id', [path.basename(filePath), ft.mime, req.file.size, req.user.sub]);
  res.json({ uploadId: r.rows[0].id });
});

app.get('/api/uploads/:id', auth, enforceSessionVersion, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM uploads WHERE id=$1', [req.params.id]);
  const u = rows[0];
  if (!u) return res.status(404).end();
  res.setHeader('Content-Type', u.content_type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(path.join(uploadsDir, u.storage_name)).pipe(res);
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello' }));
});

async function retentionSweep() {
  try {
    const st = await fsp.statfs(HOST_DATA_ROOT);
    const usedPct = ((st.blocks - st.bfree) / st.blocks) * 100;
    if (usedPct < RETENTION_THRESHOLD) return;
    while (true) {
      const s2 = await fsp.statfs(HOST_DATA_ROOT);
      const p2 = ((s2.blocks - s2.bfree) / s2.blocks) * 100;
      if (p2 < RETENTION_THRESHOLD) break;
      const { rows } = await pool.query('SELECT id FROM messages ORDER BY created_at ASC LIMIT 100');
      if (!rows.length) break;
      const ids = rows.map((r) => r.id);
      const upl = await pool.query('SELECT DISTINCT u.storage_name FROM uploads u JOIN message_uploads mu ON mu.upload_id=u.id WHERE mu.message_id = ANY($1::bigint[])', [ids]);
      await pool.query('DELETE FROM messages WHERE id = ANY($1::bigint[])', [ids]);
      for (const u of upl.rows) await fsp.rm(path.join(uploadsDir, u.storage_name), { force: true });
    }
  } catch (e) {
    console.error('retention error', e.message);
  }
}

await runMigrations();
setInterval(retentionSweep, RETENTION_INTERVAL_MS);

const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log(`api on ${port}`));
