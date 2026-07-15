import { relayHttpOrigin, requireSession, responseError, sha256Hex } from './relay-http.js';

function assertCurrentImport(shouldContinue) {
    if (typeof shouldContinue === 'function' && !shouldContinue()) {
        const error = new Error('联机存档导入已过期。');
        error.code = 'STALE_IMPORT';
        throw error;
    }
}

/**
 * 联机存档共享模块。当前聊天的 jsonl 就是这局联机的存档：
 * 房主把它原样上传到中继（kind=chat），客机下载后写进镜像角色名下，
 * 玩到一半改天开新房也能接着玩。
 *
 * - saveKey：房主“这一份存档”的稳定标识（角色 avatar + 聊天文件名的哈希），
 *   客机据此把同一存档的历次快照覆盖写进同一个本地聊天文件；
 * - contentHash：jsonl 内容的 SHA-256，未变化时房主跳过上传、客机跳过导入。
 */
export class ChatSaveSharing {
    constructor(contextProvider, fetchImpl = globalThis.fetch.bind(globalThis)) {
        this.contextProvider = contextProvider;
        this.fetch = fetchImpl;
    }

    /**
     * 读取当前聊天的 jsonl 原文并上传。skipIfHash 命中（内容与已共享
     * 版本一致）时不上传，返回 { unchanged: true }。
     */
    async shareCurrentSave({ relayUrl, roomId, credentials, skipIfHash = null }) {
        const context = this.#context();
        if (context.groupId) throw new Error('群组聊天暂不支持共享联机存档。');
        const character = context.characters?.[context.characterId];
        if (!character?.avatar) throw new Error('请先打开要共享的角色聊天。');
        const chatId = context.chatId;
        if (typeof chatId !== 'string' || !chatId) throw new Error('当前没有打开的聊天。');

        // 先落盘再读文件，保证存档与屏幕上的内容一致。
        await context.saveChat();
        const fetched = await this.fetch('/api/chats/get', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ ch_name: character.name, file_name: chatId, avatar_url: character.avatar }),
        });
        if (!fetched.ok) throw await responseError(fetched, '读取当前聊天存档失败。');
        const lines = await fetched.json();
        if (!Array.isArray(lines) || lines.length < 1) throw new Error('当前聊天存档为空或无法读取。');

        const jsonl = lines.map((line) => JSON.stringify(line)).join('\n');
        const bytes = new TextEncoder().encode(jsonl);
        const contentHash = await sha256Hex(bytes);
        const saveKey = (await sha256Hex(`${character.avatar}:${chatId}`))?.slice(0, 16) ?? null;
        if (skipIfHash && contentHash && skipIfHash === contentHash) {
            return { unchanged: true, chatName: chatId, contentHash };
        }

        const upload = await this.fetch(`${relayHttpOrigin(relayUrl)}/rooms/${encodeURIComponent(roomId)}/assets?kind=chat`, {
            method: 'POST',
            headers: { ...requireSession(credentials), 'content-type': 'application/jsonl' },
            body: new Blob([bytes], { type: 'application/jsonl' }),
        });
        if (!upload.ok) throw await responseError(upload, '上传联机存档失败。');
        const result = await upload.json();
        return {
            assetId: result.assetId,
            chatName: chatId,
            messageCount: lines.length - 1,
            bytes: result.bytes,
            expiresAt: result.expiresAt,
            ...(saveKey ? { saveKey } : {}),
            ...(contentHash ? { contentHash } : {}),
        };
    }

    /**
     * 下载共享存档并写入 targetAvatar 角色名下的 fileName 聊天
     * （覆盖写入，force 跳过完整性检查——快照来自另一台机器）。
     * 若客机当前正打开该角色，则顺便切到这份存档。
     */
    async importSharedSave({ relayUrl, roomId, assetId, credentials, targetAvatar, fileName, shouldContinue = null }) {
        const context = this.#context();
        const download = await this.fetch(`${relayHttpOrigin(relayUrl)}/rooms/${encodeURIComponent(roomId)}/assets/${encodeURIComponent(assetId)}`, {
            headers: requireSession(credentials),
            cache: 'no-store',
        });
        if (!download.ok) throw await responseError(download, '下载联机存档失败。');

        const text = await download.text();
        const lines = [];
        for (const raw of text.split('\n')) {
            if (!raw.trim()) continue;
            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch {
                throw new Error('联机存档内容无效（不是合法的 jsonl）。');
            }
            lines.push(parsed);
        }
        if (!lines.length) throw new Error('联机存档为空。');
        // 完整性签名属于房主的原文件；留着会让客机后续保存报 integrity 冲突。
        if (lines[0]?.chat_metadata?.integrity) delete lines[0].chat_metadata.integrity;

        assertCurrentImport(shouldContinue);
        const saved = await this.fetch('/api/chats/save', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({
                ch_name: targetAvatar.replace(/\.png$/, ''),
                file_name: fileName,
                avatar_url: targetAvatar,
                chat: lines,
                force: true,
            }),
        });
        if (!saved.ok) throw await responseError(saved, '写入联机存档失败。');

        // 客机正停在镜像角色上时直接打开这份存档，做到“下载即可继续看”。
        const current = context.characters?.[context.characterId];
        let opened = false;
        if (current?.avatar === targetAvatar && typeof context.openCharacterChat === 'function') {
            try {
                assertCurrentImport(shouldContinue);
                await context.openCharacterChat(fileName);
                opened = true;
            } catch (error) {
                console.warn('[ST Multiplayer] 打开联机存档失败（已写入磁盘）：', error);
            }
        }
        return { fileName, messageCount: lines.length - 1, opened };
    }

    #context() {
        return typeof this.contextProvider === 'function' ? this.contextProvider() : this.contextProvider;
    }
}
