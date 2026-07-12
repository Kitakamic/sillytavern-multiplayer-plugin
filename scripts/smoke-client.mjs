// 插件冒烟测试（Node 22+，利用全局 WebSocket 直接驱动浏览器端模块）。
// 第一部分：连接层（P0）——邀请码、连接、请求关联、可选重连验证。
// 第二部分：数据层（P1）——双客户端 RoomStore 全流程（需中继房主密钥）。
// 用法: node scripts/smoke-client.mjs [wsUrl]           （默认 ws://127.0.0.1:3001/ws）
// 环境: RELAY_SMOKE_WAIT_RECONNECT=1 → 首次 ping 后等待外部重启中继，验证自动重连。
//       RELAY_CREATOR_KEY=...        → 房主密钥；缺省时读同级 relay 仓库 data/local-relay-state.json。
import { readFileSync } from 'node:fs';
import { RelayClient } from '../src/relay-client.js';
import { RoomStore } from '../src/room-store.js';
import { CommandType, createCommand, createInviteCode, parseInviteCode } from '../src/protocol.js';

const wsUrl = process.argv[2] ?? 'ws://127.0.0.1:3001/ws';

function fail(message) {
    console.error(`FAIL ${message}`);
    process.exit(1);
}

function pass(label) {
    console.log(`PASS ${label}`);
}

function waitState(client, state, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        if (client.state === state) return resolve();
        const timer = setTimeout(() => reject(new Error(`timeout waiting for state '${state}'`)), timeoutMs);
        client.addEventListener('statechange', function onChange(event) {
            if (event.detail === state) {
                clearTimeout(timer);
                client.removeEventListener('statechange', onChange);
                resolve();
            }
        });
    });
}

async function until(predicate, label, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    fail(`timeout waiting: ${label}`);
}

// ---------- P0：连接层 ----------

const invite = { relayUrl: 'wss://relay.example.com/ws', roomId: 'room-42', token: 'tok_abc' };
const decoded = parseInviteCode(createInviteCode(invite));
if (JSON.stringify(decoded) !== JSON.stringify(invite)) fail('invite code roundtrip mismatch');
pass('invite code roundtrip');

try {
    parseInviteCode('this-is-not-an-invite!!!');
    fail('invalid invite code was accepted');
} catch {
    pass('invalid invite rejected');
}

const client = new RelayClient();
client.connect(wsUrl);
await waitState(client, 'connected').catch((error) => fail(error.message));
pass('connected');

const ack = await client.request(createCommand(CommandType.RELAY_PING)).catch((error) => fail(`ping failed: ${error.message}`));
if (ack.type !== 'relay.ping.ack') fail(`unexpected ping reply: ${JSON.stringify(ack)}`);
pass('request/ack correlation');

if (process.env.RELAY_SMOKE_WAIT_RECONNECT === '1') {
    console.log('WAITING for external relay restart...');
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for reconnect')), 60000);
        client.addEventListener('reconnected', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    }).catch((error) => fail(error.message));

    const ack2 = await client.request(createCommand(CommandType.RELAY_PING)).catch((error) => fail(`post-reconnect ping failed: ${error.message}`));
    if (ack2.type !== 'relay.ping.ack') fail(`unexpected post-reconnect reply: ${JSON.stringify(ack2)}`);
    pass('auto-reconnect + post-reconnect ping');
}

client.disconnect();

// ---------- P1：数据层（双客户端 RoomStore 全流程）----------

function loadCreatorKey() {
    if (process.env.RELAY_CREATOR_KEY) return process.env.RELAY_CREATOR_KEY;
    try {
        const stateUrl = new URL('../../sillytavern-multiplayer-relay/data/local-relay-state.json', import.meta.url);
        const parsed = JSON.parse(readFileSync(stateUrl, 'utf8'));
        if (typeof parsed.creatorKey === 'string' && parsed.creatorKey) return parsed.creatorKey;
    } catch { /* fall through */ }
    fail('creator key unavailable: set RELAY_CREATOR_KEY or start the sibling local relay once');
}

/** 模拟 ui.js 控制层的最小玩家：RelayClient + RoomStore + hello/resume 接线。 */
class Player {
    constructor(name) {
        this.name = name;
        this.creds = null;
        this.client = new RelayClient();
        this.client.reconnectEnabled = false;
        this.store = new RoomStore();
        this.client.addEventListener('message', (event) => {
            if (event.detail?.kind === 'event') this.store.applyEvent(event.detail);
        });
    }

    async connect() {
        this.client.connect(wsUrl);
        await waitState(this.client, 'connected');
    }

    async hello() {
        const payload = { displayName: this.name, ...(this.creds ?? {}) };
        const reply = await this.client.request(createCommand(CommandType.AUTH_HELLO, payload));
        this.creds = { clientId: reply.payload.clientId, sessionToken: reply.payload.sessionToken };
        return reply;
    }

    /** 与 ui.js 的 applyResume 相同的恢复路径。 */
    async resume() {
        const reply = await this.client.request(createCommand(CommandType.ROOM_RESUME, {
            lastAppliedSeq: this.store.inRoom ? this.store.lastAppliedSeq : 0,
        }));
        const payload = reply.payload;
        if (!this.store.inRoom || this.store.snapshot.room.roomId !== payload.roomId) {
            this.store.seedRoom({
                roomId: payload.roomId,
                role: payload.role,
                selfClientId: this.creds.clientId,
                members: payload.members,
                generating: payload.generating,
            });
        } else {
            this.store.syncPresence({ members: payload.members, generating: payload.generating });
        }
        for (const event of payload.events ?? []) this.store.applyEvent(event);
        return reply;
    }
}

const creatorKey = loadCreatorKey();

const host = new Player('房主');
await host.connect();
await host.hello();
const created = await host.client.request(createCommand(CommandType.ROOM_CREATE, { creatorKey }));
const roomId = created.payload.roomId;
const roomInvite = createInviteCode({ relayUrl: wsUrl, roomId, token: created.payload.inviteToken });
await host.resume();
if (!host.store.inRoom || host.store.role !== 'host') fail('host store not seeded as host');
pass('host creates room and seeds store via resume');

const guest = new Player('客人');
await guest.connect();
await guest.hello();
const parsedInvite = parseInviteCode(roomInvite);
await guest.client.request(createCommand(CommandType.ROOM_JOIN, { roomId: parsedInvite.roomId, token: parsedInvite.token }));
await guest.resume();
if (guest.store.snapshot.members.length !== 2) fail('guest store does not see both members');
await until(() => host.store.snapshot.members.length === 2, 'host sees guest in member projection');
pass('guest joins via invite; both member projections converge');

// 直连模式（2026-07-12）：客机直接向共享时间线发言，两侧投影一致。
await guest.client.request(createCommand(CommandType.STORY_MESSAGE_PUBLISH, { text: '我推门而入。', authorName: '小红', role: 'user' }));
await until(() => host.store.snapshot.timeline.length === 1, 'host timeline shows guest message');
const guestMessage = host.store.snapshot.timeline[0];
if (guestMessage.authorName !== '小红' || guestMessage.role !== 'user' || !guestMessage.authorClientId) fail('guest story message lacks author identity');
pass('guest publishes directly; host projection converges with identity');

// 就绪信号：瞬态事件驱动 ready 投影；AI 回复落地即清空（回合边界）。
await guest.client.request(createCommand(CommandType.ROUND_READY, { state: 'ready' }));
await until(() => host.store.snapshot.ready[guest.creds.clientId] === 'ready', 'host sees guest ready');
pass('round-ready signal reaches host projection');

await host.client.request(createCommand(CommandType.STORY_MESSAGE_PUBLISH, { text: '门开了，风灌了进来。', authorName: '角色', role: 'assistant' }));
await until(() => guest.store.snapshot.timeline.length === 2, 'guest timeline has assistant reply');
await until(() => Object.keys(host.store.snapshot.ready).length === 0, 'host ready map cleared');
await until(() => Object.keys(guest.store.snapshot.ready).length === 0, 'guest ready map cleared');
pass('assistant reply lands and clears the round-ready map');

// 共享文档编辑（2026-07-12）：任何成员的修改/删除双向收敛，删除留痕于 deletedIds。
const editTargetId = guest.store.snapshot.timeline[0].messageId;
await host.client.request(createCommand(CommandType.STORY_MESSAGE_UPDATE, { messageId: editTargetId, text: '我推门而入。（润色）' }));
await until(() => guest.store.snapshot.timeline[0]?.text === '我推门而入。（润色）', 'guest sees edited text');
if (guest.store.snapshot.timeline[0].edited !== true) fail('edited flag missing after update');
pass('edit converges across projections');

const tempPub = await guest.client.request(createCommand(CommandType.STORY_MESSAGE_PUBLISH, { text: '（临时消息，测试删除）', authorName: '小红', role: 'user' }));
await until(() => host.store.snapshot.timeline.length === 3, 'temp message reaches host');
await guest.client.request(createCommand(CommandType.STORY_MESSAGE_DELETE, { messageId: tempPub.payload.messageId }));
await until(() => host.store.snapshot.timeline.length === 2, 'host timeline drops deleted message');
if (host.store.snapshot.deletedIds[tempPub.payload.messageId] !== true) fail('deletedIds not tracked');
pass('delete converges with deletedIds tombstone');

await guest.client.request(createCommand(CommandType.SIDECHAT_MESSAGE_POST, { text: '这里好玩！' }));
await until(() => host.store.snapshot.sidechat.length === 1, 'host sidechat projection updated');
pass('sidechat converges on both sides');

// seq 缺口 → desync 事件 → resume 兜底不产生重复
let desynced = false;
guest.store.addEventListener('desync', () => { desynced = true; }, { once: true });
const gapApplied = guest.store.applyEvent({
    v: 1, kind: 'event', type: 'story.message.published', eventId: 'synthetic', roomId,
    seq: guest.store.lastAppliedSeq + 5,
    payload: { message: { messageId: 'synthetic', authorName: 'x', role: 'user', text: 'gap', publishedAt: 0 } },
});
if (gapApplied !== false || !desynced) fail('seq gap did not trigger desync');
if (guest.store.snapshot.timeline.length !== 2) fail('gapped event was applied');
await guest.resume();
if (guest.store.snapshot.timeline.length !== 2) fail('resume after desync duplicated timeline');
pass('seq gap triggers desync; resume recovers without duplicates');

// 断线期间的推进经重连 + resume 追平，无缺失无重复
guest.client.disconnect();
await host.client.request(createCommand(CommandType.STORY_MESSAGE_PUBLISH, { text: '风把门吹开了。', authorName: '角色', role: 'assistant' }));
await host.client.request(createCommand(CommandType.STORY_MESSAGE_PUBLISH, { text: '（旁白推进）', authorName: '角色', role: 'assistant' }));
await guest.connect();
const rehello = await guest.hello();
if (rehello.payload.room?.roomId !== roomId) fail('hello did not report resumable room');
await guest.resume();
await until(() => guest.store.snapshot.timeline.length === 4, 'guest timeline caught up to 4');
const seqs = guest.store.snapshot.timeline.map((m) => m.seq);
if (new Set(seqs).size !== seqs.length) fail('timeline contains duplicate seq');
pass('offline progress recovered via hello+resume (no gap, no dup)');

// 完整卡共享：房主上传资产并发布，客人投影收到；停止共享后投影清空。
const assetBase = new URL(wsUrl);
assetBase.protocol = assetBase.protocol === 'wss:' ? 'https:' : 'http:';
assetBase.pathname = '';
assetBase.search = '';
assetBase.hash = '';
const cardBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Uint8Array(64)]);
const upload = await fetch(`${assetBase.origin}/rooms/${roomId}/assets?kind=card`, {
    method: 'POST',
    headers: {
        'content-type': 'image/png',
        'x-relay-client-id': host.creds.clientId,
        'x-relay-session-token': host.creds.sessionToken,
    },
    body: cardBytes,
});
if (!upload.ok) fail(`card upload failed: HTTP ${upload.status}`);
const sharedAssetId = (await upload.json()).assetId;
await host.client.request(createCommand(CommandType.ROOM_CARD_UPDATE, {
    assetId: sharedAssetId,
    characterName: '测试角色',
}));
await until(() => guest.store.snapshot.sharedCard?.assetId === sharedAssetId, 'guest sees shared card projection');
pass('shared full card reaches guest projection');

await host.client.request(createCommand(CommandType.ROOM_CARD_CLEAR, { assetId: sharedAssetId }));
await until(() => guest.store.snapshot.sharedCard === null, 'guest sees shared card revoked');
pass('revoked full card clears guest projection');

// 房主离房 → 客人端投影收到关房
await host.client.request(createCommand(CommandType.ROOM_LEAVE));
await until(() => guest.store.snapshot.closedReason === 'host_left', 'guest store sees room closed');
pass('room closure propagates to guest projection');

host.client.disconnect();
guest.client.disconnect();
console.log('CLIENT SMOKE OK');
process.exit(0);
