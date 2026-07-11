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
    ROOM_CARD_UPDATE: 'room.card.update',
    ROOM_CARD_CLEAR: 'room.card.clear',
    ROOM_CHAT_UPDATE: 'room.chat.update',
    ROOM_CHAT_CLEAR: 'room.chat.clear',
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

/**
 * 事件词汇表（中继 → 客户端）。必须与 relay 的 src/core/protocol.ts 一致；
 * 信封为 {v, kind:'event', type, eventId, roomId, seq, payload}，seq 在房间内单调递增。
 * generation.* 为瞬态事件：无 seq、不入房间日志，仅对在线成员广播。
 */
export const EventType = Object.freeze({
    ROOM_MEMBER_JOINED: 'room.member.joined',
    ROOM_MEMBER_LEFT: 'room.member.left',
    ROOM_MEMBER_ONLINE: 'room.member.online',
    ROOM_MEMBER_OFFLINE: 'room.member.offline',
    ROOM_CLOSED: 'room.closed',
    ROOM_CARD_UPDATED: 'room.card.updated',
    ROOM_CARD_CLEARED: 'room.card.cleared',
    ROOM_CHAT_UPDATED: 'room.chat.updated',
    ROOM_CHAT_CLEARED: 'room.chat.cleared',
    PROPOSAL_SUBMITTED: 'proposal.submitted',
    PROPOSAL_WITHDRAWN: 'proposal.withdrawn',
    PROPOSAL_ACCEPTED: 'proposal.accepted',
    PROPOSAL_REJECTED: 'proposal.rejected',
    STORY_MESSAGE_PUBLISHED: 'story.message.published',
    SIDECHAT_MESSAGE_POSTED: 'sidechat.message.posted',
    GENERATION_STARTED: 'generation.started',
    GENERATION_PROGRESSED: 'generation.progressed',
    GENERATION_FINISHED: 'generation.finished',
});

/**
 * 错误帧 payload.code 的取值。必须与 relay 的 src/core/protocol.ts 一致；UI 据此显示中文文案。
 * UNAUTHORIZED / ASSET_* / RATE_LIMITED 由 HTTP 资产通道（M2.5）使用，JSON 错误形如 { error, code }。
 */
export const ErrorCode = Object.freeze({
    BAD_PAYLOAD: 'BAD_PAYLOAD',
    NOT_AUTHENTICATED: 'NOT_AUTHENTICATED',
    ALREADY_IN_ROOM: 'ALREADY_IN_ROOM',
    NOT_IN_ROOM: 'NOT_IN_ROOM',
    CREATOR_KEY_INVALID: 'CREATOR_KEY_INVALID',
    ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
    ROOM_FULL: 'ROOM_FULL',
    INVITE_INVALID: 'INVITE_INVALID',
    FORBIDDEN: 'FORBIDDEN',
    TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
    PROPOSAL_NOT_PENDING: 'PROPOSAL_NOT_PENDING',
    NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
    UNKNOWN_COMMAND: 'UNKNOWN_COMMAND',
    INTERNAL: 'INTERNAL',
    UNAUTHORIZED: 'UNAUTHORIZED',
    ASSET_NOT_FOUND: 'ASSET_NOT_FOUND',
    ASSET_TOO_LARGE: 'ASSET_TOO_LARGE',
    UNSUPPORTED_ASSET_TYPE: 'UNSUPPORTED_ASSET_TYPE',
    RATE_LIMITED: 'RATE_LIMITED',
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
