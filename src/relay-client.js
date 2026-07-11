export class RelayClient extends EventTarget {
    #socket = null;
    #url = null;
    #state = 'idle';

    get state() {
        return this.#state;
    }

    connect(url) {
        const endpoint = new URL(url);
        if (!['ws:', 'wss:'].includes(endpoint.protocol)) {
            throw new Error('Relay URL must use ws:// or wss://.');
        }

        this.disconnect();
        this.#url = endpoint.toString();
        this.#setState('connecting');

        const socket = new WebSocket(this.#url);
        this.#socket = socket;

        socket.addEventListener('open', () => this.#setState('connected'));
        socket.addEventListener('close', () => {
            if (this.#socket === socket) {
                this.#socket = null;
                this.#setState('disconnected');
            }
        });
        socket.addEventListener('error', () => this.dispatchEvent(new Event('error')));
        socket.addEventListener('message', (event) => this.#handleMessage(event));
    }

    disconnect() {
        if (this.#socket) {
            this.#socket.close(1000, 'Client disconnected');
            this.#socket = null;
        }
        this.#setState('idle');
    }

    send(message) {
        if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
            throw new Error('Relay is not connected.');
        }
        this.#socket.send(JSON.stringify(message));
    }

    #handleMessage(event) {
        try {
            const message = JSON.parse(event.data);
            this.dispatchEvent(new CustomEvent('message', { detail: message }));
        } catch {
            this.dispatchEvent(new CustomEvent('protocolerror', { detail: event.data }));
        }
    }

    #setState(state) {
        if (this.#state === state) return;
        this.#state = state;
        this.dispatchEvent(new CustomEvent('statechange', { detail: state }));
    }
}

