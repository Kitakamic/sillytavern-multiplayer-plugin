export const PROTOCOL_VERSION = 1;

export const CommandType = Object.freeze({
    AUTH_HELLO: 'auth.hello',
    ROOM_CREATE: 'room.create',
    ROOM_JOIN: 'room.join',
    ROOM_RESUME: 'room.resume',
    PROPOSAL_SUBMIT: 'proposal.submit',
    PROPOSAL_WITHDRAW: 'proposal.withdraw',
    STORY_MESSAGE_PUBLISH: 'story.message.publish',
    GENERATION_START: 'generation.start',
    GENERATION_PROGRESS: 'generation.progress',
    GENERATION_FINISH: 'generation.finish',
});

export function createCommand(type, payload = {}) {
    return {
        v: PROTOCOL_VERSION,
        kind: 'cmd',
        type,
        requestId: crypto.randomUUID(),
        opId: crypto.randomUUID(),
        payload,
    };
}

