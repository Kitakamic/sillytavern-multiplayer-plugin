import { relayHttpOrigin, requireSession, responseError, sha256Hex } from './relay-http.js';

function assertCurrentImport(shouldContinue) {
    if (typeof shouldContinue === 'function' && !shouldContinue()) {
        const error = new Error('共享角色卡导入已过期。');
        error.code = 'STALE_IMPORT';
        throw error;
    }
}

/**
 * 完整角色卡共享模块。UI 只需要知道“共享当前卡”和“导入共享卡”；
 * SillyTavern 导出/导入表单、Relay HTTP 地址和房间凭据都封装在这里。
 *
 * 去重（问题：跨房间同一张卡在客机攒副本）：
 * - contentHash：导出 PNG 的 SHA-256，内容未变时房主跳过上传、客机跳过导入；
 * - cardKey：房主“这一张卡”的稳定标识（clientId + 本地 avatar 文件名的哈希），
 *   客机据此把同一张卡的历次更新覆盖写进同一个本地角色文件，聊天记录不丢。
 */
export class CharacterCardSharing {
    constructor(contextProvider, fetchImpl = globalThis.fetch.bind(globalThis)) {
        this.contextProvider = contextProvider;
        this.fetch = fetchImpl;
    }

    /**
     * 导出并上传当前角色卡。skipIfHash 命中（内容与已共享版本一致）时
     * 不上传，返回 { unchanged: true }。
     */
    async shareCurrentCard({ relayUrl, roomId, credentials, skipIfHash = null }) {
        const context = this.#context();
        const character = this.#currentCharacter();
        const exported = await this.fetch('/api/characters/export', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ format: 'png', avatar_url: character.avatar }),
        });
        if (!exported.ok) throw await responseError(exported, '导出当前角色卡失败。');

        const bytes = await exported.arrayBuffer();
        const contentHash = await sha256Hex(bytes);
        const cardKey = (await sha256Hex(`${credentials?.clientId ?? ''}:${character.avatar}`))?.slice(0, 16) ?? null;
        if (skipIfHash && contentHash && skipIfHash === contentHash) {
            return { unchanged: true, characterName: character.name, contentHash };
        }

        const card = new Blob([bytes], { type: 'image/png' });
        const upload = await this.fetch(`${relayHttpOrigin(relayUrl)}/rooms/${encodeURIComponent(roomId)}/assets?kind=card`, {
            method: 'POST',
            headers: { ...requireSession(credentials), 'content-type': 'image/png' },
            body: card,
        });
        if (!upload.ok) throw await responseError(upload, '上传完整角色卡失败。');
        const result = await upload.json();
        return {
            assetId: result.assetId,
            characterName: character.name,
            bytes: result.bytes,
            expiresAt: result.expiresAt,
            ...(cardKey ? { cardKey } : {}),
            ...(contentHash ? { contentHash } : {}),
        };
    }

    /**
     * 下载并导入共享卡。preservedName（不带 .png）由调用方决定：
     * 复用旧文件名即为覆盖更新，聊天记录保留。
     */
    async importSharedCard({ relayUrl, roomId, assetId, credentials, preservedName, shouldContinue = null }) {
        const context = this.#context();
        const download = await this.fetch(`${relayHttpOrigin(relayUrl)}/rooms/${encodeURIComponent(roomId)}/assets/${encodeURIComponent(assetId)}`, {
            headers: requireSession(credentials),
            cache: 'no-store',
        });
        if (!download.ok) throw await responseError(download, '下载完整角色卡失败。');

        const card = new Blob([await download.arrayBuffer()], { type: 'image/png' });
        assertCurrentImport(shouldContinue);
        const form = new FormData();
        form.append('avatar', card, `${preservedName}.png`);
        form.append('file_type', 'png');
        form.append('user_name', context.name1 ?? 'You');
        form.append('preserved_name', preservedName);

        const imported = await this.fetch('/api/characters/import', {
            method: 'POST',
            headers: context.getRequestHeaders({ omitContentType: true }),
            body: form,
            cache: 'no-cache',
        });
        if (!imported.ok) throw await responseError(imported, '导入完整角色卡失败。');
        const result = await imported.json();
        if (result.error || typeof result.file_name !== 'string') throw new Error('角色卡内容无效，导入失败。');

        assertCurrentImport(shouldContinue);
        await context.getCharacters();
        const avatarFileName = `${result.file_name}.png`;
        const characterId = context.characters.findIndex((character) => character.avatar === avatarFileName);
        if (characterId < 0) throw new Error('角色卡已导入，但未能在角色列表中找到。');
        assertCurrentImport(shouldContinue);
        await context.selectCharacterById(characterId);
        return { avatarFileName, characterId };
    }

    /** 本地是否已有该 avatar 文件名的角色（去重复用前的存在性检查）。 */
    hasCharacter(avatarFileName) {
        const context = this.#context();
        return (context.characters ?? []).some((character) => character.avatar === avatarFileName);
    }

    /** 选中指定 avatar 文件名的角色；不存在时返回 false。 */
    async selectByAvatar(avatarFileName, shouldContinue = null) {
        const context = this.#context();
        const characterId = (context.characters ?? []).findIndex((character) => character.avatar === avatarFileName);
        if (characterId < 0) return false;
        assertCurrentImport(shouldContinue);
        await context.selectCharacterById(characterId);
        return true;
    }

    #currentCharacter() {
        const context = this.#context();
        if (context.groupId) throw new Error('群组聊天暂不支持共享完整角色卡。');
        const character = context.characters?.[context.characterId];
        if (!character?.avatar || !character?.name) throw new Error('请先打开要共享的角色卡。');
        return character;
    }

    #context() {
        return typeof this.contextProvider === 'function' ? this.contextProvider() : this.contextProvider;
    }
}
