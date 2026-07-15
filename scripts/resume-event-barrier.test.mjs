import assert from 'node:assert/strict';
import { EventType } from '../src/protocol.js';
import { RelayClient } from '../src/relay-client.js';
import { ResumeEventBarrier } from '../src/resume-event-barrier.js';
import { RoomStore } from '../src/room-store.js';

const ROOM_ID = 'room-resume-test';
const SELF_ID = 'client-self';
let transientSequence = 0;

function persisted(seq, text = `message-${seq}`) {
    return {
        v: 1,
        kind: 'event',
        type: EventType.STORY_MESSAGE_PUBLISHED,
        eventId: `event-${seq}`,
        roomId: ROOM_ID,
        seq,
        payload: {
            message: {
                messageId: `message-${seq}`,
                authorClientId: 'client-other',
                authorName: '其他玩家',
                role: 'user',
                text,
                publishedAt: seq,
            },
        },
    };
}

function memberJoined(seq, clientId, { role = 'guest', joinedAt = seq } = {}) {
    return {
        v: 1,
        kind: 'event',
        type: EventType.ROOM_MEMBER_JOINED,
        eventId: `member-joined-${clientId}-${seq}`,
        roomId: ROOM_ID,
        seq,
        payload: {
            member: {
                clientId,
                displayName: clientId === SELF_ID ? '我' : '其他玩家',
                role,
                joinedAt,
            },
        },
    };
}

function memberLeft(seq, clientId, reason = 'left') {
    return {
        v: 1,
        kind: 'event',
        type: EventType.ROOM_MEMBER_LEFT,
        eventId: `member-left-${clientId}-${seq}`,
        roomId: ROOM_ID,
        seq,
        payload: { clientId, reason },
    };
}

function transient(type, payload = {}) {
    return {
        v: 1,
        kind: 'event',
        type,
        eventId: `transient-${++transientSequence}`,
        roomId: ROOM_ID,
        payload,
    };
}

function createHarness({ seeded = false } = {}) {
    const store = new RoomStore();
    if (seeded) seed(store);

    const barrier = new ResumeEventBarrier({
        store,
        applySnapshot(payload, roomHint) {
            const roomId = payload.roomId ?? roomHint?.roomId;
            if (!store.inRoom || store.snapshot.room.roomId !== roomId) {
                store.seedRoom({
                    roomId,
                    role: payload.role ?? roomHint?.role ?? 'guest',
                    selfClientId: SELF_ID,
                    members: payload.members ?? [],
                    generating: payload.generating ?? false,
                });
            } else {
                store.syncPresence({ members: payload.members, generating: payload.generating });
            }
        },
    });
    return { store, barrier };
}

function seed(store) {
    store.seedRoom({
        roomId: ROOM_ID,
        role: 'guest',
        selfClientId: SELF_ID,
        members: [
            { clientId: SELF_ID, displayName: '我', role: 'guest', joinedAt: 0, online: true },
            { clientId: 'client-other', displayName: '其他玩家', role: 'host', joinedAt: 0, online: true },
        ],
    });
}

function resumePayload({ events = [], lastSeq = 0, generating = false } = {}) {
    return {
        roomId: ROOM_ID,
        role: 'guest',
        members: [
            { clientId: SELF_ID, displayName: '我', role: 'guest', joinedAt: 0, online: true },
            { clientId: 'client-other', displayName: '其他玩家', role: 'host', joinedAt: 0, online: true },
        ],
        generating,
        lastSeq,
        events,
    };
}

async function until(predicate, label, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${label}`);
}

// 已有投影：seq 3 的即时消息比 room.resume(seq 2) 更早到达。
{
    const { store, barrier } = createHarness({ seeded: true });
    assert.equal(store.applyEvent(persisted(1)), true);

    barrier.begin();
    barrier.route(persisted(3));
    const result = barrier.commit(resumePayload({ events: [persisted(2)], lastSeq: 2 }));

    assert.deepEqual(store.snapshot.timeline.map((message) => message.messageId), ['message-1', 'message-2', 'message-3']);
    assert.equal(store.lastAppliedSeq, 3);
    assert.deepEqual(result, { needsFollowUp: false, closed: false });
    barrier.end();
    console.log('PASS live seq ahead of resume ack is merged without a gap');
}

// 初始入房：room.member.joined/故事事件可以在 seedRoom 之前先抵达。
{
    const { store, barrier } = createHarness();
    barrier.begin();
    barrier.route(persisted(1));
    const result = barrier.commit(resumePayload({ lastSeq: 0 }));

    assert.equal(store.inRoom, true);
    assert.deepEqual(store.snapshot.timeline.map((message) => message.messageId), ['message-1']);
    assert.equal(store.lastAppliedSeq, 1);
    assert.deepEqual(result, { needsFollowUp: false, closed: false });
    barrier.end();
    console.log('PASS pre-seed live event survives initial join resume');
}

// 退出后用同一身份重新加入同一房间：全量 replay 含有上一届成员资格的
// room.member.left。它已被新的 room.member.joined 覆盖，不能把当前投影再次清空。
{
    const { store, barrier } = createHarness();
    const hostJoined = memberJoined(1, 'client-other', { role: 'host', joinedAt: 1 });
    const firstJoin = memberJoined(2, SELF_ID, { joinedAt: 2 });
    const oldLeave = memberLeft(4, SELF_ID);
    const currentJoin = memberJoined(5, SELF_ID, { joinedAt: 5 });
    const payload = {
        ...resumePayload({
            events: [hostJoined, firstJoin, persisted(3), oldLeave, currentJoin],
            lastSeq: 5,
        }),
        members: [
            { clientId: SELF_ID, displayName: '我', role: 'guest', joinedAt: 5, online: true },
            { clientId: 'client-other', displayName: '其他玩家', role: 'host', joinedAt: 1, online: true },
        ],
    };

    barrier.begin();
    // 模拟 room.join ack 与 member.joined fanout 交错：即时帧可以先到。
    barrier.route(currentJoin);
    const result = barrier.commit(payload);

    assert.deepEqual(result, { needsFollowUp: false, closed: false });
    assert.equal(store.inRoom, true, 'the current membership remains rendered after replay');
    assert.equal(store.lastAppliedSeq, 5);
    assert.deepEqual(store.snapshot.timeline.map((message) => message.messageId), ['message-3']);
    barrier.end();
    console.log('PASS rejoin replay ignores a superseded self-leave event');
}

// 过滤只作用于旧 membership：当前 self-joined 之后抵达的真实踢人仍是终态。
{
    const { store, barrier } = createHarness();
    const hostJoined = memberJoined(1, 'client-other', { role: 'host', joinedAt: 1 });
    const firstJoin = memberJoined(2, SELF_ID, { joinedAt: 2 });
    const oldLeave = memberLeft(4, SELF_ID);
    const currentJoin = memberJoined(5, SELF_ID, { joinedAt: 5 });
    const currentKick = memberLeft(6, SELF_ID, 'kicked');
    const payload = {
        ...resumePayload({
            events: [hostJoined, firstJoin, persisted(3), oldLeave, currentJoin],
            lastSeq: 5,
        }),
        members: [
            { clientId: SELF_ID, displayName: '我', role: 'guest', joinedAt: 5, online: true },
            { clientId: 'client-other', displayName: '其他玩家', role: 'host', joinedAt: 1, online: true },
        ],
    };

    barrier.begin();
    // room.resume 的权威快照仍是当前 membership；随后抵达的实时 kick 必须
    // 继续生效，不能被“旧 self-left”过滤规则吞掉。
    barrier.route(currentKick);
    const result = barrier.commit(payload);

    assert.deepEqual(result, { needsFollowUp: false, closed: true });
    assert.equal(store.inRoom, false);
    assert.equal(store.snapshot.closedReason, 'kicked');
    console.log('PASS current self-kick after rejoin is not suppressed');
}

// 自动重连：第二次 resume 应把第一次看到的未来 seq 与缺失 seq 一起连续应用。
{
    const { store, barrier } = createHarness({ seeded: true });
    assert.equal(store.applyEvent(persisted(1)), true);

    barrier.begin();
    barrier.route(persisted(4));
    const first = barrier.commit(resumePayload({ events: [persisted(2)], lastSeq: 2 }));
    assert.deepEqual(first, { needsFollowUp: true, closed: false });
    assert.equal(store.lastAppliedSeq, 2);

    const second = barrier.commit(resumePayload({ events: [persisted(3)], lastSeq: 4 }));
    assert.deepEqual(second, { needsFollowUp: false, closed: false });
    assert.deepEqual(store.snapshot.timeline.map((message) => message.messageId), ['message-1', 'message-2', 'message-3', 'message-4']);
    assert.equal(store.lastAppliedSeq, 4);
    barrier.end();
    console.log('PASS future sequence requests one follow-up resume and converges');
}

// ack 回放与即时投递重复同一 seq 时只应写入一次。
{
    const { store, barrier } = createHarness({ seeded: true });
    assert.equal(store.applyEvent(persisted(1)), true);

    barrier.begin();
    barrier.route(persisted(2));
    barrier.route(persisted(2));
    const result = barrier.commit(resumePayload({ events: [persisted(2)], lastSeq: 2 }));

    assert.deepEqual(result, { needsFollowUp: false, closed: false });
    assert.deepEqual(store.snapshot.timeline.map((message) => message.messageId), ['message-1', 'message-2']);
    barrier.end();
    console.log('PASS duplicate replay/live sequence is de-duplicated');
}

// 无 seq 的生成事件不能被 Map 覆盖，必须保持 FIFO。
{
    const { store, barrier } = createHarness({ seeded: true });
    const seen = [];
    store.addEventListener('event', (event) => seen.push(event.detail.type));

    barrier.begin();
    barrier.route(transient(EventType.GENERATION_STARTED));
    barrier.route(transient(EventType.GENERATION_PROGRESSED, { text: '第一段' }));
    barrier.route(transient(EventType.GENERATION_PROGRESSED, { text: '第二段' }));
    barrier.route(transient(EventType.GENERATION_FINISHED, { ok: true }));
    const result = barrier.commit(resumePayload());

    assert.deepEqual(result, { needsFollowUp: false, closed: false });
    assert.deepEqual(seen, [
        EventType.GENERATION_STARTED,
        EventType.GENERATION_PROGRESSED,
        EventType.GENERATION_PROGRESSED,
        EventType.GENERATION_FINISHED,
    ]);
    assert.equal(store.snapshot.generating, false);
    assert.equal(store.snapshot.generatingText, null);
    barrier.end();
    console.log('PASS transient events retain FIFO order across resume');
}

// 被踢/关房属于终态：后续缓冲事件不得写入已关闭的 RoomStore。
{
    const { store, barrier } = createHarness({ seeded: true });
    assert.equal(store.applyEvent(persisted(1)), true);
    const kicked = {
        v: 1,
        kind: 'event',
        type: EventType.ROOM_MEMBER_LEFT,
        eventId: 'event-kicked',
        roomId: ROOM_ID,
        seq: 2,
        payload: { clientId: SELF_ID, reason: 'kicked' },
    };

    barrier.begin();
    barrier.route(kicked);
    barrier.route(persisted(3));
    const result = barrier.commit(resumePayload({ events: [kicked, persisted(3)], lastSeq: 3 }));

    assert.deepEqual(result, { needsFollowUp: false, closed: true });
    assert.equal(store.inRoom, false);
    assert.equal(store.snapshot.closedReason, 'kicked');
    assert.equal(barrier.active, false);
    console.log('PASS terminal self-kick clears buffered room events');
}

// 真实 RelayClient 的自动重连链路：resumeProvider 先开栅栏，随后在
// "即时 event → room.resume ack → resumed" 的顺序下仍连续合并。这里用
// 可控 WebSocket 替身只模拟传输，不绕过 RelayClient 的重连/自动恢复实现。
{
    const nativeWebSocket = globalThis.WebSocket;
    class FakeWebSocket extends EventTarget {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSED = 3;
        static instances = [];

        constructor(url) {
            super();
            this.url = url;
            this.readyState = FakeWebSocket.CONNECTING;
            this.sent = [];
            FakeWebSocket.instances.push(this);
        }

        send(data) {
            this.sent.push(JSON.parse(data));
        }

        close() {
            if (this.readyState === FakeWebSocket.CLOSED) return;
            this.readyState = FakeWebSocket.CLOSED;
            this.dispatchEvent(new Event('close'));
        }

        open() {
            this.readyState = FakeWebSocket.OPEN;
            this.dispatchEvent(new Event('open'));
        }

        remoteClose() {
            this.close();
        }

        deliver(message) {
            this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
        }
    }

    globalThis.WebSocket = FakeWebSocket;
    const { store, barrier } = createHarness({ seeded: true });
    assert.equal(store.applyEvent(persisted(1)), true);
    const client = new RelayClient();
    let resumedResult = null;

    try {
        client.addEventListener('message', (event) => {
            if (event.detail?.kind === 'event') barrier.route(event.detail);
        });
        client.addEventListener('resumed', (event) => {
            resumedResult = barrier.commit(event.detail.payload);
            if (!resumedResult.needsFollowUp && !resumedResult.closed) barrier.end();
        });
        client.resumeProvider = async () => {
            // 与 ui.js 相同：自动重连时先进入缓冲区，再让 RelayClient 发 room.resume。
            barrier.begin();
            return { lastAppliedSeq: store.lastAppliedSeq };
        };

        client.connect('ws://resume.test/ws');
        const firstSocket = FakeWebSocket.instances[0];
        firstSocket.open();
        firstSocket.remoteClose();

        await until(() => FakeWebSocket.instances.length === 2, 'auto-reconnect socket');
        const reconnectSocket = FakeWebSocket.instances[1];
        reconnectSocket.open();
        await until(
            () => reconnectSocket.sent.some((message) => message.type === 'room.resume'),
            'automatic room.resume request',
        );
        const resumeRequest = reconnectSocket.sent.find((message) => message.type === 'room.resume');

        reconnectSocket.deliver(persisted(3));
        reconnectSocket.deliver({
            v: 1,
            kind: 'ack',
            requestId: resumeRequest.requestId,
            type: 'room.resume.ack',
            payload: resumePayload({ events: [persisted(2)], lastSeq: 2 }),
        });
        await until(() => resumedResult !== null, 'resumed event');

        assert.deepEqual(resumedResult, { needsFollowUp: false, closed: false });
        assert.deepEqual(store.snapshot.timeline.map((message) => message.messageId), ['message-1', 'message-2', 'message-3']);
        assert.equal(store.lastAppliedSeq, 3);
        assert.equal(barrier.active, false);
        console.log('PASS automatic reconnect resumeProvider → resumed merges pre-ack live event');
    } finally {
        client.disconnect();
        globalThis.WebSocket = nativeWebSocket;
    }
}

console.log('RESUME EVENT BARRIER TEST OK');
