/**
 * Continue a worker on public dsh APIs. dsh resumes a settled child only
 * through `sendMessage`, which returns a message id and tells the parent model
 * when the turn ends. The continue phase instead starts a new worker session
 * seeded with the leader worker's completed turns: the same history, observed
 * like any other activation.
 *
 * The seed is the `prepareContinuable` contribution of the
 * `auto-research-continue` provider, the way dsh's fork provider seeds a child
 * with its parent's turns.
 */
export const CONTINUE_PROVIDER = 'auto-research-continue';
export class ContinueProvider {
    query;
    name = CONTINUE_PROVIDER;
    capabilities = { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true };
    inheritsParentContext = false;
    /** Seeds by reserved child session id, until that child is created. */
    seeds = new Map();
    constructor(query) {
        this.query = query;
    }
    /**
     * Read `session` up to its last completed turn as the seed of the child
     * `childId`. Returns the function that drops the seed once the child exists.
     */
    async prepare(childId, session, signal) {
        const query = this.query();
        if (!query)
            throw new Error('continuing a worker needs the sessionQuery service');
        const observation = await query.observeSession(session, { signal });
        try {
            // Event seqs equal array indexes, so the prefix stays contiguous from seq 0.
            const end = observation.events.findLastIndex(event => event.type === 'turn/end');
            if (end < 0)
                throw new Error(`session ${session} has no completed turn`);
            this.seeds.set(childId, observation.events.slice(0, end + 1).map(event => structuredClone(event)));
        }
        finally {
            observation[Symbol.dispose]();
        }
        return () => { this.seeds.delete(childId); };
    }
    async prepareContinuable(request) {
        const seed = this.seeds.get(request.sessionId);
        return seed ? { seed } : {};
    }
}
//# sourceMappingURL=continuation.js.map