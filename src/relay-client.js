import { CommandType, createCommand } from './protocol.js';

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const CONNECT_TIMEOUT_MS = 8000;
const HEARTBEAT_INTERVAL_MS = 25000;
const HEARTBEAT_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 10000;

export class RelayClient extends EventTarget {
    #socket = null;
    #url = null;
    #state = 'idle';
    #pending = new Map();
    #reconnectEnabled = true;
    #reconnectAttempts = 0;
    #reconnectTimer = null;
    #heartbeatTimer = null;
    #manualClose = false;

    /** 房间层设置：async () => payload | null。重连成功后自动携带其返回值发送 room.resume。 */
    resumeProvider = null;

    get state() {
        return this.#state;
    }

    get reconnectEnabled() {
        return this.#reconnectEnabled;
    }

    set reconnectEnabled(value) {
        this.#reconnectEnabled = Boolean(value);
        if (!this.#reconnectEnabled) this.#cancelReconnect();
    }

    connect(url) {
        const endpoint = new URL(url);
        if (!['ws:', 'wss:'].includes(endpoint.protocol)) {
            throw new Error('Relay URL must use ws:// or wss://.');
        }

        this.disconnect();
        this.#manualClose = false;
        this.#url = endpoint.toString();
        this.#reconnectAttempts = 0;
        this.#open(false);
    }

    disconnect() {
        this.#manualClose = true;
        this.#cancelReconnect();
        this.#stopHeartbeat();
        this.#rejectAllPending(new Error('连接已关闭。'));
        if (this.#socket) {
            try { this.#socket.close(1000, 'Client disconnected'); } catch { /* 忽略 */ }
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

    /** 发送命令并按 requestId 等待 ack/error。resolve 为 ack 消息，error 帧转为 reject。 */
    request(command, timeoutMs = REQUEST_TIMEOUT_MS) {
        return new Promise((resolve, reject) => {
            if (!command || typeof command.requestId !== 'string') {
                reject(new Error('request() 需要 createCommand() 构造的命令。'));
                return;
            }
            try {
                this.send(command);
            } catch (error) {
                reject(error);
                return;
            }
            const timer = setTimeout(() => {
                this.#pending.delete(command.requestId);
                reject(new Error(`等待 ${command.type} 响应超时。`));
            }, timeoutMs);
            this.#pending.set(command.requestId, { resolve, reject, timer });
        });
    }

    #open(isReconnect) {
        this.#setState(isReconnect ? 'reconnecting' : 'connecting');

        const socket = new WebSocket(this.#url);
        this.#socket = socket;
        let opened = false;

        const connectTimer = setTimeout(() => {
            if (!opened && this.#socket === socket) {
                try { socket.close(); } catch { /* 忽略 */ }
                this.#failSocket(socket);
            }
        }, CONNECT_TIMEOUT_MS);

        socket.addEventListener('open', () => {
            if (this.#socket !== socket) return;
            opened = true;
            clearTimeout(connectTimer);
            this.#reconnectAttempts = 0;
            this.#setState('connected');
            this.#startHeartbeat();
            if (isReconnect) {
                this.dispatchEvent(new Event('reconnected'));
                void this.#autoResume();
            }
        });

        socket.addEventListener('close', () => {
            clearTimeout(connectTimer);
            this.#failSocket(socket);
        });

        socket.addEventListener('error', () => {
            this.dispatchEvent(new Event('error'));
            // 连接建立失败时部分实现只发 error 不发 close，这里兜底进入失败路径。
            if (!opened) {
                clearTimeout(connectTimer);
                this.#failSocket(socket);
            }
        });

        socket.addEventListener('message', (event) => this.#handleMessage(event));
    }

    /** 统一的连接失败/断开处理；凭 socket 引用去重，error+close 双触发只生效一次。 */
    #failSocket(socket) {
        if (this.#socket !== socket) return;
        this.#socket = null;
        this.#stopHeartbeat();
        this.#rejectAllPending(new Error('连接已断开。'));
        if (this.#manualClose) return;
        this.#setState('disconnected');
        this.#scheduleReconnect();
    }

    #handleMessage(event) {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            this.dispatchEvent(new CustomEvent('protocolerror', { detail: event.data }));
            return;
        }

        if ((message.kind === 'ack' || message.kind === 'error') && message.requestId && this.#pending.has(message.requestId)) {
            const entry = this.#pending.get(message.requestId);
            this.#pending.delete(message.requestId);
            clearTimeout(entry.timer);
            if (message.kind === 'ack') {
                entry.resolve(message);
            } else {
                // 携带机器可读错误码，UI 据此映射中文文案。
                const error = new Error(message.payload?.message ?? '中继返回错误。');
                error.code = message.payload?.code;
                entry.reject(error);
            }
        }

        this.dispatchEvent(new CustomEvent('message', { detail: message }));
    }

    #scheduleReconnect() {
        if (!this.#reconnectEnabled || this.#manualClose || !this.#url || this.#reconnectTimer) return;

        const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** this.#reconnectAttempts, RECONNECT_MAX_DELAY_MS)
            + Math.floor(Math.random() * 250);
        this.#reconnectAttempts += 1;
        this.#setState('reconnecting');

        this.#reconnectTimer = setTimeout(() => {
            this.#reconnectTimer = null;
            if (this.#manualClose || !this.#reconnectEnabled) return;
            this.#open(true);
        }, delay);
    }

    #cancelReconnect() {
        if (this.#reconnectTimer) {
            clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = null;
        }
    }

    #startHeartbeat() {
        this.#stopHeartbeat();
        this.#heartbeatTimer = setInterval(() => {
            if (this.#state !== 'connected') return;
            this.request(createCommand(CommandType.RELAY_PING), HEARTBEAT_TIMEOUT_MS).catch(() => {
                // 心跳超时视为死连接，强制关闭以进入重连路径。
                if (this.#socket) this.#socket.close();
            });
        }, HEARTBEAT_INTERVAL_MS);
    }

    #stopHeartbeat() {
        if (this.#heartbeatTimer) {
            clearInterval(this.#heartbeatTimer);
            this.#heartbeatTimer = null;
        }
    }

    #rejectAllPending(error) {
        for (const entry of this.#pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
        this.#pending.clear();
    }

    async #autoResume() {
        if (typeof this.resumeProvider !== 'function') return;
        try {
            const payload = await this.resumeProvider();
            if (!payload) return;
            const ack = await this.request(createCommand(CommandType.ROOM_RESUME, payload));
            // 房间层监听 'resumed' 以应用应答中的快照与增量事件。
            this.dispatchEvent(new CustomEvent('resumed', { detail: ack }));
        } catch (error) {
            this.dispatchEvent(new CustomEvent('resumeerror', { detail: error }));
        }
    }

    #setState(state) {
        if (this.#state === state) return;
        this.#state = state;
        this.dispatchEvent(new CustomEvent('statechange', { detail: state }));
    }
}
