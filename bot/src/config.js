import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  GRISHCORD_BASE_URL: 'http://backend:3000',
  BOT_OLLAMA_TIMEOUT_MS: '30000',
  BOT_MAX_REPLY_CHARS: '1800',
  BOT_CONTEXT_MAX_MESSAGES: '30',
  BOT_CONVO_TTL_MS: '900000',
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

export function loadConfig() {
  const aibotFile = process.env.BOT_CONFIG_FILE || '/config/.aibot.env';
  const ollamaFile = process.env.OLLAMA_CONFIG_FILE || '/config/.ollama.env';
  const mergedFileEnv = { ...parseEnvFile(ollamaFile), ...parseEnvFile(aibotFile) };

  const get = (key) => process.env[key] || mergedFileEnv[key] || DEFAULTS[key] || '';

  const cfg = {
    grishcordBaseUrl: get('GRISHCORD_BASE_URL'),
    botUsername: get('BOT_USERNAME'),
    botPassword: get('BOT_PASSWORD'),
    ollamaBaseUrl: get('OLLAMA_BASE_URL'),
    ollamaModel: get('OLLAMA_MODEL'),
    ollamaTimeoutMs: toInt(get('BOT_OLLAMA_TIMEOUT_MS'), 30000),
    maxReplyChars: toInt(get('BOT_MAX_REPLY_CHARS'), 1800),
    contextMaxMessages: toInt(get('BOT_CONTEXT_MAX_MESSAGES'), 30),
    convoTtlMs: toInt(get('BOT_CONVO_TTL_MS'), 900000),
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

export function resolvePath(...parts) {
  return path.resolve(...parts);
}
