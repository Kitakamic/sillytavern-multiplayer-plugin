/**
 * Protects RoomStore from the interval between sending room.resume and applying
 * its acknowledgement.  The relay can fan out a live event before the resume
 * ack reaches this client; applying that event immediately would make
 * RoomStore see a sequence gap and permanently discard it.
 *
 * Persisted room events are deduplicated by room + seq and drained strictly in
 * sequence order.  Transient events (generation/round signals) have no seq, so
 * they retain their arrival order and are released after the persisted stream
 * has caught up.
 */
export class ResumeEventBarrier {
    #store;
    #applySnapshot;
    #active = false;
    #sequenced = new Map();
    #transient = [];

    constructor({ store, applySnapshot }) {
        if (!store || typeof store.applyEvent !== 'function') {
            throw new TypeError('ResumeEventBarrier requires a RoomStore-like store.');
        }
        if (typeof applySnapshot !== 'function') {
            throw new TypeError('ResumeEventBarrier requires an applySnapshot callback.');
        }
        this.#store = store;
        this.#applySnapshot = applySnapshot;
    }

    get active() {
        return this.#active;
    }

    /** Start (or retain) one buffering window.  Repeated calls intentionally keep queued events. */
    begin() {
        this.#active = true;
    }

    /**
     * Routes a relay event.  While a resume is in flight events are buffered;
     * otherwise they are applied immediately just as the old direct wiring did.
     */
    route(event) {
        if (!event || typeof event !== 'object') return { applied: false, closed: false };

        if (!this.#active) {
            const applied = this.#store.applyEvent(event);
            return { applied, closed: !this.#store.inRoom };
        }

        if (Number.isInteger(event.seq)) {
            // A sequence number is only unique within a room.  Keeping the room
            // in the key also makes a stale event harmless while switching rooms.
            this.#sequenced.set(this.#sequenceKey(event.roomId, event.seq), event);
        } else {
            this.#transient.push(event);
        }
        return { applied: false, closed: false };
    }

    /**
     * Applies one room.resume acknowledgement.  A caller keeps the barrier
     * active and requests another resume when needsFollowUp is true.
     */
    commit(payload = {}, roomHint = null) {
        const roomId = payload.roomId ?? roomHint?.roomId;
        if (typeof roomId !== 'string' || !roomId) {
            this.clear();
            return { needsFollowUp: false, closed: true };
        }

        this.#applySnapshot(payload, roomHint);
        if (!this.#store.inRoom) {
            this.clear();
            return { needsFollowUp: false, closed: true };
        }

        // Events supplied by the acknowledgement and events observed live share
        // the same sequence namespace.  Map insertion naturally de-duplicates
        // the common "live event arrives before its replay" case.
        for (const event of payload.events ?? []) {
            if (!event || !Number.isInteger(event.seq)) continue;
            this.#sequenced.set(this.#sequenceKey(event.roomId, event.seq), event);
        }

        this.#discardOtherRooms(roomId);
        this.#discardStale(roomId);

        const drained = this.#drainSequenced(roomId);
        if (drained.closed) return { needsFollowUp: false, closed: true };

        const ackLastSeq = Number.isInteger(payload.lastSeq)
            ? payload.lastSeq
            : this.#highestSequence(roomId);
        const hasFutureSequence = this.#hasFutureSequence(roomId);
        const caughtUpToAck = this.#store.lastAppliedSeq >= ackLastSeq;

        // Do not let a stream/round transient overtake a persisted gap.  Once
        // the next resume fills that gap, these are replayed FIFO exactly once.
        if (caughtUpToAck && !hasFutureSequence) {
            const transient = this.#drainTransient(roomId);
            if (transient.closed) return { needsFollowUp: false, closed: true };
        }

        return {
            needsFollowUp: !caughtUpToAck || this.#hasFutureSequence(roomId),
            closed: false,
        };
    }

    /** Finish a successful buffering window. */
    end() {
        this.clear();
    }

    /** Abort a window after leaving, being kicked, closing, or a failed resume. */
    clear() {
        this.#active = false;
        this.#sequenced.clear();
        this.#transient.length = 0;
    }

    #sequenceKey(roomId, seq) {
        return `${roomId ?? ''}:${seq}`;
    }

    #discardOtherRooms(roomId) {
        for (const [key, event] of this.#sequenced) {
            if (event.roomId !== roomId) this.#sequenced.delete(key);
        }
        this.#transient = this.#transient.filter((event) => event.roomId === roomId);
    }

    #discardStale(roomId) {
        for (const [key, event] of this.#sequenced) {
            if (event.roomId === roomId && event.seq <= this.#store.lastAppliedSeq) this.#sequenced.delete(key);
        }
    }

    #drainSequenced(roomId) {
        while (this.#store.inRoom) {
            const expected = this.#store.lastAppliedSeq + 1;
            const key = this.#sequenceKey(roomId, expected);
            const event = this.#sequenced.get(key);
            if (!event) break;
            this.#sequenced.delete(key);

            // This should only return false if a foreign/malformed event slipped
            // through.  Put it back and request another authoritative replay.
            if (!this.#store.applyEvent(event)) {
                this.#sequenced.set(key, event);
                break;
            }
        }

        if (!this.#store.inRoom) {
            this.clear();
            return { closed: true };
        }
        return { closed: false };
    }

    #drainTransient(roomId) {
        const pending = this.#transient;
        this.#transient = [];
        for (const event of pending) {
            if (event.roomId !== roomId) continue;
            this.#store.applyEvent(event);
            if (!this.#store.inRoom) {
                this.clear();
                return { closed: true };
            }
        }
        return { closed: false };
    }

    #hasFutureSequence(roomId) {
        for (const event of this.#sequenced.values()) {
            if (event.roomId === roomId && event.seq > this.#store.lastAppliedSeq) return true;
        }
        return false;
    }

    #highestSequence(roomId) {
        let highest = this.#store.lastAppliedSeq;
        for (const event of this.#sequenced.values()) {
            if (event.roomId === roomId) highest = Math.max(highest, event.seq);
        }
        return highest;
    }
}
