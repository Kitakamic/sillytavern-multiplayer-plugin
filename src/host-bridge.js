/**
 * 房主桥接与原生聊天写入（P2/P3 共用，最脆弱层）：把共享时间线写进本地
 * 打开的聊天（房主 = 真实聊天，客机 = 镜像聊天）、给自己的原生发言打同步
 * 标记、维护客机侧的流式气泡。铁律：只通过 SillyTavern.getContext() 访问
 * 酒馆能力，不 import 酒馆内部模块路径。
 *
 * 一致性模型：
 * - relay 事件按 seq 到达，故事消息由本模块写入本地聊天；
 * - 每条同步过的消息在 extra.stmpMessageId 打标——重放/重连/补写天然幂等，
 *   自己经原生输入框发出的消息由回声事件补标，不会二次写入。
 */

const REQUIRED_APIS = [
    'chat',
    'chatId',
    'characters',
    'saveChat',
    'addOneMessage',
    'eventSource',
    'eventTypes',
    'generate',
    'getRequestHeaders',
];

const REPLY_SETTLE_TIMEOUT_MS = 3000;

export function createHostBridge(contextProvider) {
    const getContext = () => (typeof contextProvider === 'function' ? contextProvider() : contextProvider);

    let binding = null; // { chatId, characterAvatar, characterName }
    let streamBubbleId = null; // 流式气泡消息的 extra 标记（客机侧）

    function missingApis() {
        const context = getContext();
        if (!context) return ['getContext'];
        // 用属性存在性判断，不看值：chatId 等值型成员在没打开聊天时
        // 合法地是 undefined，但键仍在 context 上——那不是 API 缺失。
        return REQUIRED_APIS.filter((name) => !(name in context));
    }

    function isBound() {
        return binding !== null;
    }

    /** 绑定聊天是否正在前台打开（写入与生成的前置条件）。 */
    function isBoundChatOpen() {
        if (!binding) return false;
        const context = getContext();
        const character = context.characters?.[context.characterId];
        return context.chatId === binding.chatId && character?.avatar === binding.characterAvatar;
    }

    /** 锁定当前打开的聊天为本房间的写入目标。切聊天不静默跟随。 */
    function bindCurrentChat() {
        const context = getContext();
        if (context.groupId) throw new Error('群组聊天暂不支持联机绑定。');
        const character = context.characters?.[context.characterId];
        if (!character?.avatar) throw new Error('请先打开要联机的角色聊天。');
        if (typeof context.chatId !== 'string' || !context.chatId) throw new Error('当前没有打开的聊天。');
        binding = {
            chatId: context.chatId,
            characterAvatar: character.avatar,
            characterName: character.name,
        };
        return { ...binding };
    }

    function unbind() {
        binding = null;
        streamBubbleId = null;
    }

    function hasMessage(messageId) {
        const chat = getContext().chat ?? [];
        return chat.some((message) => message?.extra?.stmpMessageId === messageId);
    }

    /**
     * 把一条时间线消息写入绑定聊天。push/渲染同步完成（保证事件顺序 =
     * 聊天顺序），落盘异步。已写过或绑定聊天未打开时返回 written: false。
     */
    function writeStoryMessage({ messageId, authorName, text, role }) {
        if (!isBoundChatOpen()) return { written: false, reason: 'chat_not_open' };
        if (hasMessage(messageId)) return { written: false, reason: 'duplicate' };

        const context = getContext();
        const message = {
            name: authorName,
            is_user: role === 'user',
            is_system: false,
            send_date: new Date().toLocaleString(),
            mes: text,
            extra: { stmpMessageId: messageId, stmpAuthor: authorName },
        };
        context.chat.push(message);
        context.addOneMessage(message);
        const saved = Promise.resolve(context.saveChat()).catch((error) => {
            console.error('[ST Multiplayer] 联机消息落盘失败：', error);
        });
        return { written: true, saved };
    }

    /**
     * 自己经原生输入框发出的消息：回声事件到达时按文本从尾部反查、补上
     * 同步标记，避免二次写入。找不到（比如已被编辑）返回 false。
     */
    function tagLocalMessage({ messageId, text }) {
        if (!isBoundChatOpen()) return false;
        if (hasMessage(messageId)) return true;
        const chat = getContext().chat ?? [];
        for (let i = chat.length - 1; i >= 0; i--) {
            const message = chat[i];
            if (!message?.is_user || message.is_system) continue;
            if (message.extra?.stmpMessageId) continue;
            if (String(message.mes ?? '').trim() !== text) continue;
            message.extra = { ...message.extra, stmpMessageId: messageId };
            return true;
        }
        return false;
    }

    /** 补写：把时间线里还没进聊天的消息按序写入；已在聊天里的按时间线文本修复（幂等）。 */
    function catchUp(timeline, { includeAssistant = false } = {}) {
        if (!isBoundChatOpen()) return 0;
        let written = 0;
        for (const entry of timeline) {
            if (entry.role !== 'user' && !(includeAssistant && entry.role === 'assistant')) continue;
            if (hasMessage(entry.messageId)) {
                applyRemoteUpdate({ messageId: entry.messageId, text: entry.text });
                continue;
            }
            const result = writeStoryMessage({
                messageId: entry.messageId,
                authorName: entry.authorName,
                text: entry.text,
                role: entry.role,
            });
            if (result.written) written += 1;
        }
        return written;
    }

    /** 当前绑定聊天里已同步消息的 ID 列表（删除检测的影子基线）。 */
    function listSyncedIds() {
        if (!isBoundChatOpen()) return [];
        const chat = getContext().chat ?? [];
        return chat.filter((m) => m?.extra?.stmpMessageId).map((m) => m.extra.stmpMessageId);
    }

    /** 应用远端编辑：按 ID 定位、覆盖文本并重绘该块。文本相同或找不到时 no-op。 */
    function applyRemoteUpdate({ messageId, text }) {
        if (!isBoundChatOpen()) return false;
        const context = getContext();
        const chat = context.chat ?? [];
        const index = chat.findIndex((m) => m?.extra?.stmpMessageId === messageId);
        if (index < 0) return false;
        if (chat[index].mes === text) return false;
        chat[index].mes = text;
        context.updateMessageBlock?.(index, chat[index]);
        void Promise.resolve(context.saveChat()).catch(() => { /* 尽力而为 */ });
        return true;
    }

    /** 应用远端删除：按 ID 定位、移除并整页重绘。找不到时 no-op。 */
    function applyRemoteDelete({ messageId }) {
        if (!isBoundChatOpen()) return false;
        const context = getContext();
        const chat = context.chat ?? [];
        const index = chat.findIndex((m) => m?.extra?.stmpMessageId === messageId);
        if (index < 0) return false;
        chat.splice(index, 1);
        try {
            context.clearChat?.();
            context.printMessages?.();
        } catch (error) {
            console.warn('[ST Multiplayer] 删除消息后的重绘失败：', error);
        }
        void Promise.resolve(context.saveChat()).catch(() => { /* 尽力而为 */ });
        return true;
    }

    /** 生成结束后捕获 baseline 之后的最新 AI 消息（消息定稿与事件之间有窗口，轮询兜底）。 */
    async function captureReplySince(baseline) {
        const deadline = Date.now() + REPLY_SETTLE_TIMEOUT_MS;
        for (;;) {
            const chat = getContext().chat ?? [];
            for (let i = chat.length - 1; i >= baseline; i--) {
                const message = chat[i];
                if (message && !message.is_user && !message.is_system && typeof message.mes === 'string' && message.mes.trim()) {
                    return { text: message.mes, name: message.name, message };
                }
            }
            if (Date.now() >= deadline) return null;
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
    }

    // ---------- 客机侧流式气泡：生成期间在镜像聊天里实时刷新的 AI 消息 ----------

    function findStreamBubble() {
        if (!streamBubbleId) return null;
        const chat = getContext().chat ?? [];
        const index = chat.findIndex((message) => message?.extra?.stmpStreamBubble === streamBubbleId);
        return index >= 0 ? { index, message: chat[index] } : null;
    }

    function hasStreamBubble() {
        return findStreamBubble() !== null;
    }

    function beginStreamBubble(name) {
        if (!isBoundChatOpen() || hasStreamBubble()) return false;
        const context = getContext();
        streamBubbleId = `bubble-${Date.now()}`;
        const message = {
            name,
            is_user: false,
            is_system: false,
            send_date: new Date().toLocaleString(),
            mes: '……',
            extra: { stmpStreamBubble: streamBubbleId },
        };
        context.chat.push(message);
        context.addOneMessage(message);
        return true;
    }

    function updateStreamBubble(text) {
        const bubble = findStreamBubble();
        if (!bubble) return false;
        bubble.message.mes = text;
        getContext().updateMessageBlock?.(bubble.index, bubble.message);
        return true;
    }

    /**
     * 权威消息到达 → 定稿；final 传 null → 生成失败，移除气泡。
     * 气泡若已不在末尾（生成期间有人插话），定稿时移到末尾——
     * 权威顺序里 assistant 排在本回合全部发言之后。
     */
    function endStreamBubble(final) {
        const bubble = findStreamBubble();
        streamBubbleId = null;
        if (!bubble) return false;
        const context = getContext();
        const isLast = bubble.index === context.chat.length - 1;
        if (final && isLast) {
            bubble.message.mes = final.text;
            if (final.name) bubble.message.name = final.name;
            bubble.message.extra = { stmpMessageId: final.messageId, stmpAuthor: final.name ?? bubble.message.name };
            context.updateMessageBlock?.(bubble.index, bubble.message);
        } else {
            context.chat.splice(bubble.index, 1);
            if (final) {
                bubble.message.mes = final.text;
                if (final.name) bubble.message.name = final.name;
                bubble.message.extra = { stmpMessageId: final.messageId, stmpAuthor: final.name ?? bubble.message.name };
                context.chat.push(bubble.message);
            }
            // 中段增删后整页重绘（clearChat + printMessages，均经 getContext 暴露）。
            try {
                context.clearChat?.();
                context.printMessages?.();
            } catch (error) {
                console.warn('[ST Multiplayer] 流式气泡整理后的重绘失败：', error);
            }
        }
        void Promise.resolve(context.saveChat()).catch(() => { /* 尽力而为 */ });
        return true;
    }

    return {
        missingApis,
        isBound,
        isBoundChatOpen,
        bindCurrentChat,
        unbind,
        get binding() { return binding ? { ...binding } : null; },
        hasMessage,
        writeStoryMessage,
        tagLocalMessage,
        catchUp,
        listSyncedIds,
        applyRemoteUpdate,
        applyRemoteDelete,
        captureReplySince,
        hasStreamBubble,
        beginStreamBubble,
        updateStreamBubble,
        endStreamBubble,
    };
}
