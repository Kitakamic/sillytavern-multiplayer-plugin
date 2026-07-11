/**
 * 房主桥接（P2，最脆弱层）：把共享时间线写进房主的真实聊天、触发生成、
 * 捕获流式与最终回复。铁律：只通过 SillyTavern.getContext() 访问酒馆能力，
 * 不 import 酒馆内部模块路径。
 *
 * 一致性模型：
 * - 房主的真实聊天是唯一真身；relay 事件按 seq 到达，user 消息由本模块写入；
 * - 每条写入的消息在 extra.stmpMessageId 打标，重放/重连/补写天然幂等；
 * - assistant 消息由生成流程产生（本来就在聊天里），永不经本模块写入。
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

const STREAM_THROTTLE_MS = 300;
const REPLY_SETTLE_TIMEOUT_MS = 3000;

export function createHostBridge(contextProvider) {
    const getContext = () => (typeof contextProvider === 'function' ? contextProvider() : contextProvider);

    let binding = null; // { chatId, characterAvatar, characterName }
    let generatingNow = false;

    function missingApis() {
        const context = getContext();
        if (!context) return ['getContext'];
        return REQUIRED_APIS.filter((name) => context[name] === undefined || context[name] === null);
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
    }

    function hasMessage(messageId) {
        const chat = getContext().chat ?? [];
        return chat.some((message) => message?.extra?.stmpMessageId === messageId);
    }

    /**
     * 把一条成员发言写入绑定聊天。push/渲染同步完成（保证事件顺序 = 聊天顺序），
     * 落盘异步。已写过（extra 标记）或绑定聊天未打开时返回 false。
     */
    function writeUserMessage({ messageId, authorName, text }) {
        if (!isBoundChatOpen()) return { written: false, reason: 'chat_not_open' };
        if (hasMessage(messageId)) return { written: false, reason: 'duplicate' };

        const context = getContext();
        const message = {
            name: authorName,
            is_user: true,
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

    /** 补写：把时间线里还没进聊天的 user 消息按序写入（幂等，生成前必调）。 */
    function catchUp(timeline) {
        if (!isBoundChatOpen()) return 0;
        let written = 0;
        for (const entry of timeline) {
            if (entry.role !== 'user') continue;
            const result = writeUserMessage({ messageId: entry.messageId, authorName: entry.authorName, text: entry.text });
            if (result.written) written += 1;
        }
        return written;
    }

    /**
     * 触发一次生成并捕获结果。onProgress(累计全文) 已按 STREAM_THROTTLE_MS 节流。
     * 返回 { text, name }；生成没有产出新的 AI 消息时返回 null。
     */
    async function generateReply({ onProgress } = {}) {
        if (!isBoundChatOpen()) throw new Error('绑定的聊天未打开，请切回后重试。');
        if (generatingNow) throw new Error('已有一次生成在进行中。');

        const context = getContext();
        const { eventSource, eventTypes } = context;
        const baseline = context.chat.length;

        generatingNow = true;
        let lastSent = 0;
        const onToken = (text) => {
            if (typeof text !== 'string' || !onProgress) return;
            const now = Date.now();
            if (now - lastSent < STREAM_THROTTLE_MS) return;
            lastSent = now;
            try {
                onProgress(text);
            } catch (error) {
                console.warn('[ST Multiplayer] 流式转发失败（忽略，继续生成）：', error);
            }
        };

        eventSource.on(eventTypes.STREAM_TOKEN_RECEIVED, onToken);
        try {
            await context.generate();
            // Generate 的 promise 结算与消息定稿之间存在窗口；轮询兜底。
            const reply = await waitForReply(baseline);
            return reply;
        } finally {
            eventSource.removeListener(eventTypes.STREAM_TOKEN_RECEIVED, onToken);
            generatingNow = false;
        }
    }

    async function waitForReply(baseline) {
        const deadline = Date.now() + REPLY_SETTLE_TIMEOUT_MS;
        for (;;) {
            const chat = getContext().chat ?? [];
            for (let i = chat.length - 1; i >= baseline; i--) {
                const message = chat[i];
                if (message && !message.is_user && !message.is_system && typeof message.mes === 'string' && message.mes.trim()) {
                    return { text: message.mes, name: message.name };
                }
            }
            if (Date.now() >= deadline) return null;
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
    }

    return {
        missingApis,
        isBound,
        isBoundChatOpen,
        bindCurrentChat,
        unbind,
        get binding() { return binding ? { ...binding } : null; },
        get generating() { return generatingNow; },
        hasMessage,
        writeUserMessage,
        catchUp,
        generateReply,
    };
}
