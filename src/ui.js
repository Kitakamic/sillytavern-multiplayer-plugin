const PANEL_ID = 'st-multiplayer-panel';

export function mountMultiplayerPanel({ settings, relay, saveSettings }) {
    if ($(`#${PANEL_ID}`).length) return;

    const container = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    if (!container.length) {
        console.warn('[ST Multiplayer] Extension settings container was not found.');
        return;
    }

    const panel = $(`
        <div id="${PANEL_ID}" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>SillyTavern Multiplayer</b>
                <div class="inline-drawer-icon fa-solid fa-circle-nodes down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="stmp-row">
                    <label for="st-multiplayer-relay-url">Relay</label>
                    <input id="st-multiplayer-relay-url" class="text_pole" type="url" placeholder="wss://relay.example.com/ws">
                </div>
                <div class="stmp-row">
                    <label for="st-multiplayer-display-name">昵称</label>
                    <input id="st-multiplayer-display-name" class="text_pole" type="text" maxlength="32">
                </div>
                <div class="stmp-row">
                    <label class="checkbox_label" for="st-multiplayer-reconnect">
                        <input id="st-multiplayer-reconnect" type="checkbox">
                        <span>断线自动重连</span>
                    </label>
                </div>
                <div class="stmp-row">
                    <button id="st-multiplayer-connect" class="menu_button">连接 Relay</button>
                    <span id="st-multiplayer-status">未连接</span>
                </div>
            </div>
        </div>
    `);

    panel.find('#st-multiplayer-relay-url').val(settings.relayUrl);
    panel.find('#st-multiplayer-display-name').val(settings.displayName);
    panel.find('#st-multiplayer-reconnect').prop('checked', settings.reconnect);

    panel.find('#st-multiplayer-relay-url').on('input', function () {
        settings.relayUrl = String($(this).val()).trim();
        saveSettings();
    });
    panel.find('#st-multiplayer-display-name').on('input', function () {
        settings.displayName = String($(this).val()).trim();
        saveSettings();
    });
    panel.find('#st-multiplayer-reconnect').on('change', function () {
        settings.reconnect = $(this).prop('checked');
        relay.reconnectEnabled = settings.reconnect;
        saveSettings();
    });
    panel.find('#st-multiplayer-connect').on('click', () => {
        try {
            relay.connect(settings.relayUrl);
        } catch (error) {
            toastr.error(error.message, '联机酒馆');
        }
    });

    relay.addEventListener('statechange', (event) => {
        const labels = { idle: '未连接', connecting: '正在连接', connected: '已连接', reconnecting: '正在重连', disconnected: '连接已断开' };
        panel.find('#st-multiplayer-status').text(labels[event.detail] ?? event.detail);
    });
    relay.addEventListener('error', () => toastr.error('无法连接到 Relay。', '联机酒馆'));

    container.append(panel);
}

