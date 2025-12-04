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

        if (this.dataChannel.readyState === 'open') {
             this.readyState = 1;
             // Defer onopen to allow listener assignment
             setTimeout(() => this.onopen && this.onopen(), 0);
        }

        this.dataChannel.onopen = () => {
            this.readyState = 1;
            if (this.onopen) this.onopen();
        };

        this.dataChannel.onmessage = (event) => {
            if (this.onmessage) {
                let data = event.data;
                if (data instanceof ArrayBuffer) {
                    data = new TextDecoder().decode(data);
                }
                this.onmessage({ data: data });
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
            this.dataChannel.send(data);
        } else {
            console.warn('MonacoSocketAdapter: Socket not open, cannot send', data);
        }
    }

    close() {
        this.dataChannel.close();
    }
}
