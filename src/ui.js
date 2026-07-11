import { CommandType, EventType, createCommand, createInviteCode, parseInviteCode } from './protocol.js';
import { createKickCommand } from './kick-command.js';

const PANEL_ID = 'st-multiplayer-panel';
const WINDOW_ID = 'stmp-window';
const CONNECT_WAIT_MS = 12000;

const STATE_LABELS = {
    idle: '未连接',
    connecting: '正在连接',
    connected: '已连接',
    reconnecting: '正在重连',
    disconnected: '连接已断开',
};

const CLOSED_REASON_TEXT = {
    left: '你已离开房间。',
    kicked: '你被房主移出了房间。',
    host_left: '房主已关闭房间。',
    expired: '房间已过期。',
};

const ERROR_TEXT = {
    BAD_PAYLOAD: '请求参数无效。',
    NOT_AUTHENTICATED: '尚未完成身份握手，请重新连接。',
    ALREADY_IN_ROOM: '已在房间中，请先离开当前房间。',
    NOT_IN_ROOM: '当前不在任何房间（可能已被关闭）。',
    CREATOR_KEY_INVALID: '房主密钥不正确。',
    ROOM_NOT_FOUND: '房间不存在或已过期。',
    ROOM_FULL: '房间已满。',
    INVITE_INVALID: '邀请码无效、已过期或已用尽。',
    FORBIDDEN: '没有权限执行该操作。',
    TARGET_NOT_FOUND: '目标不存在。',
    PROPOSAL_NOT_PENDING: '该提案已不在待审状态。',
    RATE_LIMITED: '操作过于频繁，请稍候再试。',
    UNAUTHORIZED: '会话凭据无效，请重新连接。',
    ASSET_NOT_FOUND: '共享的角色卡不存在或已过期。',
    ASSET_TOO_LARGE: '角色卡超过 5 MB，无法共享。',
    UNSUPPORTED_ASSET_TYPE: '角色卡必须是有效的 PNG 文件。',
    INTERNAL: '中继内部错误。',
};

function errorText(error) {
    return ERROR_TEXT[error?.code] ?? error?.message ?? '未知错误。';
}

const PROPOSAL_STATUS_TEXT = {
    pending: '⏳ 待审核',
    accepted: '✅ 已接受',
    rejected: '❌ 已拒绝',
    withdrawn: '↩️ 已撤回',
};

export function mountMultiplayerPanel({ settings, store, relay, cardSharing, saveSharing, saveSettings }) {
    if ($(`#${PANEL_ID}`).length) return;

    const container = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    if (!container.length) {
        console.warn('[ST Multiplayer] Extension settings container was not found.');
        return;
    }

    // 客机导入记录（跨会话持久化）：同一张卡/同一份存档复用同一个本地文件。
    settings.importedCards ??= {};
    settings.importedSaves ??= {};

    // ---------- 控制层状态 ----------
    let helloDone = false;
    let expectHello = false;
    let resumeInFlight = false;
    let lastInviteCode = '';
    let importingCardAssetId = null;
    let importedCardAssetId = null;
    let importedCardFileName = null;
    let cardImportScheduled = false;
    let importingSaveAssetId = null;
    let importedSaveAssetId = null;
    let importedSaveFileName = null;
    let saveImportScheduled = false;

    function helloPayload() {
        const payload = { displayName: settings.displayName || '玩家' };
        if (settings.credentials?.clientId && settings.credentials?.sessionToken) {
            payload.clientId = settings.credentials.clientId;
            payload.sessionToken = settings.credentials.sessionToken;
        }
        return payload;
    }

    /** 身份握手：颁发/恢复凭据；若中继报告我们仍在房间里，则立即 resume 追平。 */
    async function hello() {
        const ack = await relay.request(createCommand(CommandType.AUTH_HELLO, helloPayload()));
        settings.credentials = {
            clientId: ack.payload.clientId,
            sessionToken: ack.payload.sessionToken,
        };
        saveSettings();
        helloDone = true;
        if (ack.payload.room) {
            await resumeRoom(ack.payload.room);
        }
        return ack;
    }

    /** 入房/建房/重连/缺口共用的恢复路径：resume 应答 = 权威快照 + 增量回放。 */
    async function resumeRoom(roomHint = null) {
        if (resumeInFlight) return;
        resumeInFlight = true;
        try {
            const ack = await relay.request(createCommand(CommandType.ROOM_RESUME, {
                lastAppliedSeq: store.inRoom ? store.lastAppliedSeq : 0,
            }));
            applyResume(ack.payload, roomHint);
        } finally {
            resumeInFlight = false;
        }
    }

    function applyResume(payload, roomHint = null) {
        const roomId = payload.roomId ?? roomHint?.roomId;
        if (!store.inRoom || store.snapshot.room.roomId !== roomId) {
            store.seedRoom({
                roomId,
                role: payload.role ?? roomHint?.role,
                selfClientId: settings.credentials.clientId,
                members: payload.members,
                generating: payload.generating,
            });
        } else {
            store.syncPresence({ members: payload.members, generating: payload.generating });
        }
        for (const event of payload.events ?? []) store.applyEvent(event);
    }

    function waitForConnected() {
        return new Promise((resolve, reject) => {
            if (relay.state === 'connected') return resolve();
            const timer = setTimeout(() => {
                relay.removeEventListener('statechange', onChange);
                reject(new Error('连接中继超时。'));
            }, CONNECT_WAIT_MS);
            function onChange(event) {
                if (event.detail === 'connected') {
                    clearTimeout(timer);
                    relay.removeEventListener('statechange', onChange);
                    resolve();
                }
            }
            relay.addEventListener('statechange', onChange);
        });
    }

    /** 确保已连接到 url 并完成 hello；url 变化时重连。 */
    async function ensureSession(url) {
        const target = new URL(url).toString();
        if (relay.state !== 'connected' || currentUrl !== target) {
            currentUrl = target;
            helloDone = false;
            expectHello = false; // 本流程自己做 hello，不走按钮路径
            relay.connect(target);
            await waitForConnected();
        }
        if (!helloDone) await hello();
    }
    let currentUrl = null;

    async function joinRoom(code) {
        const invite = parseInviteCode(code);
        settings.relayUrl = invite.relayUrl;
        saveSettings();
        await ensureSession(invite.relayUrl);
        if (store.inRoom) throw Object.assign(new Error('已在房间中。'), { code: 'ALREADY_IN_ROOM' });
        await relay.request(createCommand(CommandType.ROOM_JOIN, { roomId: invite.roomId, token: invite.token }));
        lastInviteCode = code.trim();
        await resumeRoom();
        toastr.success('已加入房间。', '联机酒馆');
    }

    async function createRoom(creatorKey) {
        if (!settings.relayUrl) throw new Error('请先在扩展设置中填写 Relay 地址。');
        await ensureSession(settings.relayUrl);
        if (store.inRoom) throw Object.assign(new Error('已在房间中。'), { code: 'ALREADY_IN_ROOM' });
        const ack = await relay.request(createCommand(CommandType.ROOM_CREATE, { creatorKey }));
        lastInviteCode = createInviteCode({
            relayUrl: settings.relayUrl,
            roomId: ack.payload.roomId,
            token: ack.payload.inviteToken,
        });
        await resumeRoom();
        toastr.success('房间已创建，邀请码已生成。', '联机酒馆');
    }

    async function leaveRoom() {
        await relay.request(createCommand(CommandType.ROOM_LEAVE));
        lastInviteCode = '';
        store.reset('left');
    }

    async function shareCurrentCard() {
        const snapshot = store.snapshot;
        if (snapshot.room?.role !== 'host') throw new Error('只有房主可以共享完整角色卡。');
        const previousAssetId = snapshot.sharedCard?.assetId;
        const shared = await cardSharing.shareCurrentCard({
            relayUrl: settings.relayUrl,
            roomId: snapshot.room.roomId,
            credentials: settings.credentials,
            skipIfHash: snapshot.sharedCard?.contentHash ?? null,
        });
        if (shared.unchanged) return shared;
        await relay.request(createCommand(CommandType.ROOM_CARD_UPDATE, shared));

        // 更新卡片后立即撤销旧资产；clear 事件携带旧 ID，不会清掉新投影。
        if (previousAssetId && previousAssetId !== shared.assetId) {
            await relay.request(createCommand(CommandType.ROOM_CARD_CLEAR, { assetId: previousAssetId }));
        }
        return shared;
    }

    function sanitizeToken(value) {
        return String(value).replace(/[^A-Za-z0-9]/g, '');
    }

    /** 客机导入记录查找：优先按 cardKey（同一张卡的更新），退而按内容哈希（同卡进了新房间）。 */
    function findImportedCardRecord(card) {
        if (!card) return null;
        if (card.cardKey && settings.importedCards[card.cardKey]) return settings.importedCards[card.cardKey];
        if (card.contentHash) {
            for (const record of Object.values(settings.importedCards)) {
                if (record.contentHash && record.contentHash === card.contentHash) return record;
            }
        }
        return null;
    }

    function rememberImportedCard(card, fileName) {
        if (!card.cardKey) return;
        settings.importedCards[card.cardKey] = { contentHash: card.contentHash ?? null, fileName };
        saveSettings();
    }

    async function importSharedCard(card, force = false) {
        if (!card || store.role !== 'guest') return;
        if (!force && importedCardAssetId === card.assetId) return;
        if (importingCardAssetId) return;

        importingCardAssetId = card.assetId;
        render();
        try {
            const known = findImportedCardRecord(card);

            // 内容未变且本地副本还在：不下载不导入，直接复用。
            if (!force && known && card.contentHash && known.contentHash === card.contentHash && cardSharing.hasCharacter(known.fileName)) {
                await cardSharing.selectByAvatar(known.fileName);
                importedCardAssetId = card.assetId;
                importedCardFileName = known.fileName;
                rememberImportedCard(card, known.fileName);
                toastr.info(`角色卡与本地副本一致，已复用：${card.characterName}`, '联机酒馆');
                return;
            }

            // 复用旧文件名 = 原地覆盖更新（挂在角色下的聊天不丢）；
            // 首次导入按内容哈希命名，同一张卡换房间不再产生新副本。
            const preservedName = known && cardSharing.hasCharacter(known.fileName)
                ? known.fileName.replace(/\.png$/, '')
                : `stmp_${sanitizeToken(card.contentHash ?? card.assetId).slice(0, 12)}`;
            const result = await cardSharing.importSharedCard({
                relayUrl: settings.relayUrl,
                roomId: store.snapshot.room.roomId,
                assetId: card.assetId,
                credentials: settings.credentials,
                preservedName,
            });
            importedCardAssetId = card.assetId;
            importedCardFileName = result.avatarFileName;
            rememberImportedCard(card, result.avatarFileName);
            toastr.success(`已同步完整角色卡：${card.characterName}`, '联机酒馆');
        } finally {
            importingCardAssetId = null;
            render();
            const latest = store.snapshot.sharedCard;
            if (latest && latest.assetId !== card.assetId) scheduleSharedCardImport();
            else scheduleSharedSaveImport(); // 联机存档可能在等镜像角色就位
        }
    }

    /** 合并 resume 的同步事件回放，只导入回放结束后的最终共享卡。 */
    function scheduleSharedCardImport() {
        if (cardImportScheduled) return;
        cardImportScheduled = true;
        queueMicrotask(() => {
            cardImportScheduled = false;
            const card = store.snapshot.sharedCard;
            if (!card || store.role !== 'guest') return;
            void importSharedCard(card).catch((error) => {
                console.error('[ST Multiplayer] 自动导入共享角色卡失败：', error);
                toastr.error(`${errorText(error)} 可在联机面板中重试。`, '联机酒馆');
            });
        });
    }

    async function shareCurrentSave() {
        const snapshot = store.snapshot;
        if (snapshot.room?.role !== 'host') throw new Error('只有房主可以共享联机存档。');
        const previousAssetId = snapshot.sharedSave?.assetId;
        const shared = await saveSharing.shareCurrentSave({
            relayUrl: settings.relayUrl,
            roomId: snapshot.room.roomId,
            credentials: settings.credentials,
            skipIfHash: snapshot.sharedSave?.contentHash ?? null,
        });
        if (shared.unchanged) return shared;
        await relay.request(createCommand(CommandType.ROOM_CHAT_UPDATE, shared));

        // 与共享卡同理：新快照发布后立即撤销旧资产。
        if (previousAssetId && previousAssetId !== shared.assetId) {
            await relay.request(createCommand(CommandType.ROOM_CHAT_CLEAR, { assetId: previousAssetId }));
        }
        return shared;
    }

    async function importSharedSave(save, force = false) {
        if (!save || store.role !== 'guest') return;
        if (!force && importedSaveAssetId === save.assetId) return;
        if (importingSaveAssetId) return;

        // 存档要写在镜像角色名下；角色卡还没同步时先等（卡片导入完成后会再触发）。
        const targetAvatar = importedCardFileName ?? findImportedCardRecord(store.snapshot.sharedCard)?.fileName ?? null;
        if (!targetAvatar || !cardSharing.hasCharacter(targetAvatar)) {
            render();
            return;
        }

        // 内容没变就不重写本地文件（手动“重新导入”例外）。
        const record = save.saveKey ? settings.importedSaves[save.saveKey] : null;
        if (!force && record && save.contentHash && record.contentHash === save.contentHash) {
            importedSaveAssetId = save.assetId;
            importedSaveFileName = record.fileName;
            render();
            return;
        }

        importingSaveAssetId = save.assetId;
        render();
        try {
            const fileName = record?.fileName ?? `联机存档-${sanitizeToken(save.saveKey ?? save.assetId).slice(0, 8)}`;
            const result = await saveSharing.importSharedSave({
                relayUrl: settings.relayUrl,
                roomId: store.snapshot.room.roomId,
                assetId: save.assetId,
                credentials: settings.credentials,
                targetAvatar,
                fileName,
            });
            importedSaveAssetId = save.assetId;
            importedSaveFileName = result.fileName;
            if (save.saveKey) {
                settings.importedSaves[save.saveKey] = { contentHash: save.contentHash ?? null, fileName: result.fileName };
                saveSettings();
            }
            toastr.success(`已同步联机存档：${save.chatName}（${save.messageCount} 条消息）`, '联机酒馆');
        } finally {
            importingSaveAssetId = null;
            render();
            const latest = store.snapshot.sharedSave;
            if (latest && latest.assetId !== save.assetId) scheduleSharedSaveImport();
        }
    }

    /** 合并 resume 回放，只导入回放结束后的最终共享存档。 */
    function scheduleSharedSaveImport() {
        if (saveImportScheduled) return;
        saveImportScheduled = true;
        queueMicrotask(() => {
            saveImportScheduled = false;
            const save = store.snapshot.sharedSave;
            if (!save || store.role !== 'guest') return;
            void importSharedSave(save).catch((error) => {
                console.error('[ST Multiplayer] 自动导入联机存档失败：', error);
                toastr.error(`${errorText(error)} 可在联机面板中重试。`, '联机酒馆');
            });
        });
    }

    // ---------- 设置抽屉 ----------
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
        ensureSession(settings.relayUrl)
            .then(() => toastr.success('已连接到中继。', '联机酒馆'))
            .catch((error) => toastr.error(errorText(error), '联机酒馆'));
        windowEl.show();
        render();
    });

    container.append(panel);

    // ---------- 浮动控制中心 ----------
    const windowEl = $(`
        <div id="${WINDOW_ID}" style="display: none;">
            <div class="stmp-window-header">
                <span class="stmp-window-title">联机酒馆</span>
                <span class="stmp-window-conn"></span>
                <button class="stmp-window-close" title="收起">×</button>
            </div>
            <div class="stmp-window-body">
                <div class="stmp-view-lobby">
                    <div class="stmp-section">
                        <div class="stmp-section-title">加入房间</div>
                        <textarea class="stmp-invite-input text_pole" rows="2" placeholder="粘贴朋友发来的邀请码"></textarea>
                        <button class="stmp-join menu_button">凭邀请码入房</button>
                    </div>
                    <div class="stmp-section">
                        <div class="stmp-section-title">创建房间（房主）</div>
                        <input class="stmp-creator-key text_pole" type="password" placeholder="中继房主密钥（不会保存）">
                        <button class="stmp-create menu_button">建房</button>
                    </div>
                    <div class="stmp-lobby-note"></div>
                </div>
                <div class="stmp-view-room" style="display: none;">
                    <div class="stmp-section stmp-room-meta">
                        <div class="stmp-room-line"></div>
                        <div class="stmp-generating" style="display: none;">⚙️ 房主正在生成……</div>
                    </div>
                    <div class="stmp-section stmp-invite-section" style="display: none;">
                        <div class="stmp-section-title">邀请码</div>
                        <div class="stmp-row">
                            <input class="stmp-invite-out text_pole" type="text" readonly>
                            <button class="stmp-copy-invite menu_button">复制</button>
                        </div>
                    </div>
                    <div class="stmp-section stmp-card-section">
                        <div class="stmp-section-title">完整角色卡</div>
                        <div class="stmp-card-host" style="display: none;">
                            <label class="checkbox_label">
                                <input class="stmp-card-share-toggle" type="checkbox">
                                <span>向本房间共享当前完整角色卡</span>
                            </label>
                            <div class="stmp-card-status stmp-empty"></div>
                            <button class="stmp-card-refresh menu_button" style="display: none;">更新共享卡</button>
                        </div>
                        <div class="stmp-card-guest" style="display: none;">
                            <div class="stmp-card-status stmp-empty"></div>
                            <button class="stmp-card-import menu_button" style="display: none;">重新导入</button>
                        </div>
                    </div>
                    <div class="stmp-section stmp-save-section">
                        <div class="stmp-section-title">联机存档</div>
                        <div class="stmp-save-host" style="display: none;">
                            <div class="stmp-save-status stmp-empty"></div>
                            <button class="stmp-save-share menu_button">共享当前聊天存档</button>
                        </div>
                        <div class="stmp-save-guest" style="display: none;">
                            <div class="stmp-save-status stmp-empty"></div>
                            <button class="stmp-save-import menu_button" style="display: none;">重新导入存档</button>
                        </div>
                    </div>
                    <div class="stmp-section">
                        <div class="stmp-section-title">成员</div>
                        <div class="stmp-members"></div>
                    </div>
                    <div class="stmp-section">
                        <div class="stmp-section-title">提案</div>
                        <div class="stmp-proposals"></div>
                        <div class="stmp-proposal-editor">
                            <textarea class="stmp-proposal-text text_pole" rows="2" placeholder="写下你的行动提案……"></textarea>
                            <button class="stmp-proposal-submit menu_button">提交提案</button>
                        </div>
                    </div>
                    <div class="stmp-section">
                        <div class="stmp-section-title">副聊天</div>
                        <div class="stmp-sidechat"></div>
                        <div class="stmp-row">
                            <input class="stmp-sidechat-text text_pole" type="text" maxlength="2000" placeholder="聊两句（不进故事）……">
                            <button class="stmp-sidechat-send menu_button">发送</button>
                        </div>
                    </div>
                    <details class="stmp-section stmp-timeline-details">
                        <summary>时间线（调试视图）</summary>
                        <div class="stmp-timeline"></div>
                    </details>
                    <div class="stmp-row stmp-room-actions">
                        <button class="stmp-leave menu_button">离开房间</button>
                    </div>
                </div>
            </div>
        </div>
    `);
    $(document.body).append(windowEl);

    // 拖动（标题栏），大小由 CSS resize 承担。
    (() => {
        const header = windowEl.find('.stmp-window-header')[0];
        let dragging = null;
        header.addEventListener('pointerdown', (event) => {
            if (event.target.closest('button')) return;
            const rect = windowEl[0].getBoundingClientRect();
            dragging = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
            header.setPointerCapture(event.pointerId);
        });
        header.addEventListener('pointermove', (event) => {
            if (!dragging) return;
            windowEl.css({
                left: `${Math.max(0, event.clientX - dragging.dx)}px`,
                top: `${Math.max(0, event.clientY - dragging.dy)}px`,
                right: 'auto',
            });
        });
        header.addEventListener('pointerup', () => { dragging = null; });
        header.addEventListener('pointercancel', () => { dragging = null; });
    })();

    windowEl.find('.stmp-window-close').on('click', () => windowEl.hide());

    // ---------- 悬浮球 ----------
    const ballEl = $(`
        <div id="stmp-ball" data-state="idle" title="联机酒馆">
            <i class="fa-solid fa-circle-nodes"></i>
            <span class="stmp-ball-dot"></span>
        </div>
    `);
    $(document.body).append(ballEl);

    function clampBallPos(left, top) {
        const size = ballEl[0].offsetWidth || 44;
        return {
            left: Math.min(Math.max(0, left), window.innerWidth - size),
            top: Math.min(Math.max(0, top), window.innerHeight - size),
        };
    }

    function applyBallPos() {
        if (!settings.ballPos) return;
        const pos = clampBallPos(settings.ballPos.left, settings.ballPos.top);
        ballEl.css({ left: `${pos.left}px`, top: `${pos.top}px`, right: 'auto' });
    }

    applyBallPos();
    window.addEventListener('resize', applyBallPos);

    // 拖动换位；位移小于阈值视为点击，切换控制中心。
    (() => {
        const ball = ballEl[0];
        const DRAG_THRESHOLD_PX = 5;
        let drag = null;
        ball.addEventListener('pointerdown', (event) => {
            const rect = ball.getBoundingClientRect();
            drag = {
                dx: event.clientX - rect.left,
                dy: event.clientY - rect.top,
                startX: event.clientX,
                startY: event.clientY,
                moved: false,
            };
            ball.setPointerCapture(event.pointerId);
        });
        ball.addEventListener('pointermove', (event) => {
            if (!drag) return;
            if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
            drag.moved = true;
            const pos = clampBallPos(event.clientX - drag.dx, event.clientY - drag.dy);
            ballEl.css({ left: `${pos.left}px`, top: `${pos.top}px`, right: 'auto' });
        });
        ball.addEventListener('pointerup', () => {
            if (!drag) return;
            const wasDrag = drag.moved;
            drag = null;
            if (wasDrag) {
                const rect = ball.getBoundingClientRect();
                settings.ballPos = { left: rect.left, top: rect.top };
                saveSettings();
                return;
            }
            windowEl.toggle();
            if (windowEl.is(':visible')) render();
        });
        ball.addEventListener('pointercancel', () => { drag = null; });
    })();

    // ---------- 操作绑定 ----------
    function guarded(action) {
        return () => action().catch((error) => toastr.error(errorText(error), '联机酒馆'));
    }

    windowEl.find('.stmp-join').on('click', guarded(async () => {
        const code = String(windowEl.find('.stmp-invite-input').val()).trim();
        if (!code) throw new Error('请先粘贴邀请码。');
        await joinRoom(code);
        windowEl.find('.stmp-invite-input').val('');
    }));

    windowEl.find('.stmp-create').on('click', guarded(async () => {
        const key = String(windowEl.find('.stmp-creator-key').val()).trim();
        if (!key) throw new Error('请填写中继的房主密钥。');
        await createRoom(key);
    }));

    windowEl.find('.stmp-copy-invite').on('click', guarded(async () => {
        await navigator.clipboard.writeText(lastInviteCode);
        toastr.success('邀请码已复制。', '联机酒馆');
    }));

    windowEl.find('.stmp-proposal-submit').on('click', guarded(async () => {
        const text = String(windowEl.find('.stmp-proposal-text').val()).trim();
        if (!text) throw new Error('提案内容不能为空。');
        await relay.request(createCommand(CommandType.PROPOSAL_SUBMIT, { text }));
        windowEl.find('.stmp-proposal-text').val('');
    }));

    windowEl.find('.stmp-sidechat-send').on('click', guarded(async () => {
        const text = String(windowEl.find('.stmp-sidechat-text').val()).trim();
        if (!text) return;
        await relay.request(createCommand(CommandType.SIDECHAT_MESSAGE_POST, { text }));
        windowEl.find('.stmp-sidechat-text').val('');
    }));
    windowEl.find('.stmp-sidechat-text').on('keydown', (event) => {
        if (event.key === 'Enter') windowEl.find('.stmp-sidechat-send').trigger('click');
    });

    windowEl.find('.stmp-leave').on('click', guarded(async () => {
        const isHost = store.role === 'host';
        if (isHost && !window.confirm('你是房主，离开将关闭整个房间。确定吗？')) return;
        await leaveRoom();
    }));

    windowEl.find('.stmp-card-share-toggle').on('change', function () {
        const enabled = $(this).prop('checked');
        void (async () => {
            if (enabled) {
                const confirmed = window.confirm(
                    '完整角色卡包含角色设定，房间成员可以保存副本；外部挂载的世界书不会包含在内。确定共享当前角色卡吗？',
                );
                if (!confirmed) return;
                const shared = await shareCurrentCard();
                if (shared.unchanged) toastr.info('角色卡内容未变化。', '联机酒馆');
                else toastr.success(`已共享完整角色卡：${shared.characterName}`, '联机酒馆');
                return;
            }

            const assetId = store.snapshot.sharedCard?.assetId;
            if (assetId) await relay.request(createCommand(CommandType.ROOM_CARD_CLEAR, { assetId }));
            toastr.info('已停止共享完整角色卡。', '联机酒馆');
        })().catch((error) => toastr.error(errorText(error), '联机酒馆')).finally(render);
    });

    windowEl.find('.stmp-card-refresh').on('click', guarded(async () => {
        const shared = await shareCurrentCard();
        if (shared.unchanged) toastr.info('角色卡内容未变化，无需更新。', '联机酒馆');
        else toastr.success(`已更新共享角色卡：${shared.characterName}`, '联机酒馆');
    }));

    windowEl.find('.stmp-card-import').on('click', guarded(async () => {
        await importSharedCard(store.snapshot.sharedCard, true);
    }));

    windowEl.find('.stmp-save-share').on('click', guarded(async () => {
        if (!store.snapshot.sharedSave) {
            const confirmed = window.confirm(
                '联机存档是当前聊天的完整 jsonl（含全部消息、未采用的备选回复与聊天设置），房间成员将获得完整副本用于续局。确定共享吗？',
            );
            if (!confirmed) return;
        }
        const shared = await shareCurrentSave();
        if (shared.unchanged) toastr.info('存档内容未变化，无需更新。', '联机酒馆');
        else toastr.success(`已共享联机存档：${shared.chatName}（${shared.messageCount} 条消息）`, '联机酒馆');
    }));

    windowEl.find('.stmp-save-import').on('click', guarded(async () => {
        await importSharedSave(store.snapshot.sharedSave, true);
    }));

    // 提案/成员列表内的动态按钮走事件委托。
    windowEl.on('click', '.stmp-kick', guarded(async function () {
        const command = createKickCommand({
            targetClientId: this.getAttribute('data-client-id'),
            selfClientId: store.snapshot.room?.selfClientId,
        });
        const name = this.getAttribute('data-name') || '该成员';
        if (!window.confirm(`确定把 ${name} 移出房间吗？`)) return;
        await relay.request(command);
    }));
    windowEl.on('click', '.stmp-accept', guarded(async function () {
        await relay.request(createCommand(CommandType.PROPOSAL_ACCEPT, { proposalId: $(this).data('proposal-id') }));
    }));
    windowEl.on('click', '.stmp-reject', guarded(async function () {
        const reason = window.prompt('拒绝理由（可留空）：') ?? '';
        await relay.request(createCommand(CommandType.PROPOSAL_REJECT, {
            proposalId: $(this).data('proposal-id'),
            ...(reason.trim() ? { reason: reason.trim() } : {}),
        }));
    }));
    windowEl.on('click', '.stmp-withdraw', guarded(async function () {
        await relay.request(createCommand(CommandType.PROPOSAL_WITHDRAW, { proposalId: $(this).data('proposal-id') }));
    }));

    // ---------- 渲染 ----------
    function render() {
        const snapshot = store.snapshot;
        const connLabel = STATE_LABELS[relay.state] ?? relay.state;
        windowEl.find('.stmp-window-conn').text(connLabel);
        panel.find('#st-multiplayer-status').text(connLabel);
        ballEl.attr('data-state', relay.state);
        ballEl.attr('title', `联机酒馆 · ${connLabel}`);

        const inRoom = snapshot.room !== null;
        windowEl.find('.stmp-view-lobby').toggle(!inRoom);
        windowEl.find('.stmp-view-room').toggle(inRoom);

        if (!inRoom) {
            const note = snapshot.closedReason ? CLOSED_REASON_TEXT[snapshot.closedReason] ?? '' : '';
            windowEl.find('.stmp-lobby-note').text(note);
            return;
        }

        const isHost = snapshot.room.role === 'host';
        windowEl.find('.stmp-room-line').text(`房间 ${snapshot.room.roomId} · 你是${isHost ? '房主' : '客人'}`);
        windowEl.find('.stmp-generating').toggle(snapshot.generating);

        windowEl.find('.stmp-invite-section').toggle(isHost && Boolean(lastInviteCode));
        windowEl.find('.stmp-invite-out').val(lastInviteCode);

        const sharedCard = snapshot.sharedCard;
        windowEl.find('.stmp-card-host').toggle(isHost);
        windowEl.find('.stmp-card-guest').toggle(!isHost);
        windowEl.find('.stmp-card-share-toggle').prop('checked', Boolean(sharedCard));
        windowEl.find('.stmp-card-refresh').toggle(isHost && Boolean(sharedCard));
        if (isHost) {
            windowEl.find('.stmp-card-host .stmp-card-status').text(sharedCard
                ? `正在共享：${sharedCard.characterName}（${Math.ceil(sharedCard.bytes / 1024)} KB）`
                : '默认关闭；开启后，成员会自动导入本房间专用副本。');
        } else {
            const importing = sharedCard && importingCardAssetId === sharedCard.assetId;
            const imported = sharedCard && importedCardAssetId === sharedCard.assetId;
            windowEl.find('.stmp-card-guest .stmp-card-status').text(!sharedCard
                ? '房主尚未共享完整角色卡。'
                : importing
                    ? `正在导入：${sharedCard.characterName}……`
                    : imported
                        ? `已同步：${sharedCard.characterName}`
                        : `可同步：${sharedCard.characterName}`);
            windowEl.find('.stmp-card-import').toggle(Boolean(sharedCard) && !importing);
        }

        const sharedSave = snapshot.sharedSave;
        windowEl.find('.stmp-save-host').toggle(isHost);
        windowEl.find('.stmp-save-guest').toggle(!isHost);
        if (isHost) {
            windowEl.find('.stmp-save-host .stmp-save-status').text(sharedSave
                ? `已共享：${sharedSave.chatName}（${sharedSave.messageCount} 条消息，${Math.ceil(sharedSave.bytes / 1024)} KB）`
                : '把当前聊天（jsonl）作为这一局的存档共享给成员，玩一半也能改天续上。');
            windowEl.find('.stmp-save-share').text(sharedSave ? '更新联机存档' : '共享当前聊天存档');
        } else {
            const importingSave = sharedSave && importingSaveAssetId === sharedSave.assetId;
            const importedSave = sharedSave && importedSaveAssetId === sharedSave.assetId;
            const mirrorReady = Boolean(importedCardFileName && cardSharing.hasCharacter(importedCardFileName));
            windowEl.find('.stmp-save-guest .stmp-save-status').text(!sharedSave
                ? '房主尚未共享联机存档。'
                : importingSave
                    ? `正在导入存档：${sharedSave.chatName}……`
                    : importedSave
                        ? `已同步存档：${sharedSave.chatName}（${sharedSave.messageCount} 条消息${importedSaveFileName ? `，本地聊天「${importedSaveFileName}」` : ''}）`
                        : mirrorReady
                            ? `可同步存档：${sharedSave.chatName}`
                            : '等待角色卡同步完成后自动导入存档。');
            windowEl.find('.stmp-save-import').toggle(Boolean(sharedSave) && !importingSave);
        }

        const members = windowEl.find('.stmp-members').empty();
        for (const member of snapshot.members) {
            const row = $('<div class="stmp-member">');
            $('<span class="stmp-dot">').addClass(member.online ? 'stmp-online' : 'stmp-offline').appendTo(row);
            $('<span class="stmp-member-name">').text(member.displayName).appendTo(row);
            $('<span class="stmp-member-role">').text(member.role === 'host' ? '房主' : '客人').appendTo(row);
            if (isHost && member.clientId !== snapshot.room.selfClientId) {
                $('<button class="stmp-kick menu_button stmp-mini">踢出</button>')
                    .attr('data-client-id', member.clientId)
                    .attr('data-name', member.displayName)
                    .appendTo(row);
            }
            members.append(row);
        }

        const proposals = windowEl.find('.stmp-proposals').empty();
        const visibleProposals = snapshot.proposals.filter((p) => isHost
            ? p.status === 'pending'
            : (p.authorClientId === snapshot.room.selfClientId || p.status === 'pending'));
        if (!visibleProposals.length) proposals.append($('<div class="stmp-empty">').text(isHost ? '暂无待审提案。' : '暂无提案。'));
        for (const proposal of visibleProposals.slice(-20)) {
            const row = $('<div class="stmp-proposal">');
            const head = $('<div class="stmp-proposal-head">').appendTo(row);
            $('<span class="stmp-proposal-author">').text(proposal.authorDisplayName).appendTo(head);
            $('<span class="stmp-proposal-status">').text(PROPOSAL_STATUS_TEXT[proposal.status] ?? proposal.status).appendTo(head);
            $('<div class="stmp-proposal-text-view">').text(proposal.text).appendTo(row);
            if (proposal.status === 'rejected' && proposal.reason) {
                $('<div class="stmp-proposal-reason">').text(`理由：${proposal.reason}`).appendTo(row);
            }
            const actions = $('<div class="stmp-proposal-actions">').appendTo(row);
            if (isHost && proposal.status === 'pending') {
                $('<button class="stmp-accept menu_button stmp-mini">接受</button>').attr('data-proposal-id', proposal.proposalId).appendTo(actions);
                $('<button class="stmp-reject menu_button stmp-mini">拒绝</button>').attr('data-proposal-id', proposal.proposalId).appendTo(actions);
            }
            if (!isHost && proposal.status === 'pending' && proposal.authorClientId === snapshot.room.selfClientId) {
                $('<button class="stmp-withdraw menu_button stmp-mini">撤回</button>').attr('data-proposal-id', proposal.proposalId).appendTo(actions);
            }
            proposals.append(row);
        }
        windowEl.find('.stmp-proposal-editor').toggle(!isHost);

        const sidechat = windowEl.find('.stmp-sidechat').empty();
        for (const message of snapshot.sidechat.slice(-50)) {
            const row = $('<div class="stmp-chatline">');
            $('<span class="stmp-chat-author">').text(`${message.authorDisplayName}：`).appendTo(row);
            $('<span class="stmp-chat-text">').text(message.text).appendTo(row);
            sidechat.append(row);
        }
        sidechat.scrollTop(sidechat[0].scrollHeight);

        const timeline = windowEl.find('.stmp-timeline').empty();
        for (const message of snapshot.timeline.slice(-100)) {
            const row = $('<div class="stmp-chatline">');
            $('<span class="stmp-chat-author">').text(`[${message.role === 'assistant' ? 'AI' : '玩家'}·${message.authorName}] `).appendTo(row);
            $('<span class="stmp-chat-text">').text(message.text).appendTo(row);
            timeline.append(row);
        }
        timeline.scrollTop(timeline[0].scrollHeight);
    }

    // ---------- 事件接线 ----------
    relay.addEventListener('message', (event) => {
        if (event.detail?.kind === 'event') store.applyEvent(event.detail);
    });
    relay.addEventListener('resumed', (event) => {
        applyResume(event.detail.payload);
    });
    relay.addEventListener('resumeerror', (event) => {
        const error = event.detail;
        if (error?.code === 'NOT_IN_ROOM') {
            if (store.inRoom) store.reset('host_left');
        } else {
            console.warn('[ST Multiplayer] room.resume 失败：', error);
            toastr.warning('重连后同步房间失败，将继续重试。', '联机酒馆');
        }
    });
    relay.addEventListener('statechange', (event) => {
        if (event.detail !== 'connected') helloDone = false;
        render();
    });
    relay.addEventListener('error', () => render());

    // resumeProvider：重连成功后先补 hello，再让 relay-client 发 room.resume。
    relay.resumeProvider = async () => {
        const ack = await relay.request(createCommand(CommandType.AUTH_HELLO, helloPayload()));
        settings.credentials = { clientId: ack.payload.clientId, sessionToken: ack.payload.sessionToken };
        saveSettings();
        helloDone = true;
        if (!ack.payload.room) {
            if (store.inRoom) store.reset('host_left');
            return null;
        }
        return { lastAppliedSeq: store.lastAppliedSeq };
    };

    store.addEventListener('change', () => render());
    store.addEventListener('event', (event) => {
        if ([EventType.ROOM_CARD_UPDATED, EventType.ROOM_CARD_CLEARED].includes(event.detail.type)) scheduleSharedCardImport();
        if ([EventType.ROOM_CHAT_UPDATED, EventType.ROOM_CHAT_CLEARED].includes(event.detail.type)) scheduleSharedSaveImport();
    });
    store.addEventListener('desync', () => {
        console.warn('[ST Multiplayer] 事件序列出现缺口，触发 room.resume 兜底。');
        resumeRoom().catch((error) => console.error('[ST Multiplayer] resume 兜底失败：', error));
    });

    render();
}
