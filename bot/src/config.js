import fs from 'node:fs';

const DEFAULTS = {
  GRISHCORD_BASE_URL: 'http://backend:3000',
  BOT_OLLAMA_TIMEOUT_MS: '30000',
  BOT_MAX_REPLY_CHARS: '1800',
  BOT_CONTEXT_MAX_MESSAGES: '10',
  BOT_ENABLE_DMS: 'true',
  BOT_ENABLE_CHANNELS: 'true',
  BOT_ALLOWED_CHANNEL_IDS: '',
  BOT_REPLY_ON_ERROR: 'false',
  BOT_RATE_LIMIT_MS: '2000',
  BOT_MAX_CONCURRENCY_PER_CHANNEL: '1',
  BOT_PROMPT_FILE: '/config/bot/prompts/system.txt'
};

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^"|"$/g, '');
    out[key] = value;
  }
  return out;
}

function toInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function toBool(v, fallback) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function toIdList(v) {
  return [...new Set(
    String(v || '')
      .split(',')
      .map((x) => Number(String(x || '').trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
  )];
}

export function loadConfig() {
  const aibotFile = process.env.BOT_CONFIG_FILE || '/config/.aibot.env';
  const ollamaFile = process.env.OLLAMA_CONFIG_FILE || '/config/.ollama.env';
  const mergedFileEnv = { ...parseEnvFile(ollamaFile), ...parseEnvFile(aibotFile) };

  const get = (key) => {
    const rawEnv = process.env[key];
    if (rawEnv !== undefined && String(rawEnv).trim() !== '') return rawEnv;
    const fromFile = mergedFileEnv[key];
    if (fromFile !== undefined && String(fromFile).trim() !== '') return fromFile;
    return DEFAULTS[key] || '';
  };

  const cfg = {
    grishcordBaseUrl: get('GRISHCORD_BASE_URL'),
    botUsername: get('BOT_USERNAME'),
    botPassword: get('BOT_PASSWORD'),
    ollamaBaseUrl: get('OLLAMA_BASE_URL'),
    ollamaModel: get('OLLAMA_MODEL'),
    ollamaTimeoutMs: toInt(get('BOT_OLLAMA_TIMEOUT_MS'), 30000),
    maxReplyChars: toInt(get('BOT_MAX_REPLY_CHARS'), 1800),
    contextMaxMessages: toInt(get('BOT_CONTEXT_MAX_MESSAGES'), 10),
    enableDms: toBool(get('BOT_ENABLE_DMS'), true),
    enableChannels: toBool(get('BOT_ENABLE_CHANNELS'), true),
    allowedChannelIds: toIdList(get('BOT_ALLOWED_CHANNEL_IDS')),
    replyOnError: toBool(get('BOT_REPLY_ON_ERROR'), false),
    rateLimitMs: toInt(get('BOT_RATE_LIMIT_MS'), 2000),
    maxConcurrencyPerChannel: Math.max(1, toInt(get('BOT_MAX_CONCURRENCY_PER_CHANNEL'), 1)),
    promptFile: get('BOT_PROMPT_FILE') || '/config/bot/prompts/system.txt'
  };

  const required = ['botUsername', 'botPassword', 'ollamaBaseUrl', 'ollamaModel'];
  for (const key of required) {
    if (!cfg[key]) {
      throw new Error(`missing required config: ${key}`);
    }
  }
  return cfg;
}

