import assert from 'node:assert/strict';
import { getExtensionSettings } from '../src/settings.js';

const credentials = { clientId: 'client-1', sessionToken: 'secret' };
const context = {
    extensionSettings: {
        sillytavernMultiplayer: {
            relayUrl: 'wss://relay.example/ws',
            reconnect: false,
            credentials,
            displayName: '旧昵称',
            personaName: '旧角色名',
        },
    },
};

const settings = getExtensionSettings(context);
assert.equal(settings.relayUrl, 'wss://relay.example/ws');
assert.equal(settings.reconnect, false);
assert.deepEqual(settings.credentials, credentials);
assert.equal(settings.ballPos, null);
assert.equal(Object.hasOwn(settings, 'displayName'), false);
assert.equal(Object.hasOwn(settings, 'personaName'), false);
console.log('PASS saved Relay settings and credentials survive default merging');

const fresh = getExtensionSettings({ extensionSettings: {} });
assert.equal(Object.hasOwn(fresh, 'displayName'), false);
assert.equal(Object.hasOwn(fresh, 'personaName'), false);
console.log('PASS fresh settings no longer maintain duplicate nickname fields');
