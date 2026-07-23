import { allowedJupyterEndpoint, safeJupyterPath } from './policy';

export class JupyterGatewayError extends Error { constructor(message, status = 502, code = 'jupyter_error') { super(message); this.status = status; this.code = code; } }

export class JupyterClient {
  constructor({ origin, token, timeoutMs = 12_000 }) { this.origin = origin.replace(/\/$/, ''); this.token = token; this.timeoutMs = timeoutMs; }
  async request(path, options = {}) {
    if (!allowedJupyterEndpoint(path)) throw new JupyterGatewayError('Jupyter endpoint is not permitted', 403, 'endpoint_denied');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.origin}/${path.replace(/^\//, '')}`, { ...options, signal: options.signal || controller.signal, headers: { Accept: 'application/json', ...(this.token ? { Authorization: `token ${this.token}` } : {}), ...(options.headers || {}) } });
      if (!response.ok) throw new JupyterGatewayError(`Jupyter request failed (${response.status})`, response.status, response.status === 401 || response.status === 403 ? 'unauthorized' : 'upstream_error');
      return response;
    } catch (error) { if (error instanceof JupyterGatewayError) throw error; if (error.name === 'AbortError') throw new JupyterGatewayError('Jupyter request timed out', 504, 'timeout'); throw new JupyterGatewayError('Jupyter server is unavailable', 502, 'unavailable'); } finally { clearTimeout(timer); }
  }
  async getNotebook(path, signal) { const result = await this.request(`api/contents/${safeJupyterPath(path)}?content=1`, { signal }); const body = await result.json(); if (body.type !== 'notebook' || typeof body.content !== 'object') throw new JupyterGatewayError('The requested Jupyter resource is not a notebook', 422, 'not_notebook'); return body; }
  async saveNotebook(path, notebook, signal) { const result = await this.request(`api/contents/${safeJupyterPath(path)}`, { method: 'PUT', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'notebook', format: 'json', content: notebook }) }); return result.json(); }
  async listKernels(signal) { return (await this.request('api/kernels', { signal })).json(); }
  async interruptKernel(kernelId, signal) { await this.request(`api/kernels/${encodeURIComponent(kernelId)}/interrupt`, { method: 'POST', signal }); }
}

