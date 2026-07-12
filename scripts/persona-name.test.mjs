import assert from 'node:assert/strict';
import { getCurrentPersonaName, getMessagePersonaName } from '../src/persona-name.js';
import { EventType } from '../src/protocol.js';
import { RoomStore } from '../src/room-store.js';

let currentName = '房主 Persona';
const contextProvider = () => ({ name1: currentName });

assert.equal(getCurrentPersonaName(contextProvider), '房主 Persona');
currentName = '客人 Persona';
assert.equal(getCurrentPersonaName(contextProvider), '客人 Persona');
console.log('PASS Persona name is read fresh from the current SillyTavern context');

assert.equal(getCurrentPersonaName(() => ({ name1: '   ' })), '玩家');
assert.equal(getCurrentPersonaName(() => null), '玩家');
assert.equal(getCurrentPersonaName(() => ({ name1: `  ${'名'.repeat(60)}  ` })), '名'.repeat(50));
console.log('PASS Persona name always satisfies the relay display-name contract');

currentName = '切换后的 Persona';
assert.equal(getMessagePersonaName({ name: '发送时的 Persona' }, contextProvider), '发送时的 Persona');
assert.equal(getMessagePersonaName({}, contextProvider), '切换后的 Persona');
console.log('PASS a sent message keeps the Persona captured by SillyTavern');

const store = new RoomStore();
store.seedRoom({
    roomId: 'room-1',
    role: 'host',
    selfClientId: 'host-1',
    members: [{ clientId: 'guest-1', displayName: '旧 Persona', role: 'guest', joinedAt: 1, online: true }],
});
store.applyEvent({
    kind: 'event',
    roomId: 'room-1',
    seq: 1,
    type: EventType.ROOM_MEMBER_ONLINE,
    payload: { clientId: 'guest-1', displayName: '新 Persona' },
});
assert.equal(store.snapshot.members[0].displayName, '新 Persona');
console.log('PASS an online member event refreshes the displayed Persona name');
