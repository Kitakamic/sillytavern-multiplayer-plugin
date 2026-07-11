import assert from 'node:assert/strict';
import { createKickCommand } from '../src/kick-command.js';

const command = createKickCommand({
    targetClientId: 'guest-1',
    selfClientId: 'host-1',
});

assert.equal(command.type, 'room.kick');
assert.deepEqual(command.payload, { clientId: 'guest-1' });
console.log('PASS valid kick target produces room.kick command');

assert.throws(
    () => createKickCommand({ targetClientId: undefined, selfClientId: 'host-1' }),
    /目标成员参数无效/,
);
console.log('PASS missing kick target is rejected before relay request');

assert.throws(
    () => createKickCommand({ targetClientId: 'host-1', selfClientId: 'host-1' }),
    /不能踢出房主自己/,
);
console.log('PASS host cannot accidentally target itself');
