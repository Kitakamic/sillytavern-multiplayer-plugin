const EXTENSION_KEY = 'sillytavernMultiplayer';

const DEFAULT_SETTINGS = Object.freeze({
    relayUrl: '',
    reconnect: true,
    /** auth.hello 颁发的恢复凭据 { clientId, sessionToken }；仅用于断线重连恢复席位。 */
    credentials: null,
    /** 悬浮球位置 { left, top }（px）；null 表示使用默认位置。 */
    ballPos: null,
    /** 客机已导入的共享卡：cardKey → { contentHash, fileName }，跨房间复用同一本地角色文件。 */
    importedCards: null,
    /** 客机已导入的联机存档：saveKey → { contentHash, fileName }，覆盖写同一本地聊天文件。 */
    importedSaves: null,
});

export function getExtensionSettings(context) {
    const saved = { ...(context.extensionSettings[EXTENSION_KEY] ?? {}) };
    delete saved.displayName;
    delete saved.personaName;
    context.extensionSettings[EXTENSION_KEY] = { ...DEFAULT_SETTINGS, ...saved };
    return context.extensionSettings[EXTENSION_KEY];
}
