export class BridgeClient {
  constructor(port) {
    this.port = port;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { ok: false, error: text }; }
    if (!response.ok) {
      const error = new Error(data?.error || data?.reason || `bridge ${response.status}`);
      error.data = data;
      error.status = response.status;
      throw error;
    }
    return data;
  }

  health() { return this.request('/health'); }
  state() { return this.request('/state'); }
  characters() { return this.request('/characters'); }
  tools() { return this.request('/tools'); }
  status(section) { return this.request(`/status${section ? `?section=${encodeURIComponent(section)}` : ''}`); }
  safeTool(name, args = {}) { return this.request('/safe-tool', { method: 'POST', body: JSON.stringify({ name, args }) }); }
  action(payload) { return this.request('/action', { method: 'POST', body: JSON.stringify(payload) }); }
}
