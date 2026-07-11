function relayHttpOrigin(relayUrl) {
    const url = new URL(relayUrl);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    else if (url.protocol === 'wss:') url.protocol = 'https:';
    else throw new Error('中继地址必须是 ws:// 或 wss://。');
    return url.origin;
}

function requireSession({ clientId, sessionToken } = {}) {
    if (!clientId || !sessionToken) throw new Error('缺少房间会话凭据，请重新连接。');
    return {
        'x-relay-client-id': clientId,
        'x-relay-session-token': sessionToken,
    };
}

async function responseError(response, fallback) {
    try {
        const body = await response.json();
        const error = new Error(body.error || fallback);
        if (body.code) error.code = body.code;
        return error;
    } catch {
        return new Error(`${fallback}（HTTP ${response.status}）`);
    }
}

/**
 * 完整角色卡共享模块。UI 只需要知道“共享当前卡”和“导入共享卡”；
 * SillyTavern 导出/导入表单、Relay HTTP 地址和房间凭据都封装在这里。
 */
export class CharacterCardSharing {
    constructor(contextProvider, fetchImpl = globalThis.fetch.bind(globalThis)) {
        this.contextProvider = contextProvider;
        this.fetch = fetchImpl;
    }

    async shareCurrentCard({ relayUrl, roomId, credentials }) {
        const context = this.#context();
        const character = this.#currentCharacter();
        const exported = await this.fetch('/api/characters/export', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ format: 'png', avatar_url: character.avatar }),
        });
        if (!exported.ok) throw await responseError(exported, '导出当前角色卡失败。');

        const card = new Blob([await exported.arrayBuffer()], { type: 'image/png' });
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
        };
    }

    async importSharedCard({ relayUrl, roomId, assetId, credentials }) {
        const context = this.#context();
        const download = await this.fetch(`${relayHttpOrigin(relayUrl)}/rooms/${encodeURIComponent(roomId)}/assets/${encodeURIComponent(assetId)}`, {
            headers: requireSession(credentials),
            cache: 'no-store',
        });
        if (!download.ok) throw await responseError(download, '下载完整角色卡失败。');

        const card = new Blob([await download.arrayBuffer()], { type: 'image/png' });
        const preservedName = `stmp_${String(roomId).replace(/[^A-Za-z0-9_-]/g, '_')}`;
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

        await context.getCharacters();
        const avatarFileName = `${result.file_name}.png`;
        const characterId = context.characters.findIndex((character) => character.avatar === avatarFileName);
        if (characterId < 0) throw new Error('角色卡已导入，但未能在角色列表中找到。');
        await context.selectCharacterById(characterId);
        return { avatarFileName, characterId };
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
