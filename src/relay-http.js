/** 资产通道（HTTP）公共工具：card-sharing 与 save-sharing 共用。 */

export function relayHttpOrigin(relayUrl) {
    const url = new URL(relayUrl);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    else if (url.protocol === 'wss:') url.protocol = 'https:';
    else throw new Error('中继地址必须是 ws:// 或 wss://。');
    return url.origin;
}

export function requireSession({ clientId, sessionToken } = {}) {
    if (!clientId || !sessionToken) throw new Error('缺少房间会话凭据，请重新连接。');
    return {
        'x-relay-client-id': clientId,
        'x-relay-session-token': sessionToken,
    };
}

export async function responseError(response, fallback) {
    try {
        const body = await response.json();
        const error = new Error(body.error || fallback);
        if (body.code) error.code = body.code;
        return error;
    } catch {
        return new Error(`${fallback}（HTTP ${response.status}）`);
    }
}

/**
 * SHA-256 十六进制摘要；输入为 ArrayBuffer/TypedArray 或字符串。
 * 环境不支持 WebCrypto 时返回 null——调用方按“无去重元数据”降级。
 */
export async function sha256Hex(input) {
    try {
        const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
        const digest = await crypto.subtle.digest('SHA-256', data);
        return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    } catch {
        return null;
    }
}
