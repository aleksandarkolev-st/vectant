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
  async startKernel({ path, kernelName, signal }) {
    const response = await this.request('api/sessions', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: safeJupyterPath(path), type: 'notebook', name: path.split('/').pop(), kernel: kernelName ? { name: kernelName } : {} }) });
    return response.json();
  }
  async execute({ kernelId, code, signal, onOutput = () => {} }) {
    if (!kernelId || !code) throw new JupyterGatewayError('Kernel and code are required', 400, 'invalid_execution');
    const protocol = this.origin.startsWith('https:') ? 'wss:' : 'ws:';
    const origin = new URL(this.origin); const wsUrl = `${protocol}//${origin.host}/api/kernels/${encodeURIComponent(kernelId)}/channels${this.token ? `?token=${encodeURIComponent(this.token)}` : ''}`;
    const Socket = globalThis.WebSocket;
    if (!Socket) throw new JupyterGatewayError('Server runtime does not support Jupyter channels', 501, 'channels_unsupported');
    return new Promise((resolve, reject) => {
      let completed = false; const outputs = []; const messageId = crypto.randomUUID(); const socket = new Socket(wsUrl);
      const finish = (result) => { if (completed) return; completed = true; try { socket.close(); } catch {} result.error ? reject(result.error) : resolve({ outputs, executionState: result.executionState || 'idle' }); };
      const abort = () => { this.interruptKernel(kernelId).catch(() => {}); finish({ error: new JupyterGatewayError('Execution state is unknown after cancellation', 499, 'execution_unknown') }); };
      if (signal) signal.addEventListener('abort', abort, { once: true });
      socket.addEventListener('open', () => socket.send(JSON.stringify({ header: { msg_id: messageId, username: 'vectant', session: messageId, msg_type: 'execute_request', version: '5.3' }, parent_header: {}, metadata: {}, content: { code, silent: false, store_history: true, allow_stdin: false, stop_on_error: true }, channel: 'shell' })));
      socket.addEventListener('message', (event) => { try { const message = JSON.parse(String(event.data)); if (message.parent_header?.msg_id !== messageId) return; if (['stream', 'display_data', 'execute_result', 'error'].includes(message.msg_type)) { outputs.push({ output_type: message.msg_type, ...message.content }); onOutput(message.content); } if (message.msg_type === 'status' && message.content?.execution_state === 'idle') finish({ executionState: 'idle' }); } catch {} });
      socket.addEventListener('error', () => finish({ error: new JupyterGatewayError('Jupyter execution transport was lost; execution state is unknown', 502, 'execution_unknown') }));
      socket.addEventListener('close', () => { if (!completed) finish({ error: new JupyterGatewayError('Jupyter execution transport closed; execution state is unknown', 502, 'execution_unknown') }); });
    });
  }
}
