export const PROTOCOL_VERSION = 1;

/**
 * 命令词汇表。必须与 relay 仓库 src/core/protocol.ts 逐字一致；
 * 唯一权威见本仓库 docs/V1-PLAN.md 第 2 节。
 */
export const CommandType = Object.freeze({
    RELAY_PING: 'relay.ping',
    AUTH_HELLO: 'auth.hello',
    ROOM_CREATE: 'room.create',
    ROOM_JOIN: 'room.join',
    ROOM_RESUME: 'room.resume',
    ROOM_LEAVE: 'room.leave',
    ROOM_KICK: 'room.kick',
    PROPOSAL_SUBMIT: 'proposal.submit',
    PROPOSAL_WITHDRAW: 'proposal.withdraw',
    PROPOSAL_ACCEPT: 'proposal.accept',
    PROPOSAL_REJECT: 'proposal.reject',
    STORY_MESSAGE_PUBLISH: 'story.message.publish',
    SIDECHAT_MESSAGE_POST: 'sidechat.message.post',
    GENERATION_START: 'generation.start',
    GENERATION_PROGRESS: 'generation.progress',
    GENERATION_FINISH: 'generation.finish',
});

export function createCommand(type, payload = {}) {
    return {
        v: PROTOCOL_VERSION,
        kind: 'cmd',
        type,
        requestId: crypto.randomUUID(),
        opId: crypto.randomUUID(),
        payload,
    };
}

function toBase64Url(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(code) {
    const base64 = code.replaceAll('-', '+').replaceAll('_', '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

function assertRelayUrl(relayUrl) {
    let parsed;
    try {
        parsed = new URL(relayUrl);
    } catch {
        throw new Error('邀请码中的中继地址无效。');
    }
    if (!['ws:', 'wss:'].includes(parsed.protocol)) {
        throw new Error('中继地址必须是 ws:// 或 wss://。');
    }
}

/** 邀请码：base64url(JSON {v, relayUrl, roomId, token})。客人凭一个码入房，零配置。 */
export function createInviteCode({ relayUrl, roomId, token }) {
    for (const [field, value] of Object.entries({ relayUrl, roomId, token })) {
        if (typeof value !== 'string' || !value) throw new Error(`邀请码缺少 ${field}。`);
    }
    assertRelayUrl(relayUrl);
    return toBase64Url(JSON.stringify({ v: PROTOCOL_VERSION, relayUrl, roomId, token }));
}

export function parseInviteCode(code) {
    let data;
    try {
        data = JSON.parse(fromBase64Url(String(code).trim()));
    } catch {
        throw new Error('邀请码格式无效。');
    }
    if (data?.v !== PROTOCOL_VERSION) {
        throw new Error(`邀请码协议版本不支持（需要 v${PROTOCOL_VERSION}）。`);
    }
    for (const field of ['relayUrl', 'roomId', 'token']) {
        if (typeof data[field] !== 'string' || !data[field]) throw new Error('邀请码内容不完整。');
    }
    assertRelayUrl(data.relayUrl);
    return { relayUrl: data.relayUrl, roomId: data.roomId, token: data.token };
}
