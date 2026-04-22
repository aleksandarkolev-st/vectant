// operatorClient — WS client for the operator observability UI.
//
// Opens a connection to the signaling server with role="operator",
// listens for {type:"presence"} broadcasts, and exposes a single
// privileged operation: `kickPeer(targetRole, reason)` which sends
// `{type:"kick-peer", target_role, reason}` and resolves when the
// server acks with `kick-ack`.
//
// This is deliberately a thin client. The operator UI is observability,
// not a second browser — so this file does not touch `RTCPeerConnection`,
// media tracks, or the input lease. Anything richer (event log, quota,
// lease snapshot) needs a side-channel to the MCP process itself; that
// arrives in a later phase. For now the signaling-server's built-in
// presence broadcast is enough to power the kill-switch UX.

const DEFAULT_SIGNAL_URL =
  process.env.NEXT_PUBLIC_COMPILE_SIGNAL_URL ||
  (typeof window !== 'undefined' && window.location.hostname !== 'localhost'
    ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/signal`
    : 'ws://localhost:9000');

export class OperatorClient {
  constructor({ sessionId, signalUrl = DEFAULT_SIGNAL_URL } = {}) {
    if (!sessionId) {
      throw new Error('OperatorClient: sessionId is required');
    }
    this.sessionId = sessionId;
    this.signalUrl = signalUrl;
    this.ws = null;
    this.connected = false;
    this.peerId = null;
    this.listeners = {
      presence: new Set(),
      evicted: new Set(),
      connection: new Set(),
      error: new Set(),
    };
    this._pendingKicks = [];
  }

  on(event, fn) {
    const set = this.listeners[event];
    if (!set) throw new Error(`OperatorClient: unknown event '${event}'`);
    set.add(fn);
    return () => set.delete(fn);
  }

  _emit(event, payload) {
    const set = this.listeners[event];
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        // Listener errors must never tear down the socket.
        console.error(`OperatorClient listener(${event}) threw:`, err);
      }
    }
  }

  connect() {
    if (this.ws) return;
    const ws = new WebSocket(this.signalUrl);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: 'register',
          role: 'operator',
          session_id: this.sessionId,
          client_version: 'synthi-operator/0.1.0',
        })
      );
    };
    ws.onmessage = (ev) => this._handleMessage(ev.data);
    ws.onerror = (ev) => this._emit('error', ev);
    ws.onclose = () => {
      this.connected = false;
      this._emit('connection', { state: 'disconnected' });
      // Reject any outstanding kick promises — the server is gone.
      for (const pending of this._pendingKicks) {
        pending.reject(new Error('OperatorClient: socket closed'));
      }
      this._pendingKicks.length = 0;
    };
  }

  disconnect() {
    if (!this.ws) return;
    try {
      this.ws.close();
    } catch (_) {
      // no-op — the socket was already in a broken state.
    }
    this.ws = null;
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'registered':
        this.connected = true;
        this.peerId = msg.peer_id ?? null;
        this._emit('connection', {
          state: 'connected',
          peerId: this.peerId,
          protocol: msg.accepted_protocol,
        });
        break;
      case 'presence':
        this._emit('presence', {
          attachedHumans: msg.attached_humans ?? 0,
          attachedAgents: msg.attached_agents ?? 0,
        });
        break;
      case 'kick-ack': {
        const pending = this._pendingKicks.shift();
        if (pending) {
          pending.resolve({
            targetRole: msg.target_role,
            kicked: msg.kicked,
            reason: msg.reason,
          });
        }
        break;
      }
      case 'kick-denied': {
        const pending = this._pendingKicks.shift();
        const err = new Error(`kick denied: ${msg.code}`);
        err.code = msg.code;
        err.detail = msg;
        if (pending) pending.reject(err);
        break;
      }
      case 'evicted':
        this._emit('evicted', { reason: msg.reason });
        this.connected = false;
        break;
      default:
        // Unrelated signaling traffic — ignore. Operators never route SDP/ICE.
        break;
    }
  }

  kickPeer(targetRole, reason = 'operator_kick') {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('OperatorClient: not connected'));
    }
    if (!targetRole) {
      return Promise.reject(new Error('OperatorClient: targetRole is required'));
    }
    return new Promise((resolve, reject) => {
      this._pendingKicks.push({ resolve, reject });
      this.ws.send(
        JSON.stringify({
          type: 'kick-peer',
          session_id: this.sessionId,
          target_role: targetRole,
          reason,
        })
      );
    });
  }
}

export default OperatorClient;
