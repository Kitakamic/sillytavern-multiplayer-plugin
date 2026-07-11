export function createHostBridge(context) {
    return {
        getBinding() {
            return {
                chatId: context.chatId,
                characterId: context.characterId,
                groupId: context.groupId,
                messageCount: context.chat.length,
            };
        },

        async publishAcceptedAction() {
            throw new Error('Host chat publishing is not implemented yet.');
        },

        async generateReply() {
            throw new Error('Host generation is not implemented yet.');
        },
    };
}

