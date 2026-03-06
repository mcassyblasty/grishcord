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

class ConversationQueue {
  constructor(maxConcurrency) {
    this.maxConcurrency = Math.max(1, Number(maxConcurrency || 1));
    this.inflight = new Map();
    this.queues = new Map();
  }

  run(conversationKey, fn) {
    const key = String(conversationKey);
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
    this.lastReplyAtByConversation = new Map();
    this.contextByConversation = new Map();
    this.queue = new ConversationQueue(config.maxConcurrencyPerChannel);
  }

  async start() {
    await this.ollama.checkReachable();
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
    const mode = String(notification.mode || '');
    if (!['channel', 'dm'].includes(mode)) return;

    if (mode === 'dm' && !this.config.enableDms) {
      console.log('[aibot] ignoring notification: dm handling disabled by BOT_ENABLE_DMS=false');
      return;
    }

    if (mode === 'channel' && !this.config.enableChannels) {
      console.log('[aibot] ignoring notification: channel handling disabled by BOT_ENABLE_CHANNELS=false');
      return;
    }

    if (mode === 'channel') {
      const notificationChannelId = Number(notification.channelId || 0);
      const allowlist = Array.isArray(this.config.allowedChannelIds) ? this.config.allowedChannelIds : [];
      if (allowlist.length && (!Number.isFinite(notificationChannelId) || !allowlist.includes(notificationChannelId))) {
        console.log('[aibot] ignoring notification: channel not in BOT_ALLOWED_CHANNEL_IDS', notification.channelId || null);
        return;
      }
      const title = String(notification.title || '').toLowerCase();
      if (!title.includes('ping')) return;
    }

    const messageId = Number(notification.messageId || 0);
    if (!Number.isFinite(messageId) || messageId <= 0) return;

    const target = await this.client.getMessageTarget(messageId);

    if (mode === 'dm') {
      const dmPeerId = Number(target?.dmPeerId || notification.dmPeerId || 0);
      if (!Number.isFinite(dmPeerId) || dmPeerId <= 0) return;
      const conversationKey = `dm:${dmPeerId}`;
      await this.queue.run(conversationKey, async () => {
        const lastAt = this.lastReplyAtByConversation.get(conversationKey) || 0;
        if (nowMs() - lastAt < this.config.rateLimitMs) return;

        const rows = await this.client.getDmWindow(messageId, dmPeerId, this.config.contextMaxMessages);
        const triggerCount = rows.filter((r) => Number(r.id) === messageId).length;
        if (triggerCount === 0) {
          console.warn('[aibot] missing trigger in window', { mode: 'dm', dmPeerId, triggerId: messageId });
          return;
        }
        if (triggerCount > 1) {
          console.warn('[aibot] duplicate trigger in window', { mode: 'dm', dmPeerId, triggerId: messageId, triggerCount });
          return;
        }
        const trigger = rows.find((r) => Number(r.id) === messageId);
        if (Number(trigger.author_id) === this.botUserId) return;

        const llmMessages = await this.#buildMessages(rows);
        this.#logContextWindow({ mode: 'dm', triggerId: messageId, llmMessages, allowlistApplied: false });
        if (llmMessages.length <= 1) {
          console.warn('[aibot] unexpected empty context window', { mode: 'dm', dmPeerId, triggerId: messageId });
          return;
        }
        let raw;
        try {
          raw = await this.ollama.generate(llmMessages);
        } catch (err) {
          if (String(err?.message || '').toLowerCase().includes('timeout')) {
            console.error('[aibot] ollama timeout', { mode: 'dm', dmPeerId, triggerId: messageId, error: err.message });
            await this.#maybeSendErrorReply({ mode: 'dm', dmPeerId, messageId, fallbackText: 'Timed out, try again.', reason: 'timeout' });
          } else {
            console.error('[aibot] ollama error', { mode: 'dm', dmPeerId, triggerId: messageId, error: err.message });
            await this.#maybeSendErrorReply({ mode: 'dm', dmPeerId, messageId, fallbackText: 'I hit an error, try again.', reason: 'ollama_error' });
          }
          throw err;
        }
        const safe = sanitizeOutbound(raw).slice(0, this.config.maxReplyChars);
        if (!safe) {
          console.warn('[aibot] empty model output', { mode: 'dm', dmPeerId, triggerId: messageId });
          await this.#maybeSendErrorReply({ mode: 'dm', dmPeerId, messageId, fallbackText: 'I hit an error, try again.', reason: 'empty_model_output' });
          return;
        }

        try {
          await this.client.postDmReply(dmPeerId, messageId, safe);
        } catch (err) {
          console.error('[aibot] reply post failed', { mode: 'dm', dmPeerId, triggerId: messageId, error: err.message });
          throw err;
        }
        this.lastReplyAtByConversation.set(conversationKey, nowMs());
        this.#remember(conversationKey, { role: 'assistant', content: safe });
      });
      return;
    }

    const channelId = Number(target?.channelId || notification.channelId || 0);
    if (!Number.isFinite(channelId) || channelId <= 0) return;
    if (Array.isArray(this.config.allowedChannelIds) && this.config.allowedChannelIds.length && !this.config.allowedChannelIds.includes(channelId)) {
      console.log('[aibot] ignoring notification: resolved channel not in BOT_ALLOWED_CHANNEL_IDS', channelId);
      return;
    }
    const conversationKey = `channel:${channelId}`;

    await this.queue.run(conversationKey, async () => {
      const lastAt = this.lastReplyAtByConversation.get(conversationKey) || 0;
      if (nowMs() - lastAt < this.config.rateLimitMs) return;

      const rows = await this.client.getChannelWindow(messageId, channelId, this.config.contextMaxMessages);
      const triggerCount = rows.filter((r) => Number(r.id) === messageId).length;
      if (triggerCount === 0) {
        console.warn('[aibot] missing trigger in window', { mode: 'channel', channelId, triggerId: messageId });
        return;
      }
      if (triggerCount > 1) {
        console.warn('[aibot] duplicate trigger in window', { mode: 'channel', channelId, triggerId: messageId, triggerCount });
        return;
      }
      const trigger = rows.find((r) => Number(r.id) === messageId);
      if (Number(trigger.author_id) === this.botUserId) return;

      const llmMessages = await this.#buildMessages(rows);
      this.#logContextWindow({ mode: 'channel', triggerId: messageId, llmMessages, allowlistApplied: Array.isArray(this.config.allowedChannelIds) && this.config.allowedChannelIds.length > 0 });
      if (llmMessages.length <= 1) {
        console.warn('[aibot] unexpected empty context window', { mode: 'channel', channelId, triggerId: messageId });
        return;
      }
      let raw;
      try {
        raw = await this.ollama.generate(llmMessages);
      } catch (err) {
        if (String(err?.message || '').toLowerCase().includes('timeout')) {
          console.error('[aibot] ollama timeout', { mode: 'channel', channelId, triggerId: messageId, error: err.message });
          await this.#maybeSendErrorReply({ mode: 'channel', channelId, messageId, fallbackText: 'Timed out, try again.', reason: 'timeout' });
        } else {
          console.error('[aibot] ollama error', { mode: 'channel', channelId, triggerId: messageId, error: err.message });
          await this.#maybeSendErrorReply({ mode: 'channel', channelId, messageId, fallbackText: 'I hit an error, try again.', reason: 'ollama_error' });
        }
        throw err;
      }
      const safe = sanitizeOutbound(raw).slice(0, this.config.maxReplyChars);
      if (!safe) {
        console.warn('[aibot] empty model output', { mode: 'channel', channelId, triggerId: messageId });
        await this.#maybeSendErrorReply({ mode: 'channel', channelId, messageId, fallbackText: 'I hit an error, try again.', reason: 'empty_model_output' });
        return;
      }

      try {
        await this.client.postReply(channelId, messageId, safe);
      } catch (err) {
        console.error('[aibot] reply post failed', { mode: 'channel', channelId, triggerId: messageId, error: err.message });
        throw err;
      }
      this.lastReplyAtByConversation.set(conversationKey, nowMs());
      this.#remember(conversationKey, { role: 'assistant', content: safe });
    });
  }


  async #maybeSendErrorReply({ mode, channelId = null, dmPeerId = null, messageId, fallbackText, reason }) {
    if (!this.config.replyOnError) return;
    try {
      if (mode === 'dm' && Number.isFinite(Number(dmPeerId)) && Number(dmPeerId) > 0) {
        await this.client.postDmReply(Number(dmPeerId), Number(messageId), fallbackText);
      } else if (mode === 'channel' && Number.isFinite(Number(channelId)) && Number(channelId) > 0) {
        await this.client.postReply(Number(channelId), Number(messageId), fallbackText);
      } else {
        return;
      }
      console.warn('[aibot] sent fallback reply', { mode, channelId, dmPeerId, messageId, reason });
    } catch (err) {
      console.error('[aibot] fallback reply failed', { mode, channelId, dmPeerId, messageId, reason, error: err.message });
    }
  }

  #logContextWindow({ mode, triggerId, llmMessages, allowlistApplied }) {
    console.info('[aibot] context window', {
      mode,
      triggerId,
      messagesToModel: Math.max(0, Number(llmMessages?.length || 0) - 1),
      allowlistApplied: Boolean(allowlistApplied)
    });
  }

  async #buildMessages(rows) {
    const systemPrompt = fs.readFileSync(this.config.promptFile, 'utf8');
    const turns = rows
      .slice(-this.config.contextMaxMessages)
      .map((r) => toLlmMessage(r, this.botUserId));
    return [{ role: 'system', content: systemPrompt }, ...turns];
  }

  #remember(conversationKey, newTurnOrTurns) {
    const key = String(conversationKey);
    const curr = this.contextByConversation.get(key);
    const nextTurns = Array.isArray(newTurnOrTurns)
      ? newTurnOrTurns
      : [...(curr?.turns || []), newTurnOrTurns];
    this.contextByConversation.set(key, {
      turns: nextTurns.slice(-this.config.contextMaxMessages),
      lastTouchedAt: nowMs()
    });
  }
}
