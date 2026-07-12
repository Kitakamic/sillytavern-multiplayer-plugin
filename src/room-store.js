import { EventType } from './protocol.js';

function initialState() {
    return {
        room: null, // { roomId, role, selfClientId }
        members: [], // [{ clientId, displayName, role, joinedAt, online }]
        timeline: [], // [{ messageId, authorClientId, authorName, role, text, publishedAt, seq, edited? }]
        /** 本房间内被删除过的故事消息 ID → true（客户端离线错过删除事件时据此清理本地聊天）。 */
        deletedIds: {},
        sidechat: [], // [{ messageId, authorClientId, authorDisplayName, text, postedAt }]
        sharedCard: null, // { assetId, characterName, bytes, expiresAt, sharedAt, cardKey?, contentHash? }
        sharedSave: null, // { assetId, chatName, messageCount, bytes, expiresAt, sharedAt, saveKey?, contentHash? }
        /** 本回合就绪状态：clientId → 'ready' | 'skip'。AI 回复落地即清空（回合边界）。 */
        ready: {},
        generating: false,
        /** 生成中的流式全文快照（generation.progressed 瞬态事件驱动；结束清空）。 */
        generatingText: null,
        /** 本端离房原因：'left' | 'kicked' | 'host_left' | 'expired'，用于 UI 提示。 */
        closedReason: null,
        lastAppliedSeq: 0,
    };
}

/**
 * 只读房间投影。事件按 seq 单调应用；检测到缺口时派发 'desync'，
 * 由控制层用 room.resume 兜底（重连、入房、缺口共用同一条恢复路径）。
 */
export class RoomStore extends EventTarget {
    #state = initialState();

    get snapshot() {
        return structuredClone(this.#state);
    }

    get inRoom() {
        return this.#state.room !== null;
    }

    get lastAppliedSeq() {
        return this.#state.lastAppliedSeq;
    }

    get role() {
        return this.#state.room?.role ?? null;
    }

    get selfClientId() {
        return this.#state.room?.selfClientId ?? null;
    }

    /** 入房/建房/重入后初始化房间状态；随后用 room.resume 的事件数组回放出全部投影。 */
    seedRoom({ roomId, role, selfClientId, members = [], generating = false }) {
        this.#state = {
            ...initialState(),
            room: { roomId, role, selfClientId },
            members: members.map((member) => ({ ...member, online: member.online ?? true })),
            generating: Boolean(generating),
        };
        this.#notify();
    }

    /** room.resume 应答中的权威成员表/生成标志覆盖本地（增量事件随后逐条 applyEvent）。 */
    syncPresence({ members, generating } = {}) {
        if (!this.#state.room) return;
        if (Array.isArray(members)) {
            this.#state.members = members.map((member) => ({ ...member, online: member.online ?? false }));
        }
        if (generating !== undefined) this.#state.generating = Boolean(generating);
        this.#notify();
    }

    reset(reason = null) {
        this.#state = { ...initialState(), closedReason: reason };
        this.#notify();
    }

    /**
     * 应用单条事件。返回 false 表示检测到 seq 缺口（已派发 'desync'，
     * 该事件被丢弃，等待 resume 重放）；true 表示已应用或安全忽略。
     */
    applyEvent(event) {
        const state = this.#state;
        if (!state.room || event.roomId !== state.room.roomId) return true; // 不在房或异房残留事件

        if (typeof event.seq === 'number') {
            if (event.seq <= state.lastAppliedSeq) return true; // 重复投递
            if (event.seq > state.lastAppliedSeq + 1) {
                this.dispatchEvent(new CustomEvent('desync', {
                    detail: { expectedSeq: state.lastAppliedSeq + 1, gotSeq: event.seq },
                }));
                return false;
            }
            state.lastAppliedSeq = event.seq;
        }

        this.#reduce(event);
        this.dispatchEvent(new CustomEvent('event', { detail: event }));
        this.#notify();
        return true;
    }

    #reduce(event) {
        const state = this.#state;
        const payload = event.payload ?? {};
        switch (event.type) {
            case EventType.ROOM_MEMBER_JOINED: {
                const member = { ...payload.member, online: true };
                const index = state.members.findIndex((m) => m.clientId === member.clientId);
                if (index === -1) state.members.push(member);
                else state.members[index] = member;
                break;
            }
            case EventType.ROOM_MEMBER_LEFT: {
                state.members = state.members.filter((m) => m.clientId !== payload.clientId);
                delete state.ready[payload.clientId];
                if (payload.clientId === state.room.selfClientId) {
                    this.#state = { ...initialState(), closedReason: payload.reason === 'kicked' ? 'kicked' : 'left' };
                }
                break;
            }
            case EventType.ROOM_MEMBER_ONLINE:
            case EventType.ROOM_MEMBER_OFFLINE: {
                const member = state.members.find((m) => m.clientId === payload.clientId);
                if (member) member.online = event.type === EventType.ROOM_MEMBER_ONLINE;
                break;
            }
            case EventType.ROOM_CLOSED: {
                this.#state = { ...initialState(), closedReason: payload.reason ?? 'host_left' };
                break;
            }
            case EventType.ROOM_CARD_UPDATED:
                state.sharedCard = {
                    assetId: payload.assetId,
                    characterName: payload.characterName,
                    bytes: payload.bytes,
                    expiresAt: payload.expiresAt,
                    sharedAt: payload.sharedAt,
                    cardKey: payload.cardKey ?? null,
                    contentHash: payload.contentHash ?? null,
                };
                break;
            case EventType.ROOM_CARD_CLEARED:
                if (!state.sharedCard || state.sharedCard.assetId === payload.assetId) state.sharedCard = null;
                break;
            case EventType.ROOM_CHAT_UPDATED:
                state.sharedSave = {
                    assetId: payload.assetId,
                    chatName: payload.chatName,
                    messageCount: payload.messageCount,
                    bytes: payload.bytes,
                    expiresAt: payload.expiresAt,
                    sharedAt: payload.sharedAt,
                    saveKey: payload.saveKey ?? null,
                    contentHash: payload.contentHash ?? null,
                };
                break;
            case EventType.ROOM_CHAT_CLEARED:
                if (!state.sharedSave || state.sharedSave.assetId === payload.assetId) state.sharedSave = null;
                break;
            case EventType.STORY_MESSAGE_PUBLISHED:
                state.timeline.push({ ...payload.message, seq: event.seq });
                // AI 回复落地 = 回合结束，清空全员就绪状态。
                if (payload.message?.role === 'assistant') state.ready = {};
                break;
            case EventType.STORY_MESSAGE_UPDATED: {
                const target = state.timeline.find((m) => m.messageId === payload.messageId);
                if (target) {
                    target.text = payload.text;
                    target.edited = true;
                }
                break;
            }
            case EventType.STORY_MESSAGE_DELETED:
                state.timeline = state.timeline.filter((m) => m.messageId !== payload.messageId);
                state.deletedIds[payload.messageId] = true;
                break;
            case EventType.SIDECHAT_MESSAGE_POSTED:
                state.sidechat.push({ ...payload.message });
                break;
            case EventType.ROUND_READY_CHANGED:
                if (payload.state === 'clear') delete state.ready[payload.clientId];
                else state.ready[payload.clientId] = payload.state;
                break;
            case EventType.GENERATION_STARTED:
                state.generating = true;
                state.generatingText = '';
                break;
            case EventType.GENERATION_FINISHED:
                state.generating = false;
                state.generatingText = null;
                break;
            case EventType.GENERATION_PROGRESSED:
                if (typeof payload.text === 'string') state.generatingText = payload.text;
                break;
            default:
                break; // 未知事件：seq 已推进，安全忽略（前向兼容）
        }
    }

    #notify() {
        this.dispatchEvent(new CustomEvent('change', { detail: this.snapshot }));
    }
}
