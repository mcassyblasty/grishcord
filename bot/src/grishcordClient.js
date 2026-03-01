const JSON_HEADERS = { 'content-type': 'application/json' };

export class GrishcordClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.cookie = '';
  }

  wsUrl() {
    const u = new URL(this.baseUrl);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/ws';
    return u.toString();
  }

  async login(username, password) {
    const res = await fetch(`${this.baseUrl}/api/login`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ username, password })
    });
    if (!res.ok) {
      throw new Error(`login failed: ${res.status}`);
    }
    const setCookie = res.headers.get('set-cookie') || '';
    const match = setCookie.match(/gc_session=[^;]+/);
    if (!match) throw new Error('missing session cookie from login');
    this.cookie = match[0];
  }

  async me() {
    return this.#request('/api/me');
  }

  async getMessageTarget(messageId) {
    return this.#request(`/api/messages/${Number(messageId)}`);
  }

  async getChannelMessages(channelId) {
    return this.#request(`/api/messages/since/0?channelId=${Number(channelId)}`);
  }

  async postReply(channelId, replyToId, body) {
    return this.#request('/api/messages', {
      method: 'POST',
      body: { channelId: Number(channelId), replyToId: Number(replyToId), body }
    });
  }

  async patchProfile(displayName, displayColor) {
    return this.#request('/api/me/profile', {
      method: 'PATCH',
      body: { displayName, displayColor }
    });
  }

  async #request(path, options = {}) {
    const method = options.method || 'GET';
    const headers = { ...(options.headers || {}) };
    if (this.cookie) headers.cookie = this.cookie;
    let body;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const res = await fetch(`${this.baseUrl}${path}`, { method, headers, body });
    if (!res.ok) {
      let payload;
      try { payload = await res.json(); } catch { payload = await res.text(); }
      throw new Error(`request ${method} ${path} failed: ${res.status} ${JSON.stringify(payload)}`);
    }
    return res.json();
  }
}
