import { CommandType, createCommand } from './protocol.js';

export function createKickCommand({ targetClientId, selfClientId }) {
    if (typeof targetClientId !== 'string' || !targetClientId.trim()) {
        throw new Error('无法踢出：目标成员参数无效，请刷新成员列表后重试。');
    }

    const clientId = targetClientId.trim();
    if (clientId === selfClientId) throw new Error('不能踢出房主自己。');

    return createCommand(CommandType.ROOM_KICK, { clientId });
}
