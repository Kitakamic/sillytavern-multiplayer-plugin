// 插件连接层冒烟测试（Node 22+，利用全局 WebSocket 直接驱动浏览器端模块）。
// 用法: node scripts/smoke-client.mjs [wsUrl]           （默认 ws://127.0.0.1:3001/ws）
// 环境: RELAY_SMOKE_WAIT_RECONNECT=1 → 首次 ping 后等待外部重启中继，验证自动重连。
import { RelayClient } from '../src/relay-client.js';
import { CommandType, createCommand, createInviteCode, parseInviteCode } from '../src/protocol.js';

const wsUrl = process.argv[2] ?? 'ws://127.0.0.1:3001/ws';

function fail(message) {
    console.error(`FAIL ${message}`);
    process.exit(1);
}

const invite = { relayUrl: 'wss://relay.example.com/ws', roomId: 'room-42', token: 'tok_abc' };
const decoded = parseInviteCode(createInviteCode(invite));
if (JSON.stringify(decoded) !== JSON.stringify(invite)) fail('invite code roundtrip mismatch');
console.log('PASS invite code roundtrip');

try {
    parseInviteCode('this-is-not-an-invite!!!');
    fail('invalid invite code was accepted');
} catch {
    console.log('PASS invalid invite rejected');
}

const client = new RelayClient();

function waitState(state, timeoutMs = 15000) {
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

client.connect(wsUrl);
await waitState('connected').catch((error) => fail(error.message));
console.log('PASS connected');

const ack = await client.request(createCommand(CommandType.RELAY_PING)).catch((error) => fail(`ping failed: ${error.message}`));
if (ack.type !== 'relay.ping.ack') fail(`unexpected ping reply: ${JSON.stringify(ack)}`);
console.log('PASS request/ack correlation');

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
    console.log('PASS auto-reconnect + post-reconnect ping');
}

client.disconnect();
console.log('CLIENT SMOKE OK');
process.exit(0);
