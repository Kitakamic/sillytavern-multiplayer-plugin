export class RoomStore extends EventTarget {
    #state = {
        room: null,
        members: [],
        transcript: [],
        lastAppliedSeq: 0,
    };

    get snapshot() {
        return structuredClone(this.#state);
    }

    applySnapshot(snapshot) {
        this.#state = {
            room: snapshot.room ?? null,
            members: snapshot.members ?? [],
            transcript: snapshot.transcript ?? [],
            lastAppliedSeq: snapshot.lastAppliedSeq ?? 0,
        };
        this.#notify();
    }

    applyEvent(event) {
        if (typeof event.seq === 'number' && event.seq <= this.#state.lastAppliedSeq) return;
        if (typeof event.seq === 'number') this.#state.lastAppliedSeq = event.seq;
        this.dispatchEvent(new CustomEvent('event', { detail: event }));
        this.#notify();
    }

    #notify() {
        this.dispatchEvent(new CustomEvent('change', { detail: this.snapshot }));
    }
}

