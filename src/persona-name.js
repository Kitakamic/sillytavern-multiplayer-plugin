function relaySafePersonaName(value) {
    const name = String(value ?? '').trim();
    if (!name) return '玩家';
    return name.slice(0, 50).replace(/[\uD800-\uDBFF]$/, '');
}

/** Read the current SillyTavern Persona name without caching a stale context snapshot. */
export function getCurrentPersonaName(contextProvider) {
    return relaySafePersonaName(contextProvider?.()?.name1);
}

/** Preserve the Persona SillyTavern captured on a sent message, even if the user switches later. */
export function getMessagePersonaName(message, contextProvider) {
    const sentName = String(message?.name ?? '').trim();
    return sentName ? relaySafePersonaName(sentName) : getCurrentPersonaName(contextProvider);
}
