import { createHostBridge } from './src/host-bridge.js';
import { RelayClient } from './src/relay-client.js';
import { RoomStore } from './src/room-store.js';
import { mountMultiplayerPanel } from './src/ui.js';

const EXTENSION_KEY = 'sillytavernMultiplayer';
const DEFAULT_SETTINGS = Object.freeze({
    relayUrl: '',
    displayName: '',
    reconnect: true,
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

    mountMultiplayerPanel({
        settings,
        store,
        relay,
        hostBridge,
        saveSettings: () => context.saveSettingsDebounced(),
    });

    console.debug('[ST Multiplayer] Extension scaffold loaded.');
}

$(initialize);

