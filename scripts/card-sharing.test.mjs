import assert from 'node:assert/strict';
import { CharacterCardSharing } from '../src/card-sharing.js';
import { CommandType, EventType } from '../src/protocol.js';
import { RoomStore } from '../src/room-store.js';

const png = new Blob([
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    new Uint8Array(32),
], { type: 'image/png' });

const calls = [];
let selectedCharacterId = null;
const context = {
    groupId: null,
    characterId: 0,
    characters: [{ name: '测试角色', avatar: 'test.png' }],
    getRequestHeaders: ({ omitContentType } = {}) => ({
        'x-csrf-token': 'test-token',
        ...(!omitContentType ? { 'content-type': 'application/json' } : {}),
    }),
    async getCharacters() {
        this.characters.splice(0, this.characters.length, { name: '测试角色', avatar: 'stmp_room-1.png' });
    },
    async selectCharacterById(id) {
        selectedCharacterId = id;
    },
};
const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (url === '/api/characters/export') return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    if (String(url).includes('/rooms/room-1/assets?kind=card')) {
        return Response.json({ ok: true, assetId: 'asset-1', bytes: png.size, expiresAt: 123456 });
    }
    if (String(url).includes('/rooms/room-1/assets/asset-1')) return new Response(png, { status: 200 });
    if (url === '/api/characters/import') {
        assert.equal(options.body.get('file_type'), 'png');
        assert.equal(options.body.get('preserved_name'), 'stmp_room-1');
        assert.equal(options.headers['content-type'], undefined);
        return Response.json({ file_name: 'stmp_room-1' });
    }
    throw new Error(`unexpected fetch ${url}`);
};

const sharing = new CharacterCardSharing(context, fetchImpl);
const shared = await sharing.shareCurrentCard({
    relayUrl: 'ws://127.0.0.1:3001/ws',
    roomId: 'room-1',
    credentials: { clientId: 'host-1', sessionToken: 'secret' },
});

assert.deepEqual(shared, {
    assetId: 'asset-1',
    characterName: '测试角色',
    bytes: png.size,
    expiresAt: 123456,
    cardKey: 'dfc4beade01bd86a',
    contentHash: '629f4275ec7728373546c2565e62bc8bfa5577c1d8aa82a340c0436aa5c4eccf',
});
assert.equal(calls[0].url, '/api/characters/export');
assert.deepEqual(JSON.parse(calls[0].options.body), { format: 'png', avatar_url: 'test.png' });
assert.equal(calls[1].url, 'http://127.0.0.1:3001/rooms/room-1/assets?kind=card');
assert.equal(calls[1].options.headers['x-relay-client-id'], 'host-1');
assert.equal(calls[1].options.headers['x-relay-session-token'], 'secret');
assert.equal(calls[1].options.headers['content-type'], 'image/png');
assert.equal(calls[1].options.body.type, 'image/png');

console.log('PASS host exports and uploads the current full card');

const imported = await sharing.importSharedCard({
    relayUrl: 'ws://127.0.0.1:3001/ws',
    roomId: 'room-1',
    assetId: 'asset-1',
    credentials: { clientId: 'guest-1', sessionToken: 'guest-secret' },
    preservedName: 'stmp_room-1',
});
assert.deepEqual(imported, { avatarFileName: 'stmp_room-1.png', characterId: 0 });
assert.equal(selectedCharacterId, 0);
const downloadCall = calls.find((call) => call.url.endsWith('/rooms/room-1/assets/asset-1'));
assert.equal(downloadCall.options.headers['x-relay-client-id'], 'guest-1');
console.log('PASS guest downloads, replaces, and selects the room card');

assert.equal(CommandType.ROOM_CARD_UPDATE, 'room.card.update');
assert.equal(CommandType.ROOM_CARD_CLEAR, 'room.card.clear');
const store = new RoomStore();
store.seedRoom({ roomId: 'room-1', role: 'guest', selfClientId: 'guest-1' });
store.applyEvent({
    kind: 'event', roomId: 'room-1', seq: 1, type: EventType.ROOM_CARD_UPDATED,
    payload: { assetId: 'asset-1', characterName: '测试角色', bytes: png.size, expiresAt: 123456, sharedAt: 100 },
});
assert.equal(store.snapshot.sharedCard.assetId, 'asset-1');
store.applyEvent({
    kind: 'event', roomId: 'room-1', seq: 2, type: EventType.ROOM_CARD_CLEARED,
    payload: { assetId: 'asset-1' },
});
assert.equal(store.snapshot.sharedCard, null);
console.log('PASS room projection tracks shared-card publish and revoke events');
