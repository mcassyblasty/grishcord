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

let APP_VERSION = '0.0.0';
let APP_VERSION_SOURCE = 'fallback';
const envVersion = String(process.env.APP_VERSION || '').trim();
if (envVersion) {
  APP_VERSION = envVersion;
  APP_VERSION_SOURCE = 'env';
} else {
  for (const p of [
    process.env.APP_VERSION_FILE,
    '/app/VERSION',
    path.join(process.cwd(), '..', 'VERSION'),
    path.join(process.cwd(), 'VERSION')
  ].filter(Boolean)) {
    try {
      const candidate = (await fsp.readFile(p, 'utf8')).trim();
      if (candidate) {
        APP_VERSION = candidate;
        APP_VERSION_SOURCE = `file:${p}`;
        break;
      }
    } catch {}
  }
}

const spamPresets = {
  1: { burst: 3, sustained: 10, cooldown: 120 },
  3: { burst: 5, sustained: 15, cooldown: 60 },
  5: { burst: 8, sustained: 25, cooldown: 30 },
  7: { burst: 12, sustained: 40, cooldown: 15 },
  10: { burst: 20, sustained: 80, cooldown: 5 }
};

function normalizeOrigin(raw) {
  try {
    return new URL(String(raw || '').trim()).origin;
  } catch {
    return '';
  }
}

const corsAllowedOrigins = (() => {
  const list = String(process.env.CORS_ORIGINS || '').split(',').map((v) => normalizeOrigin(v)).filter(Boolean);
  const fromPublicBase = normalizeOrigin(process.env.PUBLIC_BASE_URL || '');
  if (fromPublicBase) list.push(fromPublicBase);
  return [...new Set(list)];
})();

const corsOriginValidator = (origin, cb) => {
  if (!origin) return cb(null, true);
  if (!corsAllowedOrigins.length) return cb(null, true);
  return cb(null, corsAllowedOrigins.includes(origin));
};

app.use(cors({ origin: corsOriginValidator, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

function requireSameOriginOnMutations(req, res, next) {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return next();
  const origin = String(req.get('origin') || '').trim();
  const refererOrigin = normalizeOrigin(req.get('referer') || '');
  const requestOrigin = origin || refererOrigin;
  if (!requestOrigin) return next();
  const hostOrigin = `${req.protocol}://${req.get('host')}`;
  if (requestOrigin !== hostOrigin) return res.status(403).json({ error: 'cross_origin_forbidden' });
  next();
}

app.use('/api', requireSameOriginOnMutations);

const authRateLimits = new Map();
function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function authRateLimit({ windowMs, max, blockMs, bucket }) {
  return (req, res, next) => {
    const key = `${bucket}:${clientIp(req)}:${String(req.body?.username || '').toLowerCase()}`;
    const now = Date.now();
    const entry = authRateLimits.get(key) || { hits: [], blockedUntil: 0 };
    if (entry.blockedUntil > now) {
      const retryAfter = Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'rate_limited', retryAfterSeconds: retryAfter });
    }
    entry.hits = entry.hits.filter((t) => now - t < windowMs);
    entry.hits.push(now);
    if (entry.hits.length > max) {
      entry.blockedUntil = now + blockMs;
      authRateLimits.set(key, entry);
      const retryAfter = Math.max(1, Math.ceil(blockMs / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'rate_limited', retryAfterSeconds: retryAfter });
    }
    authRateLimits.set(key, entry);
    next();
  };
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES } });
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const token = (n = 32) => crypto.randomBytes(n).toString('hex');

function randomDisplayColor() {
  const hue = Math.floor(Math.random() * 360);
  const sat = 65 + Math.floor(Math.random() * 20);
  const light = 58 + Math.floor(Math.random() * 12);
  const c = (1 - Math.abs((2 * light / 100) - 1)) * (sat / 100);
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = (light / 100) - (c / 2);
  let r = 0, g = 0, b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (n) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

function parseCookieHeader(raw = '') {
  const out = {};
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

async function runMigrations() {
  const sql = await fsp.readFile(path.join(process.cwd(), 'migrations', '001_init.sql'), 'utf8');
  await pool.query(sql);
  await pool.query(`
    INSERT INTO channels(name, kind, position, archived)
    SELECT x.name, x.kind, x.position, false
    FROM (VALUES
      ('general', 'text', 1),
      ('random', 'text', 2),
      ('lobby-a', 'voice', 10),
      ('lobby-b', 'voice', 11)
    ) AS x(name, kind, position)
    WHERE NOT EXISTS (SELECT 1 FROM channels c WHERE c.name = x.name AND c.kind = x.kind)
  `);
  await pool.query('UPDATE users SET is_admin = true WHERE username = $1', [ADMIN_USERNAME]);
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
  const { rows } = await pool.query('SELECT id, session_version, disabled, username, display_name, display_color, is_admin, notification_sounds_enabled FROM users WHERE id = $1', [req.user.sub]);
  const user = rows[0];
  if (!user || user.disabled || user.session_version !== req.user.sv) return res.status(401).json({ error: 'session_expired' });
  req.userDb = user;
  next();
}

function userCanAdmin(user) {
  return Boolean(user && (user.username === ADMIN_USERNAME || user.is_admin));
}

function adminOnly(req, res, next) {
  if (!userCanAdmin(req.userDb)) return res.status(403).json({ error: 'admin_only' });
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

function sessionCookieOptions(req) {
  const wantSecure = process.env.COOKIE_SECURE === 'true';
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  return { httpOnly: true, sameSite: 'lax', secure: wantSecure && isHttps, path: '/' };
}

app.get('/health', (_req, res) => res.json({ ok: true, version: APP_VERSION }));
app.get('/api/version', (_req, res) => res.json({ version: APP_VERSION }));

app.get('/api/voice/config', auth, enforceSessionVersion, async (_req, res) => {
  const raw = String(process.env.VOICE_ICE_SERVERS || '').trim();
  let iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) iceServers = parsed;
    } catch {}
  }
  res.json({ iceServers });
});

app.post('/api/register', authRateLimit({ windowMs: 10 * 60 * 1000, max: 8, blockMs: 20 * 60 * 1000, bucket: 'register' }), async (req, res) => {
  const { inviteToken, username, displayName, password } = req.body;
  const h = sha(inviteToken || '');
  const { rows } = await pool.query('SELECT * FROM invites WHERE token_hash = $1 AND revoked_at IS NULL AND used_by IS NULL AND expires_at > now()', [h]);
  if (!rows[0]) return res.status(400).json({ error: 'invalid_invite' });
  const pw = await bcrypt.hash(password, 12);
  const user = await pool.query('INSERT INTO users (username, display_name, display_color, password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [username, displayName, randomDisplayColor(), pw]);
  await pool.query('UPDATE invites SET used_by = $1, used_at = now() WHERE id = $2', [user.rows[0].id, rows[0].id]);
  res.json({ ok: true });
});

app.post('/api/login', authRateLimit({ windowMs: 10 * 60 * 1000, max: 12, blockMs: 15 * 60 * 1000, bucket: 'login' }), async (req, res) => {
  const { username, password } = req.body;
  const { rows } = await pool.query('SELECT id, username, password_hash, session_version, disabled FROM users WHERE username = $1', [username]);
  const user = rows[0];
  if (!user || user.disabled || !(await bcrypt.compare(password || '', user.password_hash))) return res.status(401).json({ error: 'invalid_credentials' });
  const session = jwt.sign({ sub: user.id, sv: user.session_version }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('gc_session', session, sessionCookieOptions(req));
  res.json({ ok: true });
});

app.post('/api/logout', async (req, res) => {
  try {
    const raw = req.cookies.gc_session;
    if (raw) {
      const data = jwt.verify(raw, JWT_SECRET);
      await pool.query('UPDATE users SET session_version = session_version + 1 WHERE id = $1', [data.sub]);
    }
  } catch {}
  res.clearCookie('gc_session', sessionCookieOptions(req));
  res.json({ ok: true });
});

app.get('/api/me', auth, enforceSessionVersion, async (req, res) => {
  const { rows } = await pool.query('SELECT id, username, display_name, display_color, is_admin, notification_sounds_enabled FROM users WHERE id=$1', [req.user.sub]);
  const me = rows[0] || null;
  if (!me) return res.status(404).json({ error: 'not_found' });
  me.is_admin = userCanAdmin(me);
  res.json(me);
});

app.patch('/api/me/profile', auth, enforceSessionVersion, async (req, res) => {
  const displayName = String(req.body.displayName || '').trim();
  const displayColorRaw = String(req.body.displayColor || '').trim();
  if (!displayName) return res.status(400).json({ error: 'display_name_required' });
  const displayColor = displayColorRaw ? displayColorRaw.toUpperCase() : null;
  if (displayColor && !/^#[0-9A-F]{6}$/i.test(displayColor)) return res.status(400).json({ error: 'invalid_color' });
  const { rows } = await pool.query(
    'UPDATE users SET display_name = $1, display_color = $2 WHERE id = $3 RETURNING id, username, display_name, display_color, is_admin, notification_sounds_enabled',
    [displayName, displayColor, req.user.sub]
  );
  res.json(rows[0]);
});


app.patch('/api/me/preferences', auth, enforceSessionVersion, async (req, res) => {
  if (typeof req.body.notificationSoundsEnabled !== 'boolean') {
    return res.status(400).json({ error: 'invalid_notification_preference' });
  }
  const enabled = req.body.notificationSoundsEnabled === true;
  const { rows } = await pool.query(
    'UPDATE users SET notification_sounds_enabled = $1 WHERE id = $2 RETURNING id, username, display_name, display_color, is_admin, notification_sounds_enabled',
    [enabled, req.user.sub]
  );
  const me = rows[0] || null;
  if (!me) return res.status(404).json({ error: 'not_found' });
  me.is_admin = userCanAdmin(me);
  res.json(me);
});

app.get('/api/channels', auth, enforceSessionVersion, async (_req, res) => {
  const settings = await pool.query('SELECT value FROM app_settings WHERE key = $1', ['voice_enabled']);
  const voiceEnabled = settings.rows[0] ? settings.rows[0].value !== false : true;
  const { rows } = await pool.query(
    'SELECT id, name, kind, position FROM channels WHERE archived=false AND ($1::boolean = true OR kind <> $2) ORDER BY kind ASC, position ASC, id ASC',
    [voiceEnabled, 'voice']
  );
  res.json(rows);
});

app.post('/api/admin/channels', auth, enforceSessionVersion, adminOnly, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const kind = String(req.body.kind || 'text');
  if (!name) return res.status(400).json({ error: 'name_required' });
  if (!['text', 'voice'].includes(kind)) return res.status(400).json({ error: 'invalid_kind' });
  const pos = await pool.query('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM channels WHERE kind = $1', [kind]);
  await pool.query('INSERT INTO channels(name, kind, position, archived) VALUES ($1, $2, $3, false)', [name, kind, Number(pos.rows[0].next)]);
  res.json({ ok: true });
});

app.patch('/api/admin/channels/:id', auth, enforceSessionVersion, adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });
  const name = req.body.name === undefined ? null : String(req.body.name).trim();
  const position = req.body.position === undefined ? null : Number(req.body.position);
  const archived = req.body.archived === undefined ? null : req.body.archived === true;
  const current = await pool.query('SELECT id FROM channels WHERE id = $1', [id]);
  if (!current.rows[0]) return res.status(404).json({ error: 'not_found' });
  if (name !== null) {
    if (!name) return res.status(400).json({ error: 'name_required' });
    await pool.query('UPDATE channels SET name = $1 WHERE id = $2', [name, id]);
  }
  if (position !== null) {
    if (!Number.isFinite(position) || position < 1) return res.status(400).json({ error: 'invalid_position' });
    await pool.query('UPDATE channels SET position = $1 WHERE id = $2', [Math.round(position), id]);
  }
  if (archived !== null) {
    await pool.query('UPDATE channels SET archived = $1 WHERE id = $2', [archived, id]);
  }
  res.json({ ok: true });
});

app.delete('/api/admin/channels/:id', auth, enforceSessionVersion, adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });
  await pool.query('UPDATE channels SET archived = true WHERE id = $1', [id]);
  res.json({ ok: true });
});

app.get('/api/dms', auth, enforceSessionVersion, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT u.id, u.username, u.display_name, u.display_color,
           MAX(m.created_at) AS last_message_at
    FROM users u
    LEFT JOIN messages m
      ON (
        (m.author_id = $1 AND m.dm_peer_id = u.id)
        OR
        (m.author_id = u.id AND m.dm_peer_id = $1)
      )
    WHERE u.id <> $1
    GROUP BY u.id, u.username, u.display_name, u.display_color
    ORDER BY last_message_at DESC NULLS LAST, u.username ASC
  `, [req.user.sub]);
  res.json(rows);
});

app.get('/api/admin/state', auth, enforceSessionVersion, adminOnly, async (_req, res) => {
  const invites = await pool.query('SELECT id, expires_at, created_at, used_at, revoked_at, used_by FROM invites ORDER BY id DESC LIMIT 50');
  const users = await pool.query('SELECT id, username, display_name, disabled, is_admin, created_at FROM users ORDER BY id ASC');
  const channels = await pool.query('SELECT id, name, kind, position, archived FROM channels ORDER BY kind ASC, position ASC, id ASC');
  const settings = await pool.query('SELECT key, value FROM app_settings WHERE key IN ($1, $2, $3)', ['anti_spam_level', 'voice_bitrate', 'voice_enabled']);
  const settingMap = Object.fromEntries(settings.rows.map((r) => [r.key, r.value]));
  const level = Number(settingMap.anti_spam_level ?? 5);
  res.json({
    invites: invites.rows,
    users: users.rows,
    channels: channels.rows,
    antiSpamLevel: level,
    antiSpamEffective: spamPresets[level] || spamPresets[5],
    voiceBitrate: Number(settingMap.voice_bitrate ?? 32000),
    voiceEnabled: settingMap.voice_enabled === undefined ? true : settingMap.voice_enabled !== false
  });
});

app.post('/api/admin/invites', auth, enforceSessionVersion, adminOnly, async (req, res) => {
  const raw = token(24);
  const ttlDays = Number(process.env.INVITE_TTL_DAYS || 7);
  await pool.query("INSERT INTO invites(token_hash, expires_at) VALUES($1, now() + ($2 || ' days')::interval)", [sha(raw), String(ttlDays)]);
  res.json({ inviteKey: raw, inviteUrl: `${process.env.PUBLIC_BASE_URL || ''}/register?token=${raw}` });
});

app.post('/api/admin/invites/:id/revoke', auth, enforceSessionVersion, adminOnly, async (req, res) => {
  await pool.query('UPDATE invites SET revoked_at = now() WHERE id = $1 AND used_at IS NULL', [Number(req.params.id)]);
  res.json({ ok: true });
});

app.get('/api/admin/invites/export', auth, enforceSessionVersion, adminOnly, async (_req, res) => {
  const { rows } = await pool.query('SELECT id, expires_at, created_at, used_at, revoked_at, used_by FROM invites ORDER BY id DESC');
  const header = 'id,expires_at,created_at,used_at,revoked_at,used_by';
  const csv = [
    header,
    ...rows.map((r) => [
      r.id,
      r.expires_at?.toISOString?.() || '',
      r.created_at?.toISOString?.() || '',
      r.used_at?.toISOString?.() || '',
      r.revoked_at?.toISOString?.() || '',
      r.used_by || ''
    ].join(','))
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="invites-export.csv"');
  res.send(csv);
});

app.post('/api/admin/users/:id/disable', auth, enforceSessionVersion, adminOnly, async (req, res) => {
  const disabled = req.body.disabled === true;
  await pool.query('UPDATE users SET disabled = $1 WHERE id = $2 AND username <> $3 AND is_admin = false', [disabled, Number(req.params.id), ADMIN_USERNAME]);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/admin', auth, enforceSessionVersion, adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  const isAdmin = req.body.isAdmin === true;
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });
  const u = await pool.query('SELECT id, username FROM users WHERE id = $1', [id]);
  const user = u.rows[0];
  if (!user) return res.status(404).json({ error: 'not_found' });
  if (user.username === ADMIN_USERNAME) return res.status(400).json({ error: 'cannot_demote_primary_admin' });
  await pool.query('UPDATE users SET is_admin = $1 WHERE id = $2', [isAdmin, id]);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/delete', auth, enforceSessionVersion, adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });

  const confirmUsername = String(req.body.confirmUsername || '');
  const confirmChecked = req.body.confirmChecked === true;
  if (!confirmChecked) return res.status(400).json({ error: 'confirm_checkbox_required' });

  const u = await pool.query('SELECT id, username FROM users WHERE id = $1', [id]);
  const user = u.rows[0];
  if (!user) return res.status(404).json({ error: 'not_found' });
  const ua = await pool.query('SELECT is_admin FROM users WHERE id = $1', [id]);
  if (user.username === ADMIN_USERNAME || ua.rows[0]?.is_admin) return res.status(400).json({ error: 'cannot_delete_admin' });
  if (confirmUsername !== user.username) return res.status(400).json({ error: 'confirm_username_mismatch' });

  const client = await pool.connect();
  const filesToDelete = [];
  try {
    await client.query('BEGIN');

    const uploads = await client.query('SELECT storage_name FROM uploads WHERE owner_id = $1', [id]);
    filesToDelete.push(...uploads.rows.map((r) => r.storage_name));

    await client.query('UPDATE invites SET used_by = NULL WHERE used_by = $1', [id]);
    await client.query('DELETE FROM messages WHERE author_id = $1 OR dm_peer_id = $1', [id]);
    await client.query('DELETE FROM uploads WHERE owner_id = $1', [id]);
    await client.query('DELETE FROM users WHERE id = $1', [id]);

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  for (const name of filesToDelete) {
    await fsp.rm(path.join(uploadsDir, name), { force: true });
  }

  const payload = JSON.stringify({ type: 'user_deleted', data: { id } });
  for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
  res.json({ ok: true });
});

app.post('/api/admin/settings', auth, enforceSessionVersion, adminOnly, async (req, res) => {
  const level = sanitizeSpamLevel(req.body.antiSpamLevel);
  const bitrate = sanitizeBitrate(req.body.voiceBitrate);
  let voiceEnabled = null;
  if (level !== null) {
    await pool.query('INSERT INTO app_settings(key, value) VALUES ($1, $2::jsonb) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value', ['anti_spam_level', JSON.stringify(level)]);
  }
  if (bitrate !== null) {
    await pool.query('INSERT INTO app_settings(key, value) VALUES ($1, $2::jsonb) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value', ['voice_bitrate', JSON.stringify(bitrate)]);
  }
  if (typeof req.body.voiceEnabled === 'boolean') {
    await pool.query('INSERT INTO app_settings(key, value) VALUES ($1, $2::jsonb) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value', ['voice_enabled', JSON.stringify(req.body.voiceEnabled)]);
    voiceEnabled = req.body.voiceEnabled;
  }
  if (voiceEnabled === null) {
    const settings = await pool.query('SELECT value FROM app_settings WHERE key = $1', ['voice_enabled']);
    voiceEnabled = settings.rows[0] ? settings.rows[0].value !== false : true;
  }
  const finalLevel = level ?? 5;
  res.json({
    ok: true,
    antiSpamLevel: finalLevel,
    antiSpamEffective: spamPresets[finalLevel],
    voiceBitrate: bitrate ?? 32000,
    voiceEnabled
  });
});

app.post('/api/admin/recovery', auth, enforceSessionVersion, adminOnly, async (req, res) => {
  const { username } = req.body;
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  const raw = token(24);
  await pool.query("INSERT INTO recovery_tokens(user_id, token_hash, expires_at) VALUES($1,$2, now() + interval '1 hour')", [rows[0].id, sha(raw)]);
  res.json({ recoveryKey: raw, recoveryUrl: `${process.env.PUBLIC_BASE_URL || ''}/recover?token=${raw}` });
});

app.post('/api/recovery/redeem', authRateLimit({ windowMs: 10 * 60 * 1000, max: 10, blockMs: 15 * 60 * 1000, bucket: 'recovery_redeem' }), async (req, res) => {
  const { token: raw } = req.body;
  const { rows } = await pool.query('SELECT * FROM recovery_tokens WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now()', [sha(raw || '')]);
  if (!rows[0]) return res.status(400).json({ error: 'invalid_token' });
  await pool.query('UPDATE users SET session_version = session_version + 1 WHERE id = $1', [rows[0].user_id]);
  await pool.query('UPDATE recovery_tokens SET clicked_at = now() WHERE id = $1 AND clicked_at IS NULL', [rows[0].id]);
  res.json({ redeemId: rows[0].id });
});

app.post('/api/recovery/reset', authRateLimit({ windowMs: 10 * 60 * 1000, max: 10, blockMs: 15 * 60 * 1000, bucket: 'recovery_reset' }), async (req, res) => {
  const { redeemId, password } = req.body;
  const { rows } = await pool.query('SELECT * FROM recovery_tokens WHERE id=$1 AND used_at IS NULL AND expires_at > now()', [redeemId]);
  if (!rows[0]) return res.status(400).json({ error: 'invalid_token' });
  const pw = await bcrypt.hash(password, 12);
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [pw, rows[0].user_id]);
  await pool.query('UPDATE recovery_tokens SET used_at = now() WHERE id=$1', [redeemId]);
  res.json({ ok: true });
});


function normalizeMentionKey(v) {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, '');
}

function extractMentionTokens(body = '') {
  const out = [];
  const re = /(^|\s)@([A-Za-z0-9_.-]+)/g;
  let m;
  while ((m = re.exec(String(body || ''))) !== null) out.push(normalizeMentionKey(m[2]));
  return [...new Set(out.filter(Boolean))];
}

async function createNotificationsForMessage(msg, author) {
  const recipients = new Map();
  if (msg.dm_peer_id) {
    const peerId = Number(msg.dm_peer_id);
    if (peerId && peerId !== Number(author.id)) recipients.set(peerId, { kind: 'dm', dmPeerId: Number(author.id), channelId: null });
  }
  const mentionKeys = extractMentionTokens(msg.body || '');
  if (mentionKeys.length) {
    const { rows } = await pool.query('SELECT id, username, display_name FROM users WHERE id <> $1', [author.id]);
    for (const u of rows) {
      const keys = [normalizeMentionKey(u.username), normalizeMentionKey(u.display_name)].filter(Boolean);
      if (keys.some((k) => mentionKeys.includes(k))) {
        const existing = recipients.get(Number(u.id));
        recipients.set(Number(u.id), {
          kind: existing?.kind === 'dm' ? 'dm' : 'ping',
          dmPeerId: msg.dm_peer_id ? Number(author.id) : null,
          channelId: msg.channel_id ? Number(msg.channel_id) : null
        });
      }
    }
  }
  if (msg.reply_author_id) {
    const replyTargetId = Number(msg.reply_author_id);
    if (replyTargetId && replyTargetId !== Number(author.id)) {
      const existing = recipients.get(replyTargetId);
      recipients.set(replyTargetId, {
        kind: existing?.kind === 'dm' ? 'dm' : 'ping',
        dmPeerId: msg.dm_peer_id ? Number(author.id) : null,
        channelId: msg.channel_id ? Number(msg.channel_id) : null
      });
    }
  }
  const out = [];
  for (const [userId, meta] of recipients.entries()) {
    const r = await pool.query(
      `INSERT INTO notifications(user_id, message_id, kind, channel_id, dm_peer_id)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, message_id, kind) DO UPDATE SET created_at = now()
       RETURNING id, user_id, message_id, kind, channel_id, dm_peer_id, created_at`,
      [userId, msg.id, meta.kind, meta.channelId, meta.dmPeerId]
    );
    out.push(r.rows[0]);
  }
  return out;
}

app.post('/api/messages', auth, enforceSessionVersion, async (req, res) => {
  const { channelId = null, dmPeerId = null, body, replyToId = null, uploadIds = [] } = req.body;
  if (req.userDb.disabled) return res.status(403).json({ error: 'disabled' });
  if (!channelId && !dmPeerId) return res.status(400).json({ error: 'target_required' });
  const text = String(body || '').slice(0, 10000);
  const ids = Array.isArray(uploadIds)
    ? [...new Set(uploadIds.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0))].slice(0, 8)
    : [];
  if (!text.trim() && ids.length === 0) return res.status(400).json({ error: 'empty_body' });
  let replyMeta = null;
  if (replyToId) {
    const { rows } = await pool.query('SELECT id, channel_id, dm_peer_id, author_id, body FROM messages WHERE id = $1', [Number(replyToId)]);
    const r = rows[0];
    if (!r) return res.status(400).json({ error: 'invalid_reply_target' });
    if (channelId && Number(r.channel_id) !== Number(channelId)) return res.status(400).json({ error: 'invalid_reply_target' });
    if (dmPeerId) {
      const me = Number(req.user.sub);
      const peer = Number(dmPeerId);
      const ok = (Number(r.author_id) === me && Number(r.dm_peer_id) === peer) || (Number(r.author_id) === peer && Number(r.dm_peer_id) === me);
      if (!ok) return res.status(400).json({ error: 'invalid_reply_target' });
    }
    replyMeta = { id: r.id, body: r.body, author_id: r.author_id };
  }
  const result = await pool.query('INSERT INTO messages(author_id, channel_id, dm_peer_id, reply_to, body) VALUES($1,$2,$3,$4,$5) RETURNING id, author_id, channel_id, dm_peer_id, reply_to, body, created_at, edited_at', [req.user.sub, channelId, dmPeerId, replyToId ? Number(replyToId) : null, text]);
  const msg = result.rows[0];
  if (ids.length) {
    const validUploads = await pool.query('SELECT id FROM uploads WHERE id = ANY($1::bigint[]) AND owner_id = $2', [ids, req.user.sub]);
    for (const u of validUploads.rows) {
      await pool.query('INSERT INTO message_uploads(message_id, upload_id) VALUES($1, $2) ON CONFLICT DO NOTHING', [msg.id, u.id]);
    }
  }
  const uploads = await pool.query('SELECT u.id, u.content_type FROM message_uploads mu JOIN uploads u ON u.id = mu.upload_id WHERE mu.message_id = $1 ORDER BY u.id ASC', [msg.id]);
  const enriched = {
    ...msg,
    username: req.userDb.username,
    display_name: req.userDb.display_name,
    display_color: req.userDb.display_color,
    dm_user_a: msg.dm_peer_id ? Number(req.user.sub) : null,
    dm_user_b: msg.dm_peer_id ? Number(msg.dm_peer_id) : null,
    reply_to: msg.reply_to,
    reply_body: replyMeta?.body || null,
    reply_author_id: replyMeta?.author_id || null,
    uploads: uploads.rows.map((u) => ({ id: u.id, content_type: u.content_type, url: `/api/uploads/${u.id}` }))
  };
  const payload = JSON.stringify({ type: 'message', data: enriched });
  for (const c of wss.clients) if (c.readyState === 1) c.send(payload);

  const created = await createNotificationsForMessage(enriched, req.userDb);
  for (const n of created) {
    for (const c of wss.clients) {
      if (c.readyState !== 1 || Number(c.voice?.userId || 0) !== Number(n.user_id)) continue;
      c.send(JSON.stringify({
        type: 'notification',
        data: {
          id: n.id,
          messageId: n.message_id,
          mode: n.dm_peer_id ? 'dm' : 'channel',
          channelId: n.channel_id ? Number(n.channel_id) : null,
          dmPeerId: n.dm_peer_id ? Number(n.dm_peer_id) : null,
          createdAt: n.created_at,
          title: n.kind === 'dm' ? `DM from ${req.userDb.display_name || req.userDb.username}` : `Ping from ${req.userDb.display_name || req.userDb.username}`,
          preview: (enriched.body || '').slice(0, 140) || '(attachment)'
        }
      }));
    }
  }
  res.json(enriched);
});

app.patch('/api/messages/:id', auth, enforceSessionVersion, async (req, res) => {
  const id = Number(req.params.id);
  const body = String(req.body.body || '').slice(0, 10000);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });
  if (!body.trim()) return res.status(400).json({ error: 'empty_body' });
  const q = await pool.query('SELECT author_id FROM messages WHERE id = $1', [id]);
  const m = q.rows[0];
  if (!m) return res.status(404).json({ error: 'not_found' });
  if (Number(m.author_id) !== Number(req.user.sub) && !userCanAdmin(req.userDb)) return res.status(403).json({ error: 'forbidden' });
  const r = await pool.query('UPDATE messages SET body = $1, edited_at = now() WHERE id = $2 RETURNING id, edited_at', [body, id]);
  const payload = JSON.stringify({ type: 'message_edited', data: { id: r.rows[0].id, body, edited_at: r.rows[0].edited_at } });
  for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
  res.json({ ok: true, id, body });
});

app.delete('/api/messages/:id', auth, enforceSessionVersion, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });
  const q = await pool.query('SELECT author_id FROM messages WHERE id = $1', [id]);
  const m = q.rows[0];
  if (!m) return res.status(404).json({ error: 'not_found' });
  if (Number(m.author_id) !== Number(req.user.sub) && !userCanAdmin(req.userDb)) return res.status(403).json({ error: 'forbidden' });
  const r = await pool.query('DELETE FROM messages WHERE id = $1', [id]);
  const payload = JSON.stringify({ type: 'message_deleted', data: { id } });
  for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
  res.json({ ok: true });
});

app.get('/api/messages/since/:id', auth, enforceSessionVersion, async (req, res) => {
  const since = Number(req.params.id);
  const channelId = req.query.channelId ? Number(req.query.channelId) : null;
  const dmPeerId = req.query.dmPeerId ? Number(req.query.dmPeerId) : null;

  let rows;
  if (channelId) {
    ({ rows } = await pool.query(`
      SELECT m.id, m.author_id, m.body, m.created_at, m.edited_at, m.channel_id, m.dm_peer_id, m.reply_to,
             u.username, u.display_name, u.display_color,
             rm.body AS reply_body, rm.author_id AS reply_author_id
      FROM messages m
      JOIN users u ON u.id=m.author_id
      LEFT JOIN messages rm ON rm.id = m.reply_to
      WHERE m.id > $1 AND m.channel_id = $2
      ORDER BY m.id ASC LIMIT 500
    `, [since, channelId]));
  } else if (dmPeerId) {
    ({ rows } = await pool.query(`
      SELECT m.id, m.author_id, m.body, m.created_at, m.edited_at, m.channel_id,
             CASE WHEN m.author_id = $2 THEN m.dm_peer_id ELSE m.author_id END AS dm_peer_id,
             u.username, u.display_name, u.display_color,
             LEAST(m.author_id, m.dm_peer_id) AS dm_user_a,
             GREATEST(m.author_id, m.dm_peer_id) AS dm_user_b,
             m.reply_to, rm.body AS reply_body, rm.author_id AS reply_author_id
      FROM messages m
      JOIN users u ON u.id = m.author_id
      LEFT JOIN messages rm ON rm.id = m.reply_to
      WHERE m.id > $1
        AND ((m.author_id = $2 AND m.dm_peer_id = $3) OR (m.author_id = $3 AND m.dm_peer_id = $2))
      ORDER BY m.id ASC
      LIMIT 500
    `, [since, req.user.sub, dmPeerId]));
  } else {
    ({ rows } = await pool.query('SELECT m.id, m.author_id, m.body, m.created_at, m.edited_at, m.channel_id, m.dm_peer_id, m.reply_to, u.username, u.display_name, u.display_color, rm.body AS reply_body, rm.author_id AS reply_author_id FROM messages m JOIN users u ON u.id=m.author_id LEFT JOIN messages rm ON rm.id=m.reply_to WHERE m.id > $1 ORDER BY m.id ASC LIMIT 500', [since]));
  }
  const messageIds = rows.map((r) => Number(r.id)).filter((v) => Number.isFinite(v));
  const byId = new Map();
  if (messageIds.length) {
    const upl = await pool.query('SELECT mu.message_id, u.id, u.content_type FROM message_uploads mu JOIN uploads u ON u.id = mu.upload_id WHERE mu.message_id = ANY($1::bigint[]) ORDER BY u.id ASC', [messageIds]);
    for (const r of upl.rows) {
      const arr = byId.get(Number(r.message_id)) || [];
      arr.push({ id: r.id, content_type: r.content_type, url: `/api/uploads/${r.id}` });
      byId.set(Number(r.message_id), arr);
    }
  }
  for (const r of rows) {
    r.uploads = byId.get(Number(r.id)) || [];
  }
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


app.get('/api/notifications', auth, enforceSessionVersion, async (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 60)));
  const { rows } = await pool.query(`
    SELECT n.id, n.message_id, n.kind, n.channel_id, n.dm_peer_id, n.created_at,
           m.body,
           au.username AS author_username,
           au.display_name AS author_display_name
    FROM notifications n
    JOIN messages m ON m.id = n.message_id
    JOIN users au ON au.id = m.author_id
    WHERE n.user_id = $1
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT $2
  `, [req.user.sub, limit]);
  res.json(rows.map((r) => ({
    id: Number(r.id),
    messageId: Number(r.message_id),
    mode: r.dm_peer_id ? 'dm' : 'channel',
    channelId: r.channel_id ? Number(r.channel_id) : null,
    dmPeerId: r.dm_peer_id ? Number(r.dm_peer_id) : null,
    createdAt: r.created_at,
    title: r.kind === 'dm' ? `DM from ${r.author_display_name || r.author_username}` : `Ping from ${r.author_display_name || r.author_username}`,
    preview: String(r.body || '').slice(0, 140) || '(attachment)'
  })));
});

app.delete('/api/notifications/:id', auth, enforceSessionVersion, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });
  await pool.query('DELETE FROM notifications WHERE id = $1 AND user_id = $2', [id, req.user.sub]);
  res.json({ ok: true });
});

app.get('/api/messages/:id', auth, enforceSessionVersion, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });
  const { rows } = await pool.query('SELECT id, author_id, channel_id, dm_peer_id FROM messages WHERE id = $1', [id]);
  const m = rows[0];
  if (!m) return res.status(404).json({ error: 'not_found' });
  if (m.channel_id) return res.json({ id: Number(m.id), channelId: Number(m.channel_id), dmPeerId: null });
  const me = Number(req.user.sub);
  if (Number(m.author_id) !== me && Number(m.dm_peer_id) !== me) return res.status(403).json({ error: 'forbidden' });
  const peer = Number(m.author_id) === me ? Number(m.dm_peer_id) : Number(m.author_id);
  res.json({ id: Number(m.id), channelId: null, dmPeerId: peer });
});

wss.on('connection', async (ws, req) => {
  ws.voice = { userId: null, room: null, username: null };
  try {
    const cookies = parseCookieHeader(req.headers.cookie || '');
    const raw = cookies.gc_session;
    if (raw) {
      const data = jwt.verify(raw, JWT_SECRET);
      const { rows } = await pool.query('SELECT id, username, session_version, disabled FROM users WHERE id = $1', [data.sub]);
      const u = rows[0];
      if (u && !u.disabled && u.session_version === data.sv) {
        ws.voice.userId = Number(u.id);
        ws.voice.username = u.username;
      }
    }
  } catch {}

  ws.send(JSON.stringify({ type: 'hello' }));

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(String(buf)); } catch { return; }
    if (!ws.voice.userId) return;

    if (msg.type === 'voice_join') {
      const room = String(msg.room || '').slice(0, 64);
      if (!room) return;
      ws.voice.room = room;
      for (const c of wss.clients) {
        if (c === ws || c.readyState !== 1) continue;
        if (c.voice?.room === room && c.voice?.userId) {
          c.send(JSON.stringify({ type: 'voice_peer_joined', data: { userId: ws.voice.userId, username: ws.voice.username } }));
          ws.send(JSON.stringify({ type: 'voice_peer_joined', data: { userId: c.voice.userId, username: c.voice.username } }));
        }
      }
      return;
    }

    if (msg.type === 'voice_leave') {
      const room = ws.voice.room;
      ws.voice.room = null;
      if (!room) return;
      for (const c of wss.clients) {
        if (c.readyState !== 1 || c.voice?.room !== room || c === ws) continue;
        c.send(JSON.stringify({ type: 'voice_peer_left', data: { userId: ws.voice.userId } }));
      }
      return;
    }

    if (!['voice_offer', 'voice_answer', 'voice_ice'].includes(msg.type)) return;
    const targetUserId = Number(msg.targetUserId);
    if (!Number.isFinite(targetUserId)) return;
    for (const c of wss.clients) {
      if (c.readyState !== 1 || c.voice?.userId !== targetUserId) continue;
      c.send(JSON.stringify({
        type: msg.type,
        data: { fromUserId: ws.voice.userId, fromUsername: ws.voice.username, sdp: msg.sdp, candidate: msg.candidate }
      }));
      break;
    }
  });

  ws.on('close', () => {
    const room = ws.voice?.room;
    const userId = ws.voice?.userId;
    if (!room || !userId) return;
    for (const c of wss.clients) {
      if (c.readyState !== 1 || c.voice?.room !== room || c === ws) continue;
      c.send(JSON.stringify({ type: 'voice_peer_left', data: { userId } }));
    }
  });
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
server.listen(port, () => console.log(`api on ${port} (version ${APP_VERSION} via ${APP_VERSION_SOURCE})`));
