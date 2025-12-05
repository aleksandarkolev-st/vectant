export class MonacoSocketAdapter {
    constructor(dataChannel) {
        this.dataChannel = dataChannel;
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.onclose = null;
        // Map WebRTC states to WebSocket states roughly
        // WebSocket: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
        this.readyState = 0; 
        this.messageQueue = [];

        if (this.dataChannel.readyState === 'open') {
             this.readyState = 1;
             // Defer onopen to allow listener assignment
             setTimeout(() => this.onopen && this.onopen(), 0);
        }

        this.dataChannel.onopen = () => {
            console.log('[MonacoSocketAdapter] Channel opened');
            this.readyState = 1;
            if (this.onopen) this.onopen();
            this._flushQueue();
        };

        this.chunkStore = new Map();

        this.dataChannel.onmessage = (event) => {
            if (this.onmessage) {
                let data = event.data;
                
                if (data instanceof ArrayBuffer) {
                    // Check for CHNK header (Magic: 0x43 0x48 0x4E 0x4B)
                    if (data.byteLength >= 16) {
                        const view = new DataView(data);
                        if (view.getUint8(0) === 0x43 && 
                            view.getUint8(1) === 0x48 && 
                            view.getUint8(2) === 0x4E && 
                            view.getUint8(3) === 0x4B) 
                        {
                            const msgId = view.getUint32(4);
                            const chunkIdx = view.getUint32(8);
                            const totalChunks = view.getUint32(12);
                            
                            if (!this.chunkStore.has(msgId)) {
                                this.chunkStore.set(msgId, {
                                    total: totalChunks,
                                    received: 0,
                                    parts: new Array(totalChunks)
                                });
                            }
                            
                            const entry = this.chunkStore.get(msgId);
                            // Store the payload (skip header)
                            entry.parts[chunkIdx] = data.slice(16);
                            entry.received++;
                            
                            if (entry.received === entry.total) {
                                // Reassemble
                                const totalLen = entry.parts.reduce((acc, part) => acc + part.byteLength, 0);
                                const fullData = new Uint8Array(totalLen);
                                let offset = 0;
                                for (const part of entry.parts) {
                                    fullData.set(new Uint8Array(part), offset);
                                    offset += part.byteLength;
                                }
                                this.chunkStore.delete(msgId);
                                
                                // Decode and process
                                const text = new TextDecoder().decode(fullData);
                                this._processMessage(text);
                            }
                            return;
                        }
                    }
                    
                    data = new TextDecoder().decode(data);
                }
                
                this._processMessage(data);
            } else {
                console.warn('[MonacoSocketAdapter] Received message but no onmessage handler attached');
            }
        };

        this.dataChannel.onerror = (error) => {
            if (this.onerror) this.onerror(error);
        };

        this.dataChannel.onclose = () => {
            this.readyState = 3;
            if (this.onclose) this.onclose();
        };
    }

    _processMessage(data) {
        try {
            const json = JSON.parse(data);
            if (json.method === 'textDocument/publishDiagnostics') {
                console.log('[LSP-RX] Diagnostics for:', json.params.uri, 'Count:', json.params.diagnostics.length);
            } else if (json.id !== undefined && json.result !== undefined) {
                // Log Initialize Result specifically
                if (json.result && json.result.capabilities) {
                        console.log('[LSP-RX] Initialize Result Capabilities:', JSON.stringify(json.result.capabilities, null, 2));
                } else if (Array.isArray(json.result)) {
                        console.log('[LSP-RX] Completion Response (Array):', json.result.length, 'items');
                } else if (json.result.items) {
                        console.log('[LSP-RX] Completion Response (List):', json.result.items.length, 'items');
                } else {
                        console.log('[LSP-RX] Response for ID', json.id, ':', json.result);
                }
            } else if (json.method) {
                console.log('[LSP-RX] Method:', json.method);
            }
        } catch (e) {
            // ignore
        }

        this.onmessage({ data: data });
    }

    send(data) {
        if (this.readyState === 1) {
            console.log('[MonacoSocketAdapter] Sending:', data.length > 100 ? data.substring(0, 100) + '...' : data);
            this.dataChannel.send(data);
        } else {
            console.log('[MonacoSocketAdapter] Socket not open, buffering message');
            this.messageQueue.push(data);
        }
    }

    _flushQueue() {
        while (this.messageQueue.length > 0) {
            const data = this.messageQueue.shift();
            this.send(data);
        }
    }

    close() {
        this.dataChannel.close();
    }
}
