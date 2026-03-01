export class OllamaClient {
  constructor(baseUrl, model, timeoutMs) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async generate(messages) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, messages, stream: false }),
        signal: ctrl.signal
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`ollama request failed: ${res.status} ${text}`);
      }
      const data = await res.json();
      return String(data?.message?.content || '').trim();
    } finally {
      clearTimeout(timer);
    }
  }
}
