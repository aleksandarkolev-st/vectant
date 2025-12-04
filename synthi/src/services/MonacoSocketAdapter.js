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

        this.dataChannel.onmessage = (event) => {
            if (this.onmessage) {
                let data = event.data;
                if (data instanceof ArrayBuffer) {
                    data = new TextDecoder().decode(data);
                }
                
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
