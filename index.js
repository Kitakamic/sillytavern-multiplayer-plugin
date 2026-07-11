import { createHostBridge } from './src/host-bridge.js';
import { CharacterCardSharing } from './src/card-sharing.js';
import { RelayClient } from './src/relay-client.js';
import { RoomStore } from './src/room-store.js';
import { mountMultiplayerPanel } from './src/ui.js';

const EXTENSION_KEY = 'sillytavernMultiplayer';
const DEFAULT_SETTINGS = Object.freeze({
    relayUrl: '',
    displayName: '',
    reconnect: true,
    /** auth.hello 颁发的恢复凭据 { clientId, sessionToken }；仅用于断线重连恢复席位。 */
    credentials: null,
    /** 悬浮球位置 { left, top }（px）；null 表示使用默认位置。 */
    ballPos: null,
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
    const hostBridge = createHostBridge(context);
    const cardSharing = new CharacterCardSharing(() => globalThis.SillyTavern?.getContext?.());

    mountMultiplayerPanel({
        settings,
        store,
        relay,
        hostBridge,
        cardSharing,
        saveSettings: () => context.saveSettingsDebounced(),
    });

    console.debug('[ST Multiplayer] Extension scaffold loaded.');
}

$(initialize);

