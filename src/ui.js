import { CommandType, EventType, createCommand, createInviteCode, parseInviteCode } from './protocol.js';
import { createKickCommand } from './kick-command.js';
import { getCurrentPersonaName, getMessagePersonaName } from './persona-name.js';
import { ResumeEventBarrier } from './resume-event-barrier.js';

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

export function mountMultiplayerPanel({ settings, store, relay, hostBridge, cardSharing, saveSharing, saveSettings, registerGenerateInterceptor }) {
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
    /** { generation, followUpRequested, promise }；旧生命周期的 ack 绝不能复用到新入房。 */
    let resumeInFlight = null;
    let roomLifecycleGeneration = 0;
    let automaticResumeGeneration = null;
    let observedInRoom = store.inRoom;
    let lastInviteCode = '';
    let importingCardAssetId = null;
    let importedCardAssetId = null;
    let importedCardFileName = null;
    let cardImportScheduled = false;
    let importingSaveAssetId = null;
    let importedSaveAssetId = null;
    let importedSaveFileName = null;
    let saveImportScheduled = false;
    /** 离房后仍可能完成旧房间的 HTTP 导入；用 epoch 阻止其覆盖新房间的镜像状态。 */
    let mirrorImportGeneration = 0;
    let syncingAll = false;
    let advertisedPersonaName = null;
    let personaSyncPromise = null;
    let helloPromise = null;

    function helloPayload(displayName = currentPersonaName()) {
        const payload = { displayName };
        if (settings.credentials?.clientId && settings.credentials?.sessionToken) {
            payload.clientId = settings.credentials.clientId;
            payload.sessionToken = settings.credentials.sessionToken;
        }
        return payload;
    }

    function acceptHello(ack, displayName) {
        settings.credentials = {
            clientId: ack.payload.clientId,
            sessionToken: ack.payload.sessionToken,
        };
        advertisedPersonaName = displayName;
        helloDone = true;
        saveSettings();
    }

    /** 身份握手：颁发/恢复凭据；若中继报告我们仍在房间里，则立即 resume 追平。 */
    async function hello({ resume = true } = {}) {
        if (helloPromise) return helloPromise;
        const pending = (async () => {
            const displayName = currentPersonaName();
            const ack = await relay.request(createCommand(CommandType.AUTH_HELLO, helloPayload(displayName)));
            acceptHello(ack, displayName);
            if (resume && ack.payload.room) await resumeRoom(ack.payload.room);
            else if (resume) resetMissingRemoteRoom(ack);
            return ack;
        })();
        helloPromise = pending;
        try {
            return await pending;
        } finally {
            if (helloPromise === pending) helloPromise = null;
        }
    }

    /** Persona 改变时复用 auth.hello 刷新 Relay 身份；相同名称不重复上报。 */
    async function syncPersonaIdentity() {
        if (relay.state !== 'connected') return currentPersonaName();
        if (!helloDone) await hello();
        if (personaSyncPromise) return personaSyncPromise;

        personaSyncPromise = (async () => {
            while (true) {
                const displayName = currentPersonaName();
                if (displayName === advertisedPersonaName) return displayName;
                const ack = await relay.request(createCommand(CommandType.AUTH_HELLO, helloPayload(displayName)));
                acceptHello(ack, displayName);
                resetMissingRemoteRoom(ack);
            }
        })();

        try {
            return await personaSyncPromise;
        } finally {
            personaSyncPromise = null;
        }
    }

    function refreshPersonaIdentity() {
        void syncPersonaIdentity().catch((error) => {
            console.warn('[ST Multiplayer] 同步当前 Persona 名称失败：', error);
        });
    }

    /** room.resume ack 中的权威快照；增量事件由 resumeBarrier 按 seq 合并。 */
    function applyResumeSnapshot(payload, roomHint = null) {
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
    }

    const resumeBarrier = new ResumeEventBarrier({ store, applySnapshot: applyResumeSnapshot });

    /**
     * A room leave/reset starts a new lifecycle.  WebSocket requests cannot be
     * cancelled, so stale room.resume acks are fenced by this monotonically
     * increasing generation instead of being allowed to seed a later join.
     */
    function invalidateRoomLifecycle() {
        roomLifecycleGeneration += 1;
        resumeBarrier.clear();
        return roomLifecycleGeneration;
    }

    function resetMissingRemoteRoom(ack) {
        if (ack?.payload?.room) return false;
        invalidateRoomLifecycle();
        if (!store.inRoom) return false;
        store.reset('host_left');
        return true;
    }

    /** 入房/建房/重连/缺口共用的恢复路径：ack 与即时事件会在 barrier 内连续合并。 */
    async function resumeRoom(roomHint = null) {
        const generation = roomLifecycleGeneration;
        resumeBarrier.begin();
        if (resumeInFlight?.generation === generation) {
            resumeInFlight.followUpRequested = true;
            return resumeInFlight.promise;
        }

        const flight = { generation, followUpRequested: false, promise: null };
        const staleResult = () => ({ needsFollowUp: false, closed: true, stale: true });
        const pending = (async () => {
            let hint = roomHint;
            while (true) {
                flight.followUpRequested = false;
                const ack = await relay.request(createCommand(CommandType.ROOM_RESUME, {
                    lastAppliedSeq: store.inRoom ? store.lastAppliedSeq : 0,
                }));
                // leave/reset/rejoin happened while the old request was on the
                // wire.  Never commit that old snapshot into the new lifecycle.
                if (generation !== roomLifecycleGeneration) return staleResult();
                const result = resumeBarrier.commit(ack.payload, hint);
                hint = null;
                // A terminal event can itself invalidate the lifecycle during
                // commit; retain its terminal result rather than treating it as
                // a transport-stale acknowledgement.
                if (result.closed) return result;
                if (generation !== roomLifecycleGeneration) return staleResult();
                if (!result.needsFollowUp && !flight.followUpRequested) return result;
            }
        })();
        flight.promise = pending;
        resumeInFlight = flight;

        try {
            return await pending;
        } catch (error) {
            if (generation !== roomLifecycleGeneration) return staleResult();
            if (error?.code === 'NOT_IN_ROOM') resetMissingRemoteRoom({ payload: { room: null } });
            throw error;
        } finally {
            if (resumeInFlight === flight) {
                resumeInFlight = null;
                if (generation === roomLifecycleGeneration && resumeBarrier.active) resumeBarrier.end();
            }
        }
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
        if (!helloDone) {
            // 覆盖手动重连时 auth.hello 与紧随其后的 room.resume 之间的事件窗口。
            resumeBarrier.begin();
            try {
                const ack = await hello();
                if (!ack.payload.room) {
                    resetMissingRemoteRoom(ack);
                    resumeBarrier.clear();
                }
            } catch (error) {
                resumeBarrier.clear();
                throw error;
            }
        }
    }
    let currentUrl = null;

    async function joinRoom(code) {
        const invite = parseInviteCode(code);
        settings.relayUrl = invite.relayUrl;
        saveSettings();
        await ensureSession(invite.relayUrl);
        if (store.inRoom) throw Object.assign(new Error('已在房间中。'), { code: 'ALREADY_IN_ROOM' });
        // 新邀请码入房是独立生命周期，不可借用离房前尚未返回的 room.resume。
        invalidateRoomLifecycle();
        // room.member.joined 可能在 join ack 前抵达，先打开恢复栅栏。
        resumeBarrier.begin();
        try {
            await relay.request(createCommand(CommandType.ROOM_JOIN, { roomId: invite.roomId, token: invite.token }));
            lastInviteCode = code.trim();
            await resumeRoom();
            toastr.success('已加入房间。', '联机酒馆');
        } catch (error) {
            resumeBarrier.clear();
            throw error;
        }
    }

    async function createRoom(creatorKey) {
        if (!settings.relayUrl) throw new Error('请先在扩展设置中填写 Relay 地址。');
        await ensureSession(settings.relayUrl);
        if (store.inRoom) throw Object.assign(new Error('已在房间中。'), { code: 'ALREADY_IN_ROOM' });
        invalidateRoomLifecycle();
        // room.member.joined 与 create ack 的顺序不承诺，必须同样缓冲。
        resumeBarrier.begin();
        try {
            const ack = await relay.request(createCommand(CommandType.ROOM_CREATE, { creatorKey }));
            lastInviteCode = createInviteCode({
                relayUrl: settings.relayUrl,
                roomId: ack.payload.roomId,
                token: ack.payload.inviteToken,
            });
            await resumeRoom();
            toastr.success('房间已创建，邀请码已生成。', '联机酒馆');
        } catch (error) {
            resumeBarrier.clear();
            throw error;
        }
    }

    async function leaveRoom() {
        invalidateRoomLifecycle();
        resetGuestMirrorLifecycle();
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

    /**
     * Imported asset IDs are room-session state, unlike the persistent
     * content-hash/file-name caches in settings.  Clearing them makes a
     * leave→rejoin re-evaluate the current room snapshot; the epoch prevents
     * an old room's slow HTTP import from restoring stale IDs afterwards.
     */
    function resetGuestMirrorLifecycle() {
        mirrorImportGeneration += 1;
        importingCardAssetId = null;
        importedCardAssetId = null;
        importedCardFileName = null;
        cardImportScheduled = false;
        importingSaveAssetId = null;
        importedSaveAssetId = null;
        importedSaveFileName = null;
        saveImportScheduled = false;
    }

    function isCurrentGuestMirrorGeneration(generation, roomId) {
        return generation === mirrorImportGeneration
            && store.inRoom
            && store.role === 'guest'
            && store.snapshot.room?.roomId === roomId;
    }

    function isCurrentGuestMirrorImport(generation, roomId, assetId, kind) {
        if (!isCurrentGuestMirrorGeneration(generation, roomId)) return false;
        const snapshot = store.snapshot;
        return kind === 'card'
            ? snapshot.sharedCard?.assetId === assetId
            : snapshot.sharedSave?.assetId === assetId;
    }

    async function importSharedCard(card, force = false) {
        if (!card || store.role !== 'guest') return;
        if (!force && importedCardAssetId === card.assetId) return;
        if (importingCardAssetId) return;

        const generation = mirrorImportGeneration;
        const roomId = store.snapshot.room?.roomId;
        if (!roomId) return;
        const shouldContinue = () => isCurrentGuestMirrorImport(generation, roomId, card.assetId, 'card');
        importingCardAssetId = card.assetId;
        render();
        try {
            const known = findImportedCardRecord(card);

            // 内容未变且本地副本还在：不下载不导入，直接复用。
            if (!force && known && card.contentHash && known.contentHash === card.contentHash && cardSharing.hasCharacter(known.fileName)) {
                await cardSharing.selectByAvatar(known.fileName, shouldContinue);
                if (!shouldContinue()) return;
                importedCardAssetId = card.assetId;
                importedCardFileName = known.fileName;
                rememberImportedCard(card, known.fileName);
                maybeBindGuestMirror();
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
                roomId,
                assetId: card.assetId,
                credentials: settings.credentials,
                preservedName,
                shouldContinue,
            });
            if (!shouldContinue()) return;
            importedCardAssetId = card.assetId;
            importedCardFileName = result.avatarFileName;
            rememberImportedCard(card, result.avatarFileName);
            maybeBindGuestMirror();
            toastr.success(`已同步完整角色卡：${card.characterName}`, '联机酒馆');
        } catch (error) {
            if (!shouldContinue()) return;
            throw error;
        } finally {
            if (isCurrentGuestMirrorGeneration(generation, roomId)) {
                if (importingCardAssetId === card.assetId) importingCardAssetId = null;
                render();
                const latest = store.snapshot.sharedCard;
                if (latest && latest.assetId !== card.assetId) scheduleSharedCardImport();
                else scheduleSharedSaveImport(); // 联机存档可能在等镜像角色就位
            }
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

        const generation = mirrorImportGeneration;
        const roomId = store.snapshot.room?.roomId;
        if (!roomId) return;
        const shouldContinue = () => isCurrentGuestMirrorImport(generation, roomId, save.assetId, 'save');

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
            maybeBindGuestMirror();
            render();
            return;
        }

        importingSaveAssetId = save.assetId;
        render();
        try {
            const fileName = record?.fileName ?? `联机存档-${sanitizeToken(save.saveKey ?? save.assetId).slice(0, 8)}`;
            const result = await saveSharing.importSharedSave({
                relayUrl: settings.relayUrl,
                roomId,
                assetId: save.assetId,
                credentials: settings.credentials,
                targetAvatar,
                fileName,
                shouldContinue,
            });
            if (!shouldContinue()) return;
            importedSaveAssetId = save.assetId;
            importedSaveFileName = result.fileName;
            if (save.saveKey) {
                settings.importedSaves[save.saveKey] = { contentHash: save.contentHash ?? null, fileName: result.fileName };
                saveSettings();
            }
            toastr.success(`已同步联机存档：${save.chatName}（${save.messageCount} 条消息）`, '联机酒馆');
        } catch (error) {
            if (!shouldContinue()) return;
            throw error;
        } finally {
            if (isCurrentGuestMirrorGeneration(generation, roomId)) {
                if (importingSaveAssetId === save.assetId) importingSaveAssetId = null;
                maybeBindGuestMirror();
                render();
                const latest = store.snapshot.sharedSave;
                if (latest && latest.assetId !== save.assetId) scheduleSharedSaveImport();
            }
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

    /**
     * 房主本地是否有生成在跑。streamingProcessor 只覆盖流式；
     * #mes_stop（生成期间可见的停止按钮）兜底非流式。
     */
    function hostIsGenerating() {
        const context = globalThis.SillyTavern?.getContext?.();
        if (context?.streamingProcessor && !context.streamingProcessor.isFinished) return true;
        return $('#mes_stop').is(':visible');
    }

    /** 一键同步：绑定当前聊天为写入目标，随后原子快照当前卡 + 当前聊天发布。 */
    async function syncAllToRoom() {
        if (syncingAll) return null;
        if (hostIsGenerating()) throw new Error('AI 正在生成，等这条回复完成后再同步。');
        syncingAll = true;
        render();
        try {
            const binding = hostBridge.bindCurrentChat();
            const card = await shareCurrentCard();
            const save = await shareCurrentSave();
            return { binding, card, save };
        } finally {
            syncingAll = false;
            render();
        }
    }

    /** 房主收束回合：补写遗漏的成员发言，然后触发一次原生生成（同步由生成观察钩子接管）。 */
    let hostGenRunning = false;
    async function hostGenerate() {
        if (store.role !== 'host') throw new Error('只有房主可以触发生成。');
        if (!hostBridge.isBound()) throw new Error('请先点"一键同步"绑定当前聊天。');
        if (!hostBridge.isBoundChatOpen()) throw new Error('绑定的聊天未打开，请切回后重试。');
        if (hostGenRunning || hostIsGenerating()) throw new Error('AI 正在生成中。');

        hostGenRunning = true;
        try {
            hostBridge.catchUp(store.snapshot.timeline);
            await stContext().generate();
        } finally {
            hostGenRunning = false;
        }
    }

    // ---------- 原生聊天同步（P3）：输入走酒馆输入框，故事渲染进真实聊天 ----------

    function stContext() {
        return globalThis.SillyTavern?.getContext?.();
    }

    function currentPersonaName() {
        return getCurrentPersonaName(stContext);
    }

    /** 客机镜像是否就绪：卡与存档已导入，且镜像聊天正在前台打开。 */
    function guestMirrorReady() {
        return store.role === 'guest' && Boolean(importedSaveFileName) && hostBridge.isBoundChatOpen();
    }

    /** 原生同步是否就绪（写入/捕获的统一前置条件）。 */
    function nativeSyncEligible() {
        if (!store.inRoom) return false;
        return store.role === 'host' ? hostBridge.isBoundChatOpen() : guestMirrorReady();
    }

    /** 客机切到镜像聊天时自动绑定并补写落下的故事。 */
    function maybeBindGuestMirror() {
        if (store.role !== 'guest' || !importedCardFileName || !importedSaveFileName) return;
        if (hostBridge.isBoundChatOpen()) return;
        const context = stContext();
        const character = context?.characters?.[context.characterId];
        if (character?.avatar !== importedCardFileName || context.chatId !== importedSaveFileName) return;
        try {
            hostBridge.bindCurrentChat();
            hostBridge.catchUp(store.snapshot.timeline, { includeAssistant: true });
            pruneDeletedMessages();
            hostBridge.pruneStaleStreamBubbles();
            refreshSyncedIdsBaseline();
            render();
        } catch (error) {
            console.warn('[ST Multiplayer] 绑定镜像聊天失败：', error);
        }
    }

    /** 原生输入框发出的消息 → 发布到房间；ack 后打同步标记（回声事件亦会补标）。 */
    async function onNativeMessageSent(index) {
        if (relay.state !== 'connected' || !nativeSyncEligible()) return;
        const message = stContext()?.chat?.[index];
        if (!message?.is_user || message.is_system) return;
        if (message.extra?.stmpMessageId) return; // 本插件写入的消息，勿回传
        const text = String(message.mes ?? '').trim();
        if (!text) return;
        const authorName = getMessagePersonaName(message, stContext);
        try {
            await syncPersonaIdentity();
            const ack = await relay.request(createCommand(CommandType.STORY_MESSAGE_PUBLISH, {
                text: text.slice(0, 8000),
                authorName,
                role: 'user',
            }));
            message.extra = { ...message.extra, stmpMessageId: message.extra?.stmpMessageId ?? ack.payload.messageId };
        } catch (error) {
            toastr.error(`这条发言没有同步到房间（${errorText(error)}），其他成员看不到。`, '联机酒馆');
        }
    }

    // ---------- 编辑/删除全同步（共享文档模型，2026-07-12）----------

    /** 删除检测的影子基线：绑定聊天里已同步消息的 ID 集合。 */
    let syncedIdsBaseline = new Set();
    let swipePendingIndex = null;

    function refreshSyncedIdsBaseline() {
        if (!nativeSyncEligible()) return;
        syncedIdsBaseline = new Set(hostBridge.listSyncedIds());
    }

    /** 本地文本变化（编辑/swipe/删备选）→ 发布共享文档更新。未同步过或与文档一致时 no-op。 */
    async function publishLocalTextChange(index) {
        if (!nativeSyncEligible()) return;
        const message = stContext()?.chat?.[index];
        const messageId = message?.extra?.stmpMessageId;
        if (!messageId) return;
        const text = String(message.mes ?? '');
        if (!text.trim()) return;
        const known = store.snapshot.timeline.find((m) => m.messageId === messageId);
        if (known && known.text === text) return; // 与共享文档一致
        try {
            await relay.request(createCommand(CommandType.STORY_MESSAGE_UPDATE, { messageId, text: text.slice(0, 8000) }));
        } catch (error) {
            toastr.error(`修改未同步到房间（${errorText(error)}）。`, '联机酒馆');
        }
    }

    /** MESSAGE_DELETED 只报删后长度不报删了谁——用影子基线 diff 找出被删的已同步消息。 */
    function onMessageDeletedLocally() {
        if (!nativeSyncEligible()) return;
        const current = new Set(hostBridge.listSyncedIds());
        for (const messageId of syncedIdsBaseline) {
            if (current.has(messageId)) continue;
            void relay.request(createCommand(CommandType.STORY_MESSAGE_DELETE, { messageId }))
                .catch((error) => toastr.error(`删除未同步到房间（${errorText(error)}）。`, '联机酒馆'));
        }
        syncedIdsBaseline = current;
    }

    /** 离线期间错过的删除：本地仍带标记、但已被本房间删除过的消息，切回时清理。 */
    function pruneDeletedMessages() {
        if (!nativeSyncEligible()) return;
        const deleted = store.snapshot.deletedIds ?? {};
        for (const messageId of hostBridge.listSyncedIds()) {
            if (deleted[messageId]) hostBridge.applyRemoteDelete({ messageId });
        }
    }

    // 房主端生成观察：原生触发的生成（含输入框发送后的自动生成）也全程转发。
    let genWatch = null;
    let lastStreamSent = 0;

    function onGenerationStarted(type, _params, dryRun) {
        // 只转发普通生成；swipe/regenerate/continue 是对已有消息的修改，
        // 直接转发会在时间线上追加重复内容——那些走"一键同步"重同步。
        if (dryRun || (type !== undefined && type !== 'normal')) return;
        if (store.role !== 'host' || !store.inRoom || !hostBridge.isBoundChatOpen()) return;
        genWatch = { baseline: stContext().chat.length };
        lastStreamSent = 0;
        void relay.request(createCommand(CommandType.GENERATION_START)).catch(() => { /* 状态广播尽力而为 */ });
    }

    function onStreamToken(text) {
        if (!genWatch || typeof text !== 'string' || !text) return;
        const now = Date.now();
        if (now - lastStreamSent < 300) return;
        lastStreamSent = now;
        void relay.request(createCommand(CommandType.GENERATION_PROGRESS, {
            text: text.slice(0, 16000),
            charCount: text.length,
        })).catch(() => { /* 流式预览丢帧无所谓 */ });
    }

    async function onGenerationEnded() {
        // swipe 触发的重生成结束后，把被 swipe 消息的新文本补发为文档更新。
        if (swipePendingIndex !== null) {
            const pendingIndex = swipePendingIndex;
            swipePendingIndex = null;
            void publishLocalTextChange(pendingIndex);
        }
        if (!genWatch) return;
        const { baseline } = genWatch;
        genWatch = null;
        let ok = false;
        try {
            const reply = await hostBridge.captureReplySince(baseline);
            if (reply) {
                if (reply.text.length > 8000) toastr.warning('AI 回复超过 8000 字，共享给成员的版本已截断（房主本地完整）。', '联机酒馆');
                const pubAck = await relay.request(createCommand(CommandType.STORY_MESSAGE_PUBLISH, {
                    text: reply.text.slice(0, 8000),
                    authorName: reply.name || '角色',
                    role: 'assistant',
                }));
                // 给房主本地的 AI 消息打同步标记——之后对它的编辑/删除/swipe 才能同步。
                if (reply.message && !reply.message.extra?.stmpMessageId) {
                    reply.message.extra = { ...reply.message.extra, stmpMessageId: pubAck.payload.messageId };
                }
                ok = true;
            }
        } catch (error) {
            toastr.error(`AI 回复未能同步到房间：${errorText(error)}`, '联机酒馆');
        } finally {
            void relay.request(createCommand(CommandType.GENERATION_FINISH, { ok })).catch(() => { /* 尽力而为 */ });
        }
    }

    /** relay 故事事件 → 写入本地聊天（房主写真实聊天，客机写镜像聊天）。 */
    function applyStoryEventToChat(message) {
        if (!message) return;
        const isSelf = message.authorClientId === store.selfClientId;
        if (store.role === 'host') {
            if (!hostBridge.isBound()) return;
            if (message.role !== 'user') return; // AI 回复本来就在房主聊天里
            if (isSelf) {
                hostBridge.tagLocalMessage({ messageId: message.messageId, text: message.text });
                return;
            }
            hostBridge.writeStoryMessage({ messageId: message.messageId, authorName: message.authorName, text: message.text, role: 'user' });
            return;
        }
        if (!guestMirrorReady()) return; // 切回镜像聊天时由 catchUp 补写
        if (message.role === 'user') {
            if (isSelf) {
                hostBridge.tagLocalMessage({ messageId: message.messageId, text: message.text });
                return;
            }
            hostBridge.writeStoryMessage({ messageId: message.messageId, authorName: message.authorName, text: message.text, role: 'user' });
            return;
        }
        // assistant：生成期间有流式气泡则原地定稿，否则直接写入。
        if (hostBridge.hasStreamBubble()) {
            hostBridge.endStreamBubble({ text: message.text, messageId: message.messageId, name: message.authorName });
        } else {
            hostBridge.writeStoryMessage({ messageId: message.messageId, authorName: message.authorName, text: message.text, role: 'assistant' });
        }
    }

    // 酒馆事件接线（eventSource 是单例，挂载时注册一次）。
    (() => {
        const context = stContext();
        const es = context?.eventSource;
        const et = context?.eventTypes;
        if (!es || !et) {
            console.warn('[ST Multiplayer] eventSource 不可用，原生聊天同步未启用。');
            return;
        }
        es.on(et.MESSAGE_SENT, (index) => void onNativeMessageSent(index));
        es.on(et.MESSAGE_EDITED, (index) => void publishLocalTextChange(Number(index)));
        es.on(et.MESSAGE_SWIPED, (index) => {
            swipePendingIndex = Number(index);
            void publishLocalTextChange(Number(index));
        });
        if (et.MESSAGE_SWIPE_DELETED) {
            es.on(et.MESSAGE_SWIPE_DELETED, (payload) => void publishLocalTextChange(Number(payload?.messageId)));
        }
        es.on(et.MESSAGE_DELETED, () => onMessageDeletedLocally());
        es.on(et.GENERATION_STARTED, (type, params, dryRun) => onGenerationStarted(type, params, dryRun));
        es.on(et.STREAM_TOKEN_RECEIVED, (text) => onStreamToken(text));
        es.on(et.GENERATION_ENDED, () => void onGenerationEnded());
        es.on(et.CHAT_CHANGED, () => {
            maybeBindGuestMirror();
            // 切回绑定聊天时补写离开期间落下的故事、修复文本、清理已删消息与残留气泡（全部幂等）。
            if (store.role === 'host' && hostBridge.isBoundChatOpen()) hostBridge.catchUp(store.snapshot.timeline);
            if (guestMirrorReady()) hostBridge.catchUp(store.snapshot.timeline, { includeAssistant: true });
            pruneDeletedMessages();
            hostBridge.pruneStaleStreamBubbles();
            refreshSyncedIdsBaseline();
            refreshPersonaIdentity();
            render();
        });
        if (et.SETTINGS_UPDATED) es.on(et.SETTINGS_UPDATED, refreshPersonaIdentity);
    })();

    // 生成拦截器：客机在镜像角色上时中止本地生成（消息照发，AI 由房主生成）。
    registerGenerateInterceptor?.((chat, contextSize, abort) => {
        if (store.role !== 'guest' || !store.inRoom || !importedCardFileName) return;
        const context = stContext();
        const character = context?.characters?.[context.characterId];
        if (character?.avatar === importedCardFileName) abort(true);
    });

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
    panel.find('#st-multiplayer-reconnect').prop('checked', settings.reconnect);

    panel.find('#st-multiplayer-relay-url').on('input', function () {
        settings.relayUrl = String($(this).val()).trim();
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
                    <div class="stmp-section stmp-sync-section" style="display: none;">
                        <button class="stmp-sync-all menu_button">一键同步（角色卡 + 存档）</button>
                        <div class="stmp-sync-note stmp-empty">把当前打开的卡和聊天进度同步给全体成员，开局前点一次即可。</div>
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
                        <div class="stmp-section-title">回合</div>
                        <div class="stmp-native-hint stmp-empty"></div>
                        <div class="stmp-row stmp-round-row">
                            <button class="stmp-round-ready menu_button stmp-mini">我说完了</button>
                            <button class="stmp-round-skip menu_button stmp-mini">跳过本回合</button>
                            <button class="stmp-generate menu_button stmp-mini" style="display: none;">🤖 让 AI 回复</button>
                            <span class="stmp-round-count"></span>
                        </div>
                    </div>
                    <div class="stmp-section">
                        <div class="stmp-section-title">副聊天（不进故事）</div>
                        <div class="stmp-sidechat"></div>
                        <div class="stmp-row">
                            <input class="stmp-sidechat-text text_pole" type="text" maxlength="2000" placeholder="聊两句（不进故事）……">
                            <button class="stmp-sidechat-send menu_button">发送</button>
                        </div>
                    </div>
                    <details class="stmp-section stmp-timeline-details">
                        <summary>时间线（调试）</summary>
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

    windowEl.find('.stmp-generate').on('click', guarded(async () => {
        if (store.role === 'host') {
            await hostGenerate();
            return;
        }
        await syncPersonaIdentity();
        await relay.request(createCommand(CommandType.GENERATION_REQUEST));
        toastr.info('已请求推进剧情，等待房主端执行。', '联机酒馆');
    }));

    // 就绪/跳过是给房主看的信息信号；再点一次取消。
    windowEl.find('.stmp-round-ready').on('click', guarded(async () => {
        const mine = store.snapshot.ready[store.selfClientId];
        await relay.request(createCommand(CommandType.ROUND_READY, { state: mine === 'ready' ? 'clear' : 'ready' }));
    }));
    windowEl.find('.stmp-round-skip').on('click', guarded(async () => {
        const mine = store.snapshot.ready[store.selfClientId];
        await relay.request(createCommand(CommandType.ROUND_READY, { state: mine === 'skip' ? 'clear' : 'skip' }));
    }));

    windowEl.find('.stmp-sidechat-send').on('click', guarded(async () => {
        const text = String(windowEl.find('.stmp-sidechat-text').val()).trim();
        if (!text) return;
        await syncPersonaIdentity();
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

    windowEl.find('.stmp-sync-all').on('click', guarded(async () => {
        if (!store.snapshot.sharedCard && !store.snapshot.sharedSave) {
            const confirmed = window.confirm(
                '一键同步会把当前角色卡和当前聊天的完整存档共享给房间成员，成员端会自动切换过去。确定吗？',
            );
            if (!confirmed) return;
        }
        const result = await syncAllToRoom();
        if (!result) return;
        const cardMsg = result.card.unchanged ? '角色卡未变化' : `角色卡已共享：${result.card.characterName}`;
        const saveMsg = result.save.unchanged ? '存档未变化' : `存档已共享（${result.save.messageCount} 条消息）`;
        toastr.success(`${cardMsg}；${saveMsg}。`, '联机酒馆');
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

    // 成员列表内的动态按钮走事件委托。
    windowEl.on('click', '.stmp-kick', guarded(async function () {
        const command = createKickCommand({
            targetClientId: this.getAttribute('data-client-id'),
            selfClientId: store.snapshot.room?.selfClientId,
        });
        const name = this.getAttribute('data-name') || '该成员';
        if (!window.confirm(`确定把 ${name} 移出房间吗？`)) return;
        await relay.request(command);
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

        windowEl.find('.stmp-sync-section').toggle(isHost);
        windowEl.find('.stmp-sync-all').prop('disabled', syncingAll).text(syncingAll ? '正在同步……' : '一键同步（角色卡 + 存档）');
        if (isHost) {
            const binding = hostBridge.binding;
            windowEl.find('.stmp-sync-note').text(!binding
                ? '把当前打开的卡和聊天进度同步给全体成员，同时绑定为联机写入目标。'
                : hostBridge.isBoundChatOpen()
                    ? `已绑定聊天：${binding.characterName} / ${binding.chatId}`
                    : `⚠ 绑定的聊天（${binding.characterName} / ${binding.chatId}）未打开——成员发言暂缓写入，切回或生成前会自动补写。`);
        }

        windowEl.find('.stmp-generate')
            .show()
            .prop('disabled', snapshot.generating)
            .text(isHost ? '🤖 让 AI 回复' : '🤖 请求 AI 回复');
        refreshSyncedIdsBaseline();
        if (isHost) {
            windowEl.find('.stmp-native-hint').text(hostBridge.isBound()
                ? '直接在酒馆输入框发言：发送会收束本回合并触发 AI 回复；只想让 AI 接管就点"🤖 让 AI 回复"。'
                : '先点"一键同步"绑定聊天，然后直接用酒馆输入框游玩。');
        } else {
            windowEl.find('.stmp-native-hint').text(guestMirrorReady()
                ? '镜像聊天已连接：直接在酒馆输入框发言；AI 回复由房主生成并实时同步过来。'
                : importedSaveFileName
                    ? `切到镜像聊天「${importedSaveFileName}」即可用酒馆输入框游玩。`
                    : '等待房主"一键同步"（角色卡 + 存档）后即可在原生界面游玩。');
        }

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

        // 回合就绪状态：计数给房主定夺，按钮高亮自己的状态。
        const readyMap = snapshot.ready ?? {};
        const acted = snapshot.members.filter((member) => readyMap[member.clientId]).length;
        windowEl.find('.stmp-round-count').text(`本回合已就绪 ${acted}/${snapshot.members.length}`);
        const myRoundState = readyMap[snapshot.room.selfClientId];
        windowEl.find('.stmp-round-ready')
            .toggleClass('stmp-active', myRoundState === 'ready')
            .text(myRoundState === 'ready' ? '✓ 我说完了' : '我说完了');
        windowEl.find('.stmp-round-skip')
            .toggleClass('stmp-active', myRoundState === 'skip')
            .text(myRoundState === 'skip' ? '✓ 跳过本回合' : '跳过本回合');

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
        // 流式气泡：生成期间实时刷新的 AI 全文快照，权威消息落地后由上面的循环替代。
        if (snapshot.generating) {
            const row = $('<div class="stmp-chatline stmp-streamline">');
            $('<span class="stmp-chat-author">').text('[AI·生成中] ').appendTo(row);
            $('<span class="stmp-chat-text">').text(snapshot.generatingText || '……').appendTo(row);
            timeline.append(row);
        }
        timeline.scrollTop(timeline[0].scrollHeight);
    }

    // ---------- 事件接线 ----------
    relay.addEventListener('message', (event) => {
        if (event.detail?.kind === 'event') resumeBarrier.route(event.detail);
    });
    relay.addEventListener('resumed', (event) => {
        const generation = automaticResumeGeneration;
        automaticResumeGeneration = null;
        if (generation === null || generation !== roomLifecycleGeneration) return;
        const result = resumeBarrier.commit(event.detail.payload);
        if (result.closed) return;
        if (result.needsFollowUp) {
            resumeRoom().catch((error) => console.error('[ST Multiplayer] room.resume 补拉失败：', error));
        } else {
            resumeBarrier.end();
        }
    });
    relay.addEventListener('resumeerror', (event) => {
        const generation = automaticResumeGeneration;
        automaticResumeGeneration = null;
        if (generation === null || generation !== roomLifecycleGeneration) return;
        const error = event.detail;
        if (error?.code === 'NOT_IN_ROOM') {
            resetMissingRemoteRoom({ payload: { room: null } });
        } else {
            resumeBarrier.clear();
            console.warn('[ST Multiplayer] room.resume 失败：', error);
            toastr.warning('重连后同步房间失败，将继续重试。', '联机酒馆');
        }
    });
    relay.addEventListener('statechange', (event) => {
        if (event.detail !== 'connected') {
            helloDone = false;
            advertisedPersonaName = null;
        }
        render();
    });
    relay.addEventListener('error', () => render());

    // resumeProvider：重连成功后先补 hello，再让 relay-client 发 room.resume。
    relay.resumeProvider = async () => {
        const generation = roomLifecycleGeneration;
        automaticResumeGeneration = generation;
        resumeBarrier.begin();
        const ack = await hello({ resume: false });
        if (generation !== roomLifecycleGeneration) return null;
        if (!ack.payload.room) {
            resetMissingRemoteRoom(ack);
            return null;
        }
        return { lastAppliedSeq: store.lastAppliedSeq };
    };

    store.addEventListener('change', () => {
        // 离房/关房后绑定失效，避免下一局误写上一局的聊天。
        if (!store.inRoom) {
            if (observedInRoom) invalidateRoomLifecycle();
            resetGuestMirrorLifecycle();
            if (hostBridge.isBound()) hostBridge.unbind();
        }
        observedInRoom = store.inRoom;
        render();
    });
    store.addEventListener('event', (event) => {
        const { type, payload } = event.detail;
        if ([EventType.ROOM_CARD_UPDATED, EventType.ROOM_CARD_CLEARED].includes(type)) scheduleSharedCardImport();
        if ([EventType.ROOM_CHAT_UPDATED, EventType.ROOM_CHAT_CLEARED].includes(type)) scheduleSharedSaveImport();

        if (type === EventType.STORY_MESSAGE_PUBLISHED) applyStoryEventToChat(payload?.message);

        // 共享文档编辑：远端的修改/删除落到本地聊天（自己发出的回声因文本一致而 no-op）。
        if (type === EventType.STORY_MESSAGE_UPDATED && nativeSyncEligible()) {
            hostBridge.applyRemoteUpdate({ messageId: payload.messageId, text: payload.text });
        }
        if (type === EventType.STORY_MESSAGE_DELETED && nativeSyncEligible()) {
            hostBridge.applyRemoteDelete({ messageId: payload.messageId });
        }

        // 生成请求（方案 a）：房主端代为执行。
        if (type === EventType.GENERATION_REQUESTED && store.role === 'host' && payload?.clientId !== store.selfClientId) {
            const who = payload?.displayName ?? '成员';
            hostGenerate().then(
                () => toastr.info(`${who} 请求推进剧情，已触发生成。`, '联机酒馆'),
                (error) => toastr.warning(`${who} 请求生成，但无法执行：${errorText(error)}`, '联机酒馆'),
            );
        }

        // 客机：把房主的流式生成实时映射成镜像聊天里的气泡。
        if (store.role === 'guest') {
            if (type === EventType.GENERATION_STARTED && guestMirrorReady()) {
                hostBridge.beginStreamBubble(store.snapshot.sharedCard?.characterName || hostBridge.binding?.characterName || '角色');
            }
            if (type === EventType.GENERATION_PROGRESSED && typeof payload?.text === 'string') {
                hostBridge.updateStreamBubble(payload.text);
            }
            if (type === EventType.GENERATION_FINISHED) {
                // 正常情况下权威 assistant 消息先到、气泡已定稿（此处 no-op）；气泡还在
                // 说明生成失败/中止。气泡不在当前聊天（生成期间切走了）时也必须复位
                // 气泡 ID，否则落盘残影会被当成活动气泡而躲过重绑时的清理。
                hostBridge.endStreamBubble(null);
            }
        }
    });
    store.addEventListener('desync', () => {
        console.warn('[ST Multiplayer] 事件序列出现缺口，触发 room.resume 兜底。');
        resumeRoom().catch((error) => console.error('[ST Multiplayer] resume 兜底失败：', error));
    });

    render();
}
