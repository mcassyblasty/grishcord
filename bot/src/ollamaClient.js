import { execSync } from 'node:child_process';

function defaultRouteHint() {
  try {
    const out = execSync('ip route', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).find((line) => line.trim().startsWith('default '));
    return (first || out.split(/\r?\n/).find(Boolean) || '').trim();
  } catch {
    return 'unavailable (ip route command not found or failed)';
  }
}

export class OllamaClient {
  constructor(baseUrl, model, timeoutMs) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.preflightPassed = false;
    this.preflightLoggedFailure = false;
  }

  async checkReachable(timeoutMs = 2500) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { method: 'GET', signal: ctrl.signal });
      if (!res.ok) throw new Error(`status=${res.status}`);
      this.preflightPassed = true;
      return true;
    } catch (err) {
      this.preflightPassed = false;
      if (!this.preflightLoggedFailure) {
        this.preflightLoggedFailure = true;
        console.error('[aibot] Ollama preflight failed:', err.message);
        console.error(`[aibot] OLLAMA_BASE_URL=${this.baseUrl}`);
        console.error(`[aibot] container route hint: ${defaultRouteHint()}`);
        console.error('[aibot] If host firewalls are enabled, allow Docker bridge/container subnet access to tcp/11434 on the host.');
      }
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async ensureReachable() {
    if (this.preflightPassed) return true;
    return this.checkReachable();
  }

  async generate(messages) {
    await this.ensureReachable();

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
    } catch (err) {
      if (String(err?.name || '').toLowerCase() === 'aborterror') {
        throw new Error(`ollama request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
