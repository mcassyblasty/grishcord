import fs from 'node:fs';
import { WebSocket } from 'ws';

function nowMs() { return Date.now(); }

function sanitizeOutbound(text) {
  return String(text || '')
    .replace(/@everyone/gi, '@ everyone')
    .replace(/@here/gi, '@ here')
    .trim();
}

function toLlmMessage(row, botUserId) {
  const who = Number(row.author_id) === Number(botUserId) ? 'assistant' : 'user';
  const name = row.display_name || row.username || `user-${row.author_id}`;
  return { role: who, content: `${name}: ${String(row.body || '').trim()}`.trim() };
}

class ChannelQueue {
  constructor(maxConcurrency) {
    this.maxConcurrency = Math.max(1, Number(maxConcurrency || 1));
    this.inflight = new Map();
    this.queues = new Map();
  }

  run(channelId, fn) {
    const key = Number(channelId);
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(key) || [];
      queue.push({ fn, resolve, reject });
      this.queues.set(key, queue);
      this.#drain(key);
    });
  }

  #drain(key) {
    const active = this.inflight.get(key) || 0;
    if (active >= this.maxConcurrency) return;
    const queue = this.queues.get(key) || [];
    const next = queue.shift();
    this.queues.set(key, queue);
    if (!next) return;
    this.inflight.set(key, active + 1);
    Promise.resolve()
      .then(next.fn)
      .then(next.resolve, next.reject)
      .finally(() => {
        this.inflight.set(key, (this.inflight.get(key) || 1) - 1);
        this.#drain(key);
      });
  }
}

export class NotificationBot {
  constructor({ config, client, ollama, botUserId }) {
    this.config = config;
    this.client = client;
    this.ollama = ollama;
    this.botUserId = Number(botUserId);
    this.lastReplyAtByChannel = new Map();
    this.contextByChannel = new Map();
    this.queue = new ChannelQueue(config.maxConcurrencyPerChannel);
  }

  start() {
    this.#connectWs();
  }

  #connectWs() {
    const ws = new WebSocket(this.client.wsUrl(), {
      headers: { cookie: this.client.cookie }
    });

    ws.on('open', () => {
      console.log('[aibot] connected websocket');
    });

    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(String(buf)); } catch { return; }
      if (msg?.type !== 'notification' || !msg.data) return;
      this.#handleNotification(msg.data).catch((err) => {
        console.error('[aibot] notification error', err.message);
      });
    });

    ws.on('close', () => {
      console.warn('[aibot] websocket disconnected, retrying in 2s');
      setTimeout(() => this.#connectWs(), 2000);
    });

    ws.on('error', (err) => {
      console.warn('[aibot] websocket error', err.message);
      try { ws.close(); } catch {}
    });
  }

  async #handleNotification(notification) {
    if (notification.mode !== 'channel') return;
    const title = String(notification.title || '').toLowerCase();
    if (!title.includes('ping')) return;
    const messageId = Number(notification.messageId || 0);
    if (!Number.isFinite(messageId) || messageId <= 0) return;

    const target = await this.client.getMessageTarget(messageId);
    if (!target?.channelId || target?.dmPeerId) return;
    const channelId = Number(target.channelId);
    if (!Number.isFinite(channelId) || channelId <= 0) return;

    await this.queue.run(channelId, async () => {
      const lastAt = this.lastReplyAtByChannel.get(channelId) || 0;
      if (nowMs() - lastAt < this.config.rateLimitMs) return;

      const rows = await this.client.getChannelMessages(channelId);
      const trigger = rows.find((r) => Number(r.id) === messageId);
      if (!trigger) return;
      if (Number(trigger.author_id) === this.botUserId) return;

      const llmMessages = await this.#buildMessages(channelId, rows, trigger);
      const raw = await this.ollama.generate(llmMessages);
      const safe = sanitizeOutbound(raw).slice(0, this.config.maxReplyChars);
      if (!safe) return;

      await this.client.postReply(channelId, messageId, safe);
      this.lastReplyAtByChannel.set(channelId, nowMs());
      this.#remember(channelId, { role: 'assistant', content: safe });
    });
  }

  async #buildMessages(channelId, rows, trigger) {
    const systemPrompt = fs.readFileSync(this.config.promptFile, 'utf8');
    const cKey = Number(channelId);
    const cache = this.contextByChannel.get(cKey);
    const expired = !cache || nowMs() - cache.lastTouchedAt > this.config.convoTtlMs;

    let turns = [];
    if (!expired && Array.isArray(cache.turns)) {
      turns = cache.turns.slice(-this.config.contextMaxMessages);
    } else {
      const recent = rows.slice(-this.config.contextMaxMessages).map((r) => toLlmMessage(r, this.botUserId));
      turns = recent;
    }

    const promptMessages = [
      { role: 'system', content: systemPrompt },
      ...turns,
      { role: 'user', content: `${trigger.display_name || trigger.username || 'user'}: ${String(trigger.body || '')}` }
    ];

    this.#remember(cKey, promptMessages.filter((m) => m.role !== 'system').slice(-this.config.contextMaxMessages));
    return promptMessages;
  }

  #remember(channelId, newTurnOrTurns) {
    const key = Number(channelId);
    const curr = this.contextByChannel.get(key);
    const nextTurns = Array.isArray(newTurnOrTurns)
      ? newTurnOrTurns
      : [...(curr?.turns || []), newTurnOrTurns];
    this.contextByChannel.set(key, {
      turns: nextTurns.slice(-this.config.contextMaxMessages),
      lastTouchedAt: nowMs()
    });
  }
}
