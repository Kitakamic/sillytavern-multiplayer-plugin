import { createHostBridge } from './src/host-bridge.js';
import { CharacterCardSharing } from './src/card-sharing.js';
import { ChatSaveSharing } from './src/save-sharing.js';
import { RelayClient } from './src/relay-client.js';
import { RoomStore } from './src/room-store.js';
import { mountMultiplayerPanel } from './src/ui.js';

const EXTENSION_KEY = 'sillytavernMultiplayer';
const DEFAULT_SETTINGS = Object.freeze({
    relayUrl: '',
    displayName: '',
    /** 故事内署名（角色名）；留空时用 displayName。 */
    personaName: '',
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

function getExtensionSettings(context) {
    context.extensionSettings[EXTENSION_KEY] ??= {};
    Object.assign(context.extensionSettings[EXTENSION_KEY], DEFAULT_SETTINGS, context.extensionSettings[EXTENSION_KEY]);
    return context.extensionSettings[EXTENSION_KEY];
}

function initialize() {
    const context = globalThis.SillyTavern?.getContext?.();
    if (!context) {
        console.error('[ST Multiplayer] SillyTavern extension context is unavailable.');
        return;
    }

    const settings = getExtensionSettings(context);
    const store = new RoomStore();
    const relay = new RelayClient();
    relay.reconnectEnabled = settings.reconnect;
    const contextProvider = () => globalThis.SillyTavern?.getContext?.();
    const hostBridge = createHostBridge(contextProvider);
    const cardSharing = new CharacterCardSharing(contextProvider);
    const saveSharing = new ChatSaveSharing(contextProvider);

    // 版本护栏（P2）：getContext() 暴露面探测。缺 API 时明确报错而非静默失败；
    // UI 仍然挂载，房主功能在调用时会给出具体错误。
    const missingApis = hostBridge.missingApis();
    if (missingApis.length) {
        console.error('[ST Multiplayer] getContext() 缺少所需 API：', missingApis);
        toastr.error(`酒馆版本过旧或内部 API 变动，联机的房主功能不可用（缺少：${missingApis.join(', ')}）。`, '联机酒馆');
    }

    mountMultiplayerPanel({
        settings,
        store,
        relay,
        hostBridge,
        cardSharing,
        saveSharing,
        saveSettings: () => context.saveSettingsDebounced(),
    });

    console.debug('[ST Multiplayer] Extension scaffold loaded.');
}

$(initialize);

