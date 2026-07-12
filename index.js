import { createHostBridge } from './src/host-bridge.js';
import { CharacterCardSharing } from './src/card-sharing.js';
import { ChatSaveSharing } from './src/save-sharing.js';
import { RelayClient } from './src/relay-client.js';
import { RoomStore } from './src/room-store.js';
import { getExtensionSettings } from './src/settings.js';
import { mountMultiplayerPanel } from './src/ui.js';

/**
 * 生成拦截器（manifest.generate_interceptor 指向的全局函数）：
 * 具体判定逻辑由 ui.js 在挂载后注册——客机在镜像角色上时中止本地生成。
 */
const generateInterceptor = { handler: null };
globalThis.stMultiplayerGenerateInterceptor = async function (chat, contextSize, abort, type) {
    try {
        await generateInterceptor.handler?.(chat, contextSize, abort, type);
    } catch (error) {
        console.error('[ST Multiplayer] 生成拦截器执行失败：', error);
    }
};

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
        registerGenerateInterceptor: (handler) => { generateInterceptor.handler = handler; },
    });

    console.debug('[ST Multiplayer] Extension scaffold loaded.');
}

$(initialize);

