/**
 * Adapts an RTCDataChannel to the WebSocket-like interface that
 * vscode-ws-jsonrpc's `toSocket()` expects (`onmessage`, `onclose`,
 * `onerror`, `send`, `close`, `readyState`).
 *
 * IMPORTANT: External code must NEVER overwrite `dataChannel.onopen`,
 * `dataChannel.onmessage`, etc. directly — those are owned by this
 * adapter.  Instead, use the `waitUntilOpen()` helper or listen to
 * the adapter-level `onopen` property.
 */
export class MonacoSocketAdapter {
    constructor(dataChannel) {
        this.dataChannel = dataChannel;
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.onclose = null;
        // WebSocket readyState: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
        this.readyState = 0;
        this.messageQueue = [];
        this.chunkStore = new Map();

        // ── Channel already open (rare but possible) ──
        if (this.dataChannel.readyState === 'open') {
            this.readyState = 1;
            // Defer so callers can attach `onopen` after construction.
            setTimeout(() => {
                if (this.onopen) this.onopen();
                this._flushQueue();
            }, 0);
        }

        // ── Data channel event handlers (owned exclusively by this adapter) ──
        this.dataChannel.onopen = () => {
            console.log('[MonacoSocketAdapter] Channel opened');
            this.readyState = 1;
            if (this.onopen) this.onopen();
            this._flushQueue();
        };

        this.dataChannel.onmessage = (event) => {
            let data = event.data;

            if (data instanceof ArrayBuffer) {
                // Check for CHNK header (Magic: 0x43 0x48 0x4E 0x4B)
                if (data.byteLength >= 16) {
                    const view = new DataView(data);
                    if (
                        view.getUint8(0) === 0x43 &&
                        view.getUint8(1) === 0x48 &&
                        view.getUint8(2) === 0x4E &&
                        view.getUint8(3) === 0x4B
                    ) {
                        const msgId = view.getUint32(4);
                        const chunkIdx = view.getUint32(8);
                        const totalChunks = view.getUint32(12);

                        if (!this.chunkStore.has(msgId)) {
                            this.chunkStore.set(msgId, {
                                total: totalChunks,
                                received: 0,
                                parts: new Array(totalChunks),
                            });
                        }

                        const entry = this.chunkStore.get(msgId);
                        entry.parts[chunkIdx] = data.slice(16);
                        entry.received++;

                        if (entry.received === entry.total) {
                            const totalLen = entry.parts.reduce((acc, p) => acc + p.byteLength, 0);
                            const fullData = new Uint8Array(totalLen);
                            let offset = 0;
                            for (const part of entry.parts) {
                                fullData.set(new Uint8Array(part), offset);
                                offset += part.byteLength;
                            }
                            this.chunkStore.delete(msgId);
                            this._processMessage(new TextDecoder().decode(fullData));
                        }
                        return;
                    }
                }
                data = new TextDecoder().decode(data);
            }

            this._processMessage(data);
        };

        this.dataChannel.onerror = (error) => {
            if (this.onerror) this.onerror(error);
        };

        this.dataChannel.onclose = () => {
            this.readyState = 3;
            if (this.onclose) this.onclose();
        };
    }

    /**
     * Returns a promise that resolves when the underlying data channel
     * reaches the 'open' state.  Resolves immediately if already open.
     * Rejects on error or after `timeoutMs`.
     */
    waitUntilOpen(timeoutMs = 15000) {
        if (this.readyState === 1 || this.dataChannel.readyState === 'open') {
            // Sync-set readyState in case the DC opened between construction
            // and this call (before our onopen handler could fire).
            this.readyState = 1;
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const prevOnOpen = this.onopen;
            const prevOnError = this.onerror;
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error('Channel open timeout (' + timeoutMs + 'ms)'));
            }, timeoutMs);
            const cleanup = () => {
                clearTimeout(timer);
                this.onopen = prevOnOpen;
                this.onerror = prevOnError;
            };
            this.onopen = () => {
                cleanup();
                if (prevOnOpen) prevOnOpen();
                resolve();
            };
            this.onerror = (e) => {
                cleanup();
                if (prevOnError) prevOnError(e);
                reject(new Error('Channel error'));
            };
        });
    }

    _processMessage(data) {
        if (this.onmessage) {
            this.onmessage({ data });
        } else {
            console.warn('[MonacoSocketAdapter] Message received but no onmessage handler');
        }
    }

    send(data) {
        if (this.readyState === 1) {
            this.dataChannel.send(data);
        } else {
            this.messageQueue.push(data);
        }
    }

    _flushQueue() {
        while (this.messageQueue.length > 0) {
            const msg = this.messageQueue.shift();
            this.send(msg);
        }
    }

    close() {
        this.dataChannel.close();
    }
}
